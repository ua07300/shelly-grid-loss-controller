// master.mjs — grid-state detector (Input AND Voltage) plus command
// dispatch to up to 3 Slaves. All settings live in code, no KVS.
// Convention: the Slave script on the target device has id=1, port 80.

// ===== USER SETTINGS =====
// List of Slave devices (IP). Order = turn-on queue on recovery.
// Maximum 3. The first one is turned on first.
let TARGETS = [
  "192.168.1.20"
  // "192.168.1.21",
  // "192.168.1.22"
];

// Voltage thresholds
let V_LOW_OFF = 190;           // lower turn-off limit
let V_LOW_ON = 200;            // lower turn-on limit
let V_HIGH_OFF = 260;          // upper turn-off limit
let V_HIGH_ON = 250;           // upper turn-on limit
let V_STABLE_SEC = 60;         // stability inside the narrow band before "good"

// Timings
let POLL_MS = 1000;            // detector polling interval
let DEBOUNCE_OFF_SEC = 5;      // confirmation of grid loss
let DEBOUNCE_ON_SEC = 60;      // confirmation of grid return
let ACK_TIMEOUT_SEC = 5;       // HTTP request timeout to a Slave
let RETRIES = 2;               // retries when no ACK is received
let ON_GAP_SEC = 30;           // pause between sequential turn-on of Slaves
// ====================================

let SCHEMA = "master-slave-v1";
let SLAVE_SCRIPT_ID = 1;
let SLAVE_PORT = 80;

let state = {
  gridPresent: null,
  pendingDecision: null,
  pendingTimer: null,
  pollTimer: null,
  pending: {},
  voltageSource: null,
  voltageState: {
    current: null,             // null | "good" | "bad" | "recovering"
    recoveryStartTs: 0
  }
};

// ===== DETECTORS =====

function inputPresent() {
  let inp = Shelly.getComponentStatus("input", 0);
  if (inp === null) return null;
  return !!inp.state;
}

function detectVoltageSource() {
  let em = Shelly.getComponentStatus("em", 0);
  if (em !== null && (em.a_voltage !== undefined ||
                      em.b_voltage !== undefined ||
                      em.c_voltage !== undefined)) {
    return { type: "em" };
  }
  let em1_0 = Shelly.getComponentStatus("em1", 0);
  if (em1_0 !== null && em1_0.voltage !== undefined) {
    return { type: "em1" };
  }
  let sw = Shelly.getComponentStatus("switch", 0);
  if (sw !== null && sw.voltage !== undefined) {
    return { type: "switch" };
  }
  return null;
}

function readVoltages() {
  if (state.voltageSource === null) return null;
  let t = state.voltageSource.type;
  let v = [];
  if (t === "em") {
    let em = Shelly.getComponentStatus("em", 0);
    if (em === null) return null;
    if (em.a_voltage !== null && em.a_voltage !== undefined) v.push(em.a_voltage);
    if (em.b_voltage !== null && em.b_voltage !== undefined) v.push(em.b_voltage);
    if (em.c_voltage !== null && em.c_voltage !== undefined) v.push(em.c_voltage);
  } else if (t === "em1") {
    let s0 = Shelly.getComponentStatus("em1", 0);
    if (s0 !== null && s0.voltage !== null && s0.voltage !== undefined) v.push(s0.voltage);
    let s1 = Shelly.getComponentStatus("em1", 1);
    if (s1 !== null && s1.voltage !== null && s1.voltage !== undefined) v.push(s1.voltage);
  } else if (t === "switch") {
    let sw = Shelly.getComponentStatus("switch", 0);
    if (sw !== null && sw.voltage !== null && sw.voltage !== undefined) v.push(sw.voltage);
  }
  return v.length > 0 ? v : null;
}

function voltagePresent() {
  let voltages = readVoltages();
  if (voltages === null) return null;

  let inWideOk = true;
  let inNarrowOk = true;
  for (let i = 0; i < voltages.length; i++) {
    let vv = voltages[i];
    if (vv < V_LOW_OFF || vv > V_HIGH_OFF) inWideOk = false;
    if (vv < V_LOW_ON || vv > V_HIGH_ON) inNarrowOk = false;
  }

  let nowTs = Math.floor(Date.now() / 1000);
  let vs = state.voltageState;

  if (vs.current === null) {
    vs.current = inWideOk ? "good" : "bad";
    logEvent("ms_voltage_init", { state: vs.current, voltages: voltages });
  }

  if (vs.current === "good") {
    if (!inWideOk) {
      vs.current = "bad";
      logEvent("ms_voltage_bad", { voltages: voltages });
    }
  } else if (vs.current === "bad") {
    if (inNarrowOk) {
      vs.current = "recovering";
      vs.recoveryStartTs = nowTs;
      logEvent("ms_voltage_recovering", { voltages: voltages });
    }
  } else if (vs.current === "recovering") {
    if (!inNarrowOk) {
      vs.current = "bad";
      logEvent("ms_voltage_bad_again", { voltages: voltages });
    } else if (nowTs - vs.recoveryStartTs >= V_STABLE_SEC) {
      vs.current = "good";
      logEvent("ms_voltage_good", { voltages: voltages });
    }
  }

  return vs.current === "good";
}

function detectGridState() {
  let i = inputPresent();
  let v = voltagePresent();
  if (i === null && v === null) return { present: null };
  if (i === null) return { present: v };
  if (v === null) return { present: i };
  return { present: i && v };
}

// ===== UTILITIES =====

function logEvent(name, data) {
  Shelly.emitEvent(name, data);
  print(name, JSON.stringify(data));
}

function getOwnIp() {
  let w = Shelly.getComponentStatus("wifi");
  if (w && w.sta_ip) return w.sta_ip;
  let e = Shelly.getComponentStatus("eth");
  if (e && e.ip) return e.ip;
  return "127.0.0.1";
}

function genCmdId() {
  return "c" + Math.floor(Math.random() * 0xffffffff).toString(16) +
         "-" + Math.floor(Date.now() / 1000).toString(16);
}

function buildPayload(gridPresent) {
  return {
    cmd_id: genCmdId(),
    schema: SCHEMA,
    grid_present: gridPresent,
    ts: Math.floor(Date.now() / 1000),
    ack_url: "http://" + getOwnIp() + "/script/" + Script.id + "/ack"
  };
}

// ===== COMMAND DISPATCH =====

function sendToTarget(tgtIdx, payload) {
  if (tgtIdx >= TARGETS.length) return;
  let ip = TARGETS[tgtIdx];
  let url = "http://" + ip + ":" + SLAVE_PORT +
            "/script/" + SLAVE_SCRIPT_ID + "/cmd";

  let p = state.pending[payload.cmd_id];
  if (!p) {
    state.pending[payload.cmd_id] = {
      tgtIdx: tgtIdx, retries: 0, watchdog: null, payload: payload
    };
    p = state.pending[payload.cmd_id];
  }
  if (p.watchdog) Timer.clear(p.watchdog);
  let wdMs = (ACK_TIMEOUT_SEC + 2) * 1000;
  p.watchdog = Timer.set(wdMs, false, onWatchdog, payload.cmd_id);

  Shelly.call("HTTP.POST", {
    url: url,
    body: JSON.stringify(payload),
    timeout: ACK_TIMEOUT_SEC,
    content_type: "application/json"
  }, onCmdSent, payload.cmd_id);
}

function onCmdSent(res, err, errMsg, cmdId) {
  let p = state.pending[cmdId];
  if (!p) return;
  if (err !== 0) {
    logEvent("ms_send_err", { cmd_id: cmdId, err: err, msg: errMsg });
  }
}

function onWatchdog(cmdId) {
  let p = state.pending[cmdId];
  if (!p) return;
  if (p.retries < RETRIES) {
    p.retries += 1;
    logEvent("ms_retry", { cmd_id: cmdId, retry: p.retries });
    sendToTarget(p.tgtIdx, p.payload);
  } else {
    logEvent("ms_failed", {
      cmd_id: cmdId,
      target: TARGETS[p.tgtIdx],
      payload: p.payload
    });
    clearPending(cmdId);
  }
}

function clearPending(cmdId) {
  let p = state.pending[cmdId];
  if (!p) return;
  if (p.watchdog) Timer.clear(p.watchdog);
  delete state.pending[cmdId];
}

function broadcastDecision(gridPresent) {
  logEvent("ms_decision", { grid_present: gridPresent });
  if (gridPresent === false) {
    for (let i = 0; i < TARGETS.length; i++) {
      let payload = buildPayload(false);
      sendToTarget(i, payload);
    }
  } else {
    for (let i = 0; i < TARGETS.length; i++) {
      let delayMs = i * ON_GAP_SEC * 1000;
      Timer.set(delayMs, false, function (idx) {
        let payload = buildPayload(true);
        sendToTarget(idx, payload);
      }, i);
    }
  }
}

// ===== MAIN LOOP =====

function evaluate() {
  let res = detectGridState();
  if (res.present === null) return;

  if (state.gridPresent === res.present) {
    if (state.pendingDecision !== null) {
      state.pendingDecision = null;
      if (state.pendingTimer) {
        Timer.clear(state.pendingTimer);
        state.pendingTimer = null;
      }
    }
    return;
  }

  if (state.pendingDecision !== res.present) {
    state.pendingDecision = res.present;
    if (state.pendingTimer) Timer.clear(state.pendingTimer);
    let debounceSec = res.present ? DEBOUNCE_ON_SEC : DEBOUNCE_OFF_SEC;
    state.pendingTimer = Timer.set(debounceSec * 1000, false,
                                   commitDecision, res.present);
  }
}

function commitDecision(newState) {
  state.pendingTimer = null;
  state.pendingDecision = null;
  state.gridPresent = newState;
  broadcastDecision(newState);
}

// ===== HTTP ENDPOINT =====

HTTPServer.registerEndpoint("ack", function (request, response) {
  if (request.method !== "POST") {
    response.code = 405; response.send(); return;
  }
  let ack;
  try { ack = JSON.parse(request.body); }
  catch (e) {
    response.code = 400;
    response.body = JSON.stringify({ error: "bad json" });
    response.send();
    return;
  }
  if (ack && ack.cmd_id && ack.ack === "EXECUTED") {
    logEvent("ms_executed", ack);
    clearPending(ack.cmd_id);
  }
  response.code = 200;
  response.body = JSON.stringify({ ok: true });
  response.headers = [["Content-Type", "application/json"]];
  response.send();
});

// ===== START =====

state.voltageSource = detectVoltageSource();
logEvent("ms_voltage_source", {
  source: state.voltageSource === null ? "none" : state.voltageSource.type
});

state.pollTimer = Timer.set(POLL_MS, true, evaluate);
logEvent("ms_started", { schema: SCHEMA, n_targets: TARGETS.length });
