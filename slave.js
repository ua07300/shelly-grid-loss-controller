// slave.mjs — receives master commands, executes immediately, returns ACK.
// All settings live in code. The script must have id=1.

// ===== USER SETTINGS =====
// SW_ID — relay channel index (for single-relay devices = 0).
// DEADMAN_SEC — failsafe: "if the master goes silent, turn off after N sec".
//   0 = disabled (stay on indefinitely).
//   >0 = after turning on, automatically turn off after this many seconds
//        if no new command arrives from the master.
let SW_ID = 0;
let DEADMAN_SEC = 0;
// ====================================

let SCHEMA = "master-slave-v1";

let state = {
  lastCmdId: null,
  lastResult: null
};

function sendAck(ackUrl, payload) {
  Shelly.call("HTTP.POST", {
    url: ackUrl,
    body: JSON.stringify(payload),
    timeout: 4,
    content_type: "application/json"
  }, function (res, err, errMsg) {
    if (err !== 0) print("ack send failed:", errMsg);
  });
}

function apply(cmd, replySync) {
  replySync({ cmd_id: cmd.cmd_id, ack: "RECEIVED", schema: SCHEMA });

  let params = { id: SW_ID, on: !!cmd.grid_present };
  params.tag = cmd.grid_present ? "ms_on" : "ms_off";
  if (cmd.grid_present && DEADMAN_SEC > 0) {
    params.toggle_after = DEADMAN_SEC;
  }

  Shelly.call("Switch.Set", params, function (res, err, errMsg) {
    let st = Shelly.getComponentStatus("switch", SW_ID);
    let p = {
      cmd_id: cmd.cmd_id, ack: "EXECUTED",
      schema: SCHEMA,
      ok: err === 0,
      err_code: err, err_msg: errMsg || null,
      actual_on: st ? !!st.output : null,
      ts: Math.floor(Date.now() / 1000)
    };
    state.lastCmdId = cmd.cmd_id;
    state.lastResult = p;
    sendAck(cmd.ack_url, p);
  });
}

HTTPServer.registerEndpoint("cmd", function (request, response) {
  if (request.method !== "POST") {
    response.code = 405; response.send(); return;
  }
  let cmd;
  try { cmd = JSON.parse(request.body); }
  catch (e) {
    response.code = 400;
    response.body = JSON.stringify({ error: "bad json", schema: SCHEMA });
    response.send();
    return;
  }

  if (!cmd.schema || cmd.schema !== SCHEMA) {
    response.code = 400;
    response.body = JSON.stringify({
      error: "unsupported schema",
      supports: SCHEMA, got: cmd.schema || null
    });
    response.send();
    return;
  }

  if (!cmd.cmd_id || typeof cmd.grid_present !== "boolean" || !cmd.ack_url) {
    response.code = 400;
    response.body = JSON.stringify({ error: "missing fields" });
    response.send();
    return;
  }

  // Idempotency — a repeated command returns the cached result
  if (state.lastCmdId === cmd.cmd_id) {
    response.code = 200;
    response.body = JSON.stringify({
      cmd_id: cmd.cmd_id, ack: "DUPLICATE",
      cached: state.lastResult, schema: SCHEMA
    });
    response.headers = [["Content-Type", "application/json"]];
    response.send();
    return;
  }

  function replySync(payload) {
    response.code = 202;
    response.body = JSON.stringify(payload);
    response.headers = [["Content-Type", "application/json"]];
    response.send();
  }

  apply(cmd, replySync);
});

Shelly.emitEvent("ms_slave_ready", { schema: SCHEMA, sw_id: SW_ID, deadman_sec: DEADMAN_SEC });
