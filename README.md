# Non-critical load control on grid loss (Shelly master–slave system)

**English · [Українська](README.uk.md)**

---

An autonomous system built on Shelly scripts (Gen2+) that switches off non-critical high-power loads when the central grid goes down and switches them back on after a stable recovery. It works directly between devices (peer-to-peer over local HTTP), with no MQTT broker and no cloud.

---

## 1. Purpose

When the central grid fails, the household switches to inverter (battery) power. To preserve the charge for critical loads, non-critical high-power consumers (water heater, pump, underfloor heating, etc.) need to be switched off automatically and switched back on once the grid returns and stabilizes.

The system consists of two scripts that work as a pair.

**[master.js](master.js)** — installed on one Shelly device (the Master). It detects the state of the central grid and dispatches commands to the executors. Detection uses two independent channels:

- *Input detector* — the state of a digital input wired to a dry contact of a grid-presence contactor.
- *Voltage detector* — voltage quality with hysteresis: it switches off when voltage leaves a wide band, and only permits switching on after voltage stays within a narrow band for a configured time.

The "grid is present" decision is made only when both detectors agree (AND logic). If the device has no voltage measurement, only the Input channel is used. If no contactor is wired, only voltage is used.

**[slave.js](slave.js)** — installed on each executor device (the Slave) that controls a non-critical load. It receives commands from the Master, executes them locally, and returns confirmation.

---

## 2. Key properties

- **Direct peer-to-peer channel** over local HTTP. Works even when the controlling app is unavailable.
- **Two-phase confirmation** (analogous to MQTT QoS): the Slave first confirms receipt of the command, then confirms actual execution with the relay state.
- **Idempotency** — a repeated command with the same identifier does not cause double actuation.
- **Retries and watchdog** — if a Slave does not respond, the Master retries the command, then records a failure.
- **Sequential recovery** — after the grid returns, loads are switched on one by one with a pause, to avoid simultaneous inrush load.
- **All settings in code** — no external dependencies, KVS is not used.
- **Events via MQTT** — the Master publishes all decisions and errors via NotifyEvent for tracking by a controlling app.

---

## 3. Limitations

- **Maximum 3 Slaves** per Master. This is dictated by the constraints of the Shelly script runtime (parallel HTTP calls, timers, memory). For more loads, use MQTT-broker-based control at the application level.
- Shelly Gen2 and newer devices are supported (RPC architecture).
- The Slave is intended for single-relay devices.

---

## 4. Usage example

**Scenario:** a house with a solar power plant and an inverter. When the grid fails, power is not interrupted, but the charge must be preserved — switch off the water heater, pool pump, and underfloor heating, while keeping the fridge, lighting, and router running.

**Configuration:**

- Master — a Shelly 1PM Gen4 on a line with voltage measurement; a dry contact of a grid-presence contactor is wired to its input.
- Slave 1 — Shelly on the water heater (switched on first on recovery).
- Slave 2 — Shelly on the pool pump.
- Slave 3 — Shelly on the underfloor heating.

**Operation:**

1. The grid fails → the contactor opens → after 5 seconds the Master sends an OFF command to all Slaves simultaneously.
2. The heater, pump, and heating switch off. Each returns a confirmation.
3. The grid returns → the Master waits 60 seconds of stable voltage → switches on the heater, then the pump after 30 seconds, then the heating after another 30 seconds.
4. The fridge, light, and router ran the whole time without intervention — they are not under the system's control.

---

## 5. Wiring the contactor for grid-state detection, using the Hager ESC125 NO as an example (normally open contacts)

### Purpose of this node

The Master needs to know whether the central grid is present. Since power to the house is not interrupted after a grid loss (the inverter keeps running), the mere presence of voltage at an outlet does not indicate the grid state. Therefore a dedicated sensor is needed specifically on the central-grid line — ahead of the inverter input. The contactor plays this role: its coil "senses" the grid, and its power contact passes that state to a Shelly input as a dry contact.

### Wiring diagram

**The contactor coil (terminals A1, A2)** is connected to the monitored line — the central grid ahead of the inverter input. The connection is not phase-dependent; as an example, take L on A1, N on A2.

- Grid present → 230 V on the coil → contactor pulled in → power contact 1-2 closed.
- No grid → coil de-energized → contact 1-2 open.

**The contactor power contact (terminals 1, 2)** is used as a dry signaling contact:

- terminal `1` → connected to the neutral `N` of the backup supply (the same one that powers the Shelly);
- terminal `2` → connected to the `SW` terminal of the Shelly relay (Master).

**Powering the Shelly itself (Master and all Slaves)** — must come from the backup source (the inverter output), not from the central grid. Otherwise, when the grid fails, the Shelly itself loses power and the entire system stops working exactly when it is needed.

### Why N is fed to the signaling contact, not L

The `SW` input on a Shelly Gen4 determines its state by the presence of an electric potential on it relative to the device's own supply. A common misconception is that `SW` must necessarily be fed phase `L`. For **controlling a load with an external switch** that is indeed how it's done: the switch passes the phase to `SW`. But our task is different — not to control, but only to **read whether the contact is closed or not**.

For reading the contact state, it does not matter which conductor is closed through it. Closing the neutral `N` through the contactor's dry contact gives the same result `input:0 state:true` as closing the phase. So we use `N` for three reasons:

1. **Safety.** There is no phase on the signal wire from the contactor to the Shelly. Touching this circuit during installation or maintenance is safer.
2. **The Shelly relay's power contacts are not used.** We use only the `SW` input. The relay's output power contacts (`O`/`I`) remain free — they are not needed on the Master, because the Master switches nothing itself and only detects and controls others over the network.
3. **Minimal load on the contactor contact.** Only a microcurrent (milliamps) flows through the `SW` input, not the working load. The contactor contact operates in the lightest possible mode and its lifespan is practically unaffected.

### Logic of operation

| Grid state | Coil A1-A2 | Contact 1-2 | Signal on SW | `input:0` | Master decision |
|---|---|---|---|---|---|
| Present | energized | closed | N arrives | `state:true` | grid_present=true |
| Absent | de-energized | open | nothing | `state:false` | grid_present=false |

### Note on contact selection

The ESC125 has one power contact 1NO (terminals 1-2), rated for 25 A. That is sufficient for detection. If, however, the power contact on your contactor is already used to switch a real load, a separate auxiliary contact is needed for the signal — in that case choose a contactor model with two channels, for example the Hager ESC225. Feeding `SW` a signal from an already-loaded power contact is not allowed.

---

## 6. Installation and configuration guide

### Step 1. Prepare the devices

Make sure all Shelly devices:

- are Gen2 or newer;
- are updated to the current firmware;
- are connected to the same local network;
- have static IP addresses (via DHCP reservation on the router or static configuration in the Shelly itself). This is critical — the Master reaches the Slaves by IP;
- are powered from the backup source (the inverter output).

### Step 2. Mount the detector contactor

Wire the contactor according to section 5. Before installing the scripts, verify that `input:0` on the Master correctly changes state when the central grid is switched off/on (visible in the Master's web interface, the Components section).

### Step 3. Install the Slave (on each executor)

1. Open the executor device's web interface at its IP.
2. Go to the **Scripts** section.
3. Click **Add script**.
4. Paste the **slave.mjs** code.
5. **Important:** the script must be first in the list, i.e. have **id = 1**. If the device already has other scripts and this one gets a different number — either delete the extra scripts, or change the `SLAVE_SCRIPT_ID` constant in the Master accordingly.
6. Configure the constants at the top of the file as needed:
   - `SW_ID` — the relay channel index. For a single-relay device leave it `0`.
   - `DEADMAN_SEC` — failsafe. `0` means disabled. If you want the relay to switch itself off after N seconds without a new command from the Master — set the desired number.
7. Click **Save**.
8. Enable autostart: check **Run on startup**.
9. Click **Start**.
10. The console should show `ms_slave_ready`.

Repeat for all executors (up to three).

### Step 4. Verify Slave reachability

From a browser, open on each Slave:

```
http://<IP_SLAVE>/script/1/cmd
```

It should return an HTTP 405 error (Method Not Allowed) — this is normal, because the browser makes a GET while the endpoint expects a POST. If you get 404 — the script did not start or has a different id; go back to step 3.

### Step 5. Install the Master (on the grid detector)

1. Open the detector device's web interface.
2. Go to **Scripts → Add script**.
3. Paste the **master.mjs** code.
4. Configure the constants at the top of the file.

   **The list of executors** — enter the IPs of your Slaves in the desired order. The first in the list is switched on first on grid recovery:

   ```javascript
   let TARGETS = [
     "192.168.1.20",
     "192.168.1.21",
     "192.168.1.22"
   ];
   ```

   If there is only one Slave — leave one line, delete or comment out the rest.

   **Voltage thresholds** (adjust to your grid if needed):

   ```javascript
   let V_LOW_OFF = 190;    // below this — switch off
   let V_LOW_ON = 200;     // above this — permit switching on
   let V_HIGH_OFF = 260;   // above this — switch off
   let V_HIGH_ON = 250;    // below this — permit switching on
   let V_STABLE_SEC = 60;  // how many seconds voltage must stay stable
   ```

   **Timings:**

   ```javascript
   let DEBOUNCE_OFF_SEC = 5;   // delay before switching off (protection against short glitches)
   let DEBOUNCE_ON_SEC = 60;   // delay before switching on (stability confirmation)
   let ON_GAP_SEC = 30;        // pause between switching on adjacent Slaves
   ```

5. Configure the grid detector. The `inputPresent()` function reads `input:0` by default. If your grid-presence signal is wired to a different input or has inverted logic — edit this function.
6. Click **Save**, check **Run on startup**, click **Start**.
7. The console should show:

   ```
   ms_voltage_source {"source":"switch"}   ← or "em", "em1", "none"
   ms_started {"schema":"master-slave-v1","n_targets":1}
   ```

### Step 6. Verify operation

While watching the Master's console:

1. **Open** the contactor / grid-presence input (simulating grid loss). After ~5 seconds you should see:

   ```
   ms_decision {"grid_present":false}
   ms_executed {...,"actual_on":false,...}   ← one per Slave
   ```

   The loads should switch off.

2. **Close** the contactor / input (simulating grid return). After ~60 seconds:

   ```
   ms_decision {"grid_present":true}
   ms_executed {...,"actual_on":true,...}
   ```

   The loads should switch on one by one.

If `ms_decision` appears but `ms_executed` does not — check: the IPs in `TARGETS` are correct; the Slave scripts are running (step 4); all devices are on the same network.

### Step 7. Changing settings after installation

Any change (new IP, different thresholds, timings) is made by editing the constants at the top of the respective script and clicking **Save**. The script restarts automatically and the new values apply immediately. No additional actions are needed.

---

## 7. Events for app integration

The Master publishes via MQTT (NotifyEvent to the topic `<device_id>/events/rpc`):

| Event | Meaning |
|---|---|
| `ms_started` | the script has started |
| `ms_voltage_source` | which voltage source was detected (`switch` / `em` / `em1` / `none`) |
| `ms_decision` | the grid state changed (`grid_present`) |
| `ms_executed` | a Slave confirmed execution (with relay state) |
| `ms_voltage_bad` / `ms_voltage_recovering` / `ms_voltage_good` | voltage quality changes |
| `ms_send_err` / `ms_retry` / `ms_failed` | communication problems with a Slave |

This lets a controlling app display the system state and receive notifications without interfering with the autonomous backup loop.

---

## 8. Exchange protocol (master-slave-v1)

Master → Slave, POST to `http://<slave_ip>/script/1/cmd`:

```json
{
  "cmd_id": "c1a2b3c4-...",
  "schema": "master-slave-v1",
  "grid_present": false,
  "ts": 1778938580,
  "ack_url": "http://<master_ip>/script/<id>/ack"
}
```

Slave → Master (synchronous HTTP response, phase 1 — received):

```json
{ "cmd_id": "...", "ack": "RECEIVED", "schema": "master-slave-v1" }
```

Slave → Master, POST to `ack_url` (phase 2 — executed):

```json
{
  "cmd_id": "...",
  "ack": "EXECUTED",
  "ok": true,
  "actual_on": false,
  "ts": 1778938581
}
```

A repeated command with the same `cmd_id` returns the cached result with the field `"ack": "DUPLICATE"` — this ensures safe retries without double relay actuation.
