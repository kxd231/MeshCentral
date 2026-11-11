# Web-RDP IPC: main process ⇄ session engine (version 1)

Interface contract: change the code and this document together.
Limits: `rdp/core/limits.js` (names in `CAPS`). Errors: `rdp/protocol/errors.js`.

## Roles

- **Main process**: `rdp/client.js` (API below), used by `CreateMstscRelay` in `apprelays.js`.
  Authorization, the browser websocket (rdp/WIRE.md), the relay websocket to the agent
  (`meshrelay.ashx?p=10`, no local TCP port), validation and rights of browser input, global
  budgets, deadlines that do not depend on the engine, killing the engine. It never parses RDP.
- **Engine** (`rdp/engine.js`): the whole RDP protocol for one session. Its only I/O is this IPC
  channel. It must not `require` `net`, `dgram`, `http`, `https`, `http2`, `child_process`,
  `cluster`, `worker_threads` (except `parentPort` in thread mode), `inspector`, or write files.
  TLS runs over an in-memory Duplex (`tls.connect({ socket: duplex })`) fed by `net` messages.
  An architectural lint (a unit test) checks this statically; it is a
  regression check, not a sandbox. Process mode adds the Node permission model and removes network
  globals (see Launch); the engine also deletes `fetch`, `WebSocket` and `EventSource` at start.

## `rdp/client.js` API (used by apprelays.js)

```js
const session = require('./rdp/client.js').createSession({
  config,          // start.config below, already validated, without credentials
  credentials,     // { domain, username, password } strings; encoded once, references dropped
  relay,           // connected ws WebSocket to the agent relay (opened by apprelays.js as today, with
                   //   maxPayload = RELAY_MSG_MAX_BYTES), paused; client.js resumes it after 'start'
  sendJson,        // function (array): send a JSON message to the browser
  sendBinary,      // function (Uint8Array): send a binary frame to the browser
  bufferedAmount,  // function (): browser websocket bufferedAmount
  debug,           // function (string): parent.parent.debug('relay', ...) when enabled
  settings,        // resolveSettings(args.webrdp) result (config keys arrive lowercased)
  slot,            // optional: release function of acquireSessionSlot(); owned by the session once
                   //   createSession returns, released when the engine process / thread has exited
  sendText,        // optional: function (string), preferred over sendJson (no second serialization)
  terminate        // optional: function (): drop the browser socket (global budget eviction after the end)
});
// createSession throws (invalid config / credentials, launch failure) with nothing left behind:
// credentials wiped, no timer, no relay listener; the caller still owns the slot then.
session.on('connect', function (info) { });   // { width, height, mode, gfx, tls: { fingerprint256 }, nla }
session.on('end', function (result) { });     // { clean: true } or { clean: false, error: <RdpError.toWire()>[, cert: { expected, actual }] }, exactly once;
                                              //   cert only with RDP_ERROR_CERT_CHANGED (expected = config.trust.fingerprint256), also sent in rdp-error
session.on('desktop', function (size) { });   // { width, height }: the desktop size changed (legacy and GFX), after 'connect'
session.on('resize', function (size) { });    // legacy reactivation or GFX pipeline restart; rdp-resize was sent
session.on('engine-exit', function () { });   // the engine process / thread is gone (after or without 'end'); diagnostics
session.input(ev);                // validated input event (format below), rights already applied
session.typeText(text);           // utype: expanded by client.js at UTYPE_INTERVAL_MS
session.clipboard(text);
session.ack(total); session.gfxAck(frameId, queueDepth);   // see "ACK validation" below
session.resize(width, height); session.visibility(visible);
session.close();                  // browser closed or 'disconnect': quit, then kill after ENGINE_QUIT_KILL_MS
session.fail(rdpError);           // end with an error decided by the browser layer (invalid messages, client-error):
                                  //   rdp-error is sent, then as close()
session.isConnected();            // true after 'connect'
session.charge(delta);            // bytes the browser layer holds for this session (pending clipboard): > 0 charges
                                  //   the global budget (false when evicted), < 0 releases
session.dispose();                // the browser socket is closed: release the charge kept for its buffers
```

Event order: `connect` (at most once) → `desktop` / `resize` → `end` (exactly once); `engine-exit`
follows `end`, or precedes it when the engine died (then `end` carries the error).

`client.js` sends `rdp-connect`, `rdp-resize`, `rdp-clipboard`, binary frames and the final
`rdp-error` / `rdp-close` itself; `apprelays.js` keeps authorization, credential saving and relaylog.

## Launch

**process** (default, `settings.webRdp.isolation = "process"`):

```js
child_process.fork(require.resolve('./engine.js'), [], {
  serialization: 'advanced',
  execArgv: ['--max-old-space-size=' + ENGINE_MAX_OLD_SPACE_MB,
             // where process.allowedNodeEnvironmentFlags has them:
             '--no-experimental-fetch', '--no-experimental-websocket', '--disallow-code-generation-from-strings', '--no-addons',
             '--permission' /* Node 20: --experimental-permission */, '--allow-fs-read=<rdp/>', '--allow-fs-read=<public/rdp/shared/>'],
  env: {},                                        // nothing inherited: no secrets, no NODE_OPTIONS (win32: SystemRoot only)
  stdio: ['ignore', 'ignore', 'ignore', 'ipc']    // engine output never reaches logs unfiltered
});
```

**thread** (`isolation = "thread"`): `new Worker(engine.js, { resourceLimits: { maxOldGenerationSizeMb }, env: {}, stdout: true, stderr: true })`,
messages over `parentPort`. `stdout: true, stderr: true` give the parent the streams instead of
forwarding them to its own output; the parent reads and discards them. Same messages and the same copy
semantics (no transfer lists). Thread mode isolates exceptions and the event loop, not memory:
`heartbeat.rss` is the memory of the worker's own isolate (V8 heap in use plus external memory, ArrayBuffers included), checked
against `ENGINE_MAX_RSS_BYTES` like a process RSS (the process RSS cannot be split per worker). Worker threads reject
the hardening flags and have no permission model: the server logs a warning at startup when the engine runs
without it (thread mode, or a Node without the flag). Engines still running when the server process exits
are killed. On Linux the main process sets `/proc/<pid>/oom_score_adj` of a forked engine to 1000 (best effort, asynchronous), so the kernel's
OOM killer takes an engine before the MeshCentral process.

Credentials and settings are never passed in argv or env. The engine exits on IPC disconnect.
It installs `uncaughtException` / `unhandledRejection` handlers that send
`{ t: 'end', clean: false, error: toRdpError(err).toWire() }` (class name only) and exit.
The engine exits only after `end` has left: process mode waits for the `process.send` callback
(at most 500 ms), thread mode posts `end` and returns from the event loop. The main process treats
the last message before the exit as delivered.

## Messages

Every message is an object `{ t: <type>, ... }`. Binary payloads are `Uint8Array`. Messages are
copied (process: advanced serialization; thread: structured clone without transfer). Any unknown `t`,
missing field, wrong type or out-of-range counter is fatal on the receiving side (engine: `end` with
`clean: false`, `RDP_ERROR_INTERNAL`, and exit; main: kill the engine, `RDP_ERROR_INTERNAL`). All counters are
**cumulative** totals (safe integers), never deltas; a total that decreases or exceeds what was sent
is fatal.

### Main → engine

| `t` | Fields | Meaning |
|---|---|---|
| `start` | `v: 1`, `config`, `credentials` | first message, exactly once, after `hello` |
| `net` | `data` (≤ `IPC_CHUNK_MAX_BYTES`) | bytes from the RDP server; a relay message is split into chunks |
| `net-end` | — | relay closed by the peer; no more `net` follows |
| `net-out-ack` | `total` | bytes of engine `net` output written to the relay |
| `clipboard-ack` | `total` | number of engine `clipboard` messages the main process has forwarded to the browser |
| `out-ack` | `total` | bytes of engine `out` frames handed to the websocket while below `WS_HIGH_WATER_BYTES` |
| `ack` | `total` | validated browser `ack` (WIRE.md) |
| `gfx-ack` | `frameId`, `queueDepth` | validated browser `gfx-ack` |
| `input` | `ev` | one validated input event |
| `clipboard` | `text` | local clipboard text (coalesced: main keeps only the latest pending one) |
| `resize` | `width`, `height` | validated, coalesced |
| `visibility` | `visible` | Suppress Output / Refresh Rect |
| `quit` | — | close cleanly; main kills the engine after `ENGINE_QUIT_KILL_MS` |

`start.config`:

```js
{
  width, height,                 // initial desktop size
  mode: 'legacy' | 'gfx',
  displayControl: bool,         // optional, default true; settings.webRdp.displayControl (lowercased args.webrdp.displaycontrol)
                                 //   false: no DISP listener, legacy static channels exactly ['cliprdr']; GFX still needs drdynvc
  displayControlEvenHeight: bool, // optional, default false; round down height in DISP requests only, after fitting area
  gfxCapsets: ['B', 'A'],        // ids from GFX_CAPSETS_ALLOWED the engine may advertise, in order
  surfaceCodecs: ['rfx'],        // optional (default []): legacy Surface Commands codecs to advertise ('rfx'; 'nsc' later); legacy mode,
                                 //   32 bpp only. WIRE.md SURFACE_BITS frames follow; set by the main process from browser.rfx + dev switch
  colorDepth: 15 | 16 | 24 | 32, // legacy
  perfFlags, connectionType: 'lan',
  keyboardLayout,                // KLID from the locale (localeToKeyboardLayout)
  clientName,                    // ≤ 15 chars, 'MeshCentral'
  serverName,                    // target host name or '', for logs and the CredSSP SPN (TERMSRV/<host>)
  security: 'auto' | 'nla',      // 'nla': only CredSSP (PROTOCOL_HYBRID / HYBRID_EX) is requested and accepted; a
                                 //   server selecting TLS only ends with RDP_ERROR_SECURITY_NEGOTIATION before any
                                 //   credential is sent. 'auto' (default) also accepts TLS only (xrdp).
                                 //   Values: rdp/protocol/transport.js SECURITY. Main process: settings.webRdp.requirenla
  trust: {                       // optional, default { fingerprint256: null, nlaSeen: false }. Server-side trust of this device and
                                 //   port (TOFU, rdp/trust.js), loaded by the main process, never by the browser
    fingerprint256: null | 'AA:BB:..:FF',  // pinned SHA-256 of the server certificate (Node's fingerprint256 form), or null: not pinned yet
    nlaSeen: bool                // CredSSP succeeded against this device before: TLS-only is refused on every attempt
  },                             //   With fingerprint256 set, the engine compares the certificate right after the TLS handshake and ends
                                 //   with RDP_ERROR_CERT_CHANGED before CredSSP / NTLM or Client Info are sent. With nlaSeen, a server
                                 //   selecting TLS only ends with RDP_ERROR_NLA_DOWNGRADE right after the X.224 Connection Confirm
                                 //   (before the TLS handshake). The main process also sets security 'nla' when its own policy requires it
  alternateShell, workingDir,    // '' unless the user has full control (WIRE.md Permissions)
  debug: bool                    // engine sends 'log' messages
}
```

`input.ev` (rights already applied by the main process):

```js
{ k: 'mouse', x, y, button, down }          // as in WIRE.md
{ k: 'wheel', x, y, delta, horizontal }
{ k: 'scancode', code, down }               // 0x01..0x7F or 0xE001..0xE07F
{ k: 'unicode', unit, down }
{ k: 'sync', locks }
```

### Engine → main

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `v: 1`, `node` (version string) | ready for `start`; within `ENGINE_START_TIMEOUT_MS` |
| `heartbeat` | `rss` (bytes) | every `ENGINE_HEARTBEAT_MS` |
| `net` | `data` (≤ `IPC_CHUNK_MAX_BYTES`) | bytes to the RDP server |
| `net-ack` | `total` | `net` input bytes consumed (see Flow control) |
| `ctl-ack` | `total` | control cost units consumed (see Flow control) |
| `phase` | `phase` (`PHASE`) | progress, for logs |
| `connect` | `width`, `height`, `mode`, `gfx` (`null` or `{ capsVersion, flags }`), `tls` (`{ fingerprint256 }`), `nla` (bool: CredSSP completed) | session active. The main process pins `tls.fingerprint256` and stores `nla` as `nlaSeen` (trust on first use) |
| `desktop` | `width`, `height` | the desktop size changed (legacy reactivation, GFX RESETGRAPHICS); main follows it for pointer validation (WIRE.md) |
| `resize` | `width`, `height` | legacy reactivation with a new size, or a restarted GFX pipeline (after `desktop`); main sends `rdp-resize`. Both messages are posted after the `out` frames queued before them |
| `out` | `data` (≤ `WIRE_FRAME_MAX_BYTES`) | one complete binary WIRE frame, forwarded unchanged |
| `clipboard` | `text` (≤ `CLIPBOARD_MAX_BYTES`) | remote clipboard text; at most one not yet acknowledged by `clipboard-ack`, newer text replaces a pending one inside the engine |
| `end` | `clean: bool`, `error` (`RdpError.toWire()`, when not clean), `cert` (`{ fingerprint256 }`, only with `RDP_ERROR_CERT_CHANGED`: the certificate the server presented) | session over; exactly once, then the engine waits for `quit` |
| `log` | `level` (`debug` / `warn`), `msg` (≤ 1 KiB) | only when `config.debug`; at most 50 per second, the engine drops the excess |

The main process checks `out` frames only for size and the first byte (`WIRE` type), validates
`error` with `RdpError.fromWire`, and drops `log` lines over 1 KiB. Engine → main traffic is bounded
by the flow control below (`net`, `out`), one pending `clipboard` and the `log` rate; all other
messages are small and event driven. The main process also counts every engine message in a token bucket
(`ENGINE_MESSAGE_BURST`, refilling at `ENGINE_MESSAGES_PER_SECOND`); an engine that exceeds it is a broken engine
(`RDP_ERROR_INTERNAL`, killed). **Not enforced**: the size of a single message is checked only after Node has received
and deserialized it (Node's IPC channel has no maximum message size and is not replaced); "bounded" holds in full only for a
correct engine, a compromised one is contained by the process boundary, the engine RSS check (1 s sampling) and `oom_score_adj`. Log lines are built only from
constants, numbers and `PHASE` names: never from received data, exception messages or credentials.

## Credentials

- `client.js` encodes each field once into a **dedicated** `Uint8Array` (`new Uint8Array(n)`, never a
  pooled `Buffer`), UTF-16LE, no terminator, each ≤ `CREDENTIAL_FIELD_MAX_CHARS` units (validated
  before encoding). It posts `start` (a copy is made by serialization) and zeroes its own arrays
  immediately after the post call returns, also when posting throws.
- `start.credentials = { domain, username, password }` with those arrays. They appear in no other
  message.
- The engine owns its copies and every derived secret (NT hash, NTOWFv2, NTLM session and sealing
  keys, encoded TSCredentials, encoded Client Info). One function wipes all of them (`fill(0)`) and
  is called: after Client Info is sent (NLA and TLS-only), on `end`, on `quit`, in the
  `uncaughtException` handler and before exit. NLA keys are wiped when CredSSP completes.
- Auto-reconnect uses the server's ARC cookie, never the password.

## Flow control

Rule: "send while in flight < budget". Worst case in flight = budget + one maximal message of that
path. Main process queues are also charged to the global `GLOBAL_QUEUED_MAX_BYTES` **before**
admission; when the global budget is full the session with the largest queues ends with
`RDP_ERROR_RESOURCE_LIMIT`.

| Path | In flight | Budget | Max message | When full |
|---|---|---|---|---|
| relay → engine | `net` total posted − `net-ack` total | `ENGINE_INPUT_QUEUE_BYTES` | `RELAY_MSG_MAX_BYTES` (relay `maxPayload`), split into `IPC_CHUNK_MAX_BYTES` | main pauses the relay websocket (TCP backpressure through the agent) |
| engine → relay | engine `net` total − `net-out-ack` total | `RELAY_OUTPUT_QUEUE_BYTES` | `IPC_CHUNK_MAX_BYTES` | engine queues input events (≤ `ENGINE_INPUT_EVENTS_MAX`, pointer moves coalesced; beyond → `RDP_ERROR_RESOURCE_LIMIT`) and stops acknowledging `net` |
| engine → main → websocket | engine `out` total − `out-ack` total | `ENGINE_OUTPUT_QUEUE_BYTES` | `WIRE_FRAME_MAX_BYTES` | engine stops acknowledging `net` input |
| engine `out` frames | frames posted per second | `ENGINE_OUT_FRAMES_PER_SECOND` (burst `ENGINE_OUT_FRAME_BURST`) | — | frames wait in the engine queue, the engine stops acknowledging `net` input |
| websocket | `bufferedAmount` | `WS_HIGH_WATER_BYTES` / `WS_LOW_WATER_BYTES` | — | main delays `out-ack` until below the low water mark |
| browser window | engine `out` total − browser `ack` total | `WINDOW_BYTES` (WIRE.md) | `WIRE_FRAME_MAX_BYTES` | engine stops producing frames and stops acknowledging `net` |
| main → engine control | cost units posted − `ctl-ack` total (see below) | `IPC_CONTROL_QUEUE_BYTES` | `CLIENT_MSG_MAX_BYTES` | main keeps at most one pending pointer move, one pending clipboard and one pending resize (latest wins) without posting; any other input (keys, buttons, wheel, sync) that does not fit ends the session with `RDP_ERROR_RESOURCE_LIMIT` (dropping a key-up would leave a key stuck) |

Control cost: `input`, `resize`, `visibility`, `ack`, `gfx-ack` cost 64 units each, `clipboard` costs
64 + 2 × text length. The engine adds the cost of every control message to its `ctl-ack` total when
it has handled it (input: queued for the relay or sent: **acknowledged when it enters the engine's input queue**, so the main
credit does not reflect the `ENGINE_INPUT_EVENTS_MAX` queue; a long `utype` while the relay output is held can end the session
with `RDP_ERROR_RESOURCE_LIMIT`). Lifecycle messages and the main process's own
acknowledgements (`net-out-ack`, `out-ack`, `clipboard-ack`, `net-end`, `quit`) are not charged: they are
bounded by the data they acknowledge. Browser acknowledgements are not inherently bounded (a browser can
send many valid, increasing `ack`s), so they pass a **bounded acknowledgement queue**: an `ack` is queued
only when its total increased, consecutive `ack`s in the queue are coalesced into the latest total, a
`gfx-ack` is queued as is (so the order around `gfx-ack`s is kept), each entry is charged to the global
budget, at most `ACK_QUEUE_MAX_ENTRIES` entries (beyond → `RDP_ERROR_RESOURCE_LIMIT`). This bound relies on **at most one END_FRAME per `out`
frame** (the engine's ledger holds at most `GFX_MAX_UNACKED_FRAMES` entries because each frame adds at most one); a change that puts
several END_FRAMEs into one frame must change `ACK_QUEUE_MAX_ENTRIES` with it. Entries are posted
with **receipt-based credit**: at most `IPC_BACKLOG_MAX_MESSAGES` posted `ack` / `gfx-ack` not yet covered
by `ctl-ack` (the engine counts each as 64 units when it handles it, in arrival order), so a stalled worker
or process never accumulates them in its message queue; process mode also waits while the pipe backlog
(messages whose `send` has not completed) is at that limit. Their charge stays until `ctl-ack`. The
number of `gfx-ack`s is also bounded by the GFX bytes sent (12 bytes per END_FRAME PDU); their identity
(oldest frame, once, channel generation) is checked only by the engine. `visibility` is coalesced like
resize (latest value pending, posted when credit returns). Posting returns before the engine
has received the message, so only `ctl-ack` releases control credit.

`net-ack` semantics: the engine acknowledges `net` bytes once the connection has read them out of the relay
transport (TLS consumed them), while input is not held (`io.holdInput`), no frame waits for credit, the relay
output is below its budget and no input event is queued. The connection keeps what it read bounded: it moves
plaintext into parsed PDUs or reassembly buffers, holds input or pauses the TLS socket when it cannot, and
charges large buffers through `io.reserve` (rdp/ENGINE-API.md). Reassembly buffers are charged to
`REASSEMBLY_MAX_BYTES` (all incomplete fast-path, SVC and DVC messages together, each also below its
own limit) and to `ENGINE_ALLOC_MAX_BYTES`. So a 16 MiB DVC message flows through the 4 MiB input
window without deadlock, and memory stays bounded by the reassembly budget.

## ACK validation (browser `ack` / `gfx-ack`)

- **Main process** (before posting): `ack.total` is a safe integer, ≥ the previous total and ≤ the
  bytes of `out` frames it has sent to the websocket; `gfx-ack.frameId` is 0..0xFFFFFFFF and
  `queueDepth` 0..0xFFFFFFFE. Violation → `RDP_ERROR_CLIENT_PROTOCOL`.
- **Engine** (owns the GFX frame ledger, because only it sees END_FRAME): a frame's `endOffset` is the
  engine `out` total after the frame carrying its END_FRAME (equal to the main process count, since
  every `out` frame is sent in order and unchanged). The engine applies the WIRE.md rules: `gfx-ack`
  only for the oldest recorded frame, once; an `ack` reaching an `endOffset` without that frame's
  `gfx-ack` is a violation; it then ends the session with `RDP_ERROR_CLIENT_PROTOCOL`.
- The ledger records each frame with the GFX channel **generation** current when the connection submitted
  it (`io.sendFrame`). Opening or closing the channel (`io.gfxChannel()`) starts a new generation and
  `totalFramesDecoded` restarts at zero; frames of an older generation still in the browser stay in the
  ledger, their `gfx-ack`s follow the same rules (oldest, once) but are neither forwarded nor counted.
  frameIds are compared for equality only, so a server wrapping them causes no ambiguity.

## Deadlines and lifecycle

Owned by the main process (they work even when the engine hangs):

- `hello` within `ENGINE_START_TIMEOUT_MS`;
- `connect` within `CONNECT_TIMEOUT_MS + CONNECT_GRACE_MS` after `start`;
- a message (at least `heartbeat`) every `ENGINE_WATCHDOG_MS`; `heartbeat.rss` ≤ `ENGINE_MAX_RSS_BYTES`. All these deadlines are
  measured on a clock that stops when the main process's event loop was blocked (a timer tick later than its schedule by more than
  a fraction of its period moves the deadlines forward by the lateness): one stalled server does not end every session;
- stall of the browser (WIRE.md "Stall").

Owned by the engine (precise errors with `phase`): `CONNECT_TIMEOUT_MS`, `NLA_TIMEOUT_MS`.
Any breach → `RDP_ERROR_TIMEOUT` (with phase), `RDP_ERROR_RESOURCE_LIMIT` (rss) or
`RDP_ERROR_CLIENT_STALLED`.

1. `apprelays.js` authorizes, then reserves a session slot (`acquireSessionSlot`: `maxSessions`,
   `maxSessionsPerUser`, `LAUNCHES_PER_USER_PER_MINUTE`, and the engine memory budget `settings.webRdp.maxEngineMemoryMb`:
   `ENGINE_ADMISSION_BYTES` (or the larger measured size) per live engine plus the new one must fit, default half of the host memory; → `RDP_ERROR_TOO_MANY_SESSIONS`) and opens the
   relay to the agent as today, paused. Relay failure → `RDP_ERROR_RELAY_FAILED`. The slot is held until
   the engine has exited (`createSession` takes it over), or released by the caller when the session fails
   before the engine is launched.
2. `createSession` launches the engine, waits for `hello`, posts `start`, then resumes the relay.
3. Relay closed by the peer: main forwards remaining data, posts `net-end` and waits up to
   `NET_END_DRAIN_MS` for `end`, so a Set Error Info reason received just before the close is
   reported. Without `end` in time: `RDP_ERROR_CONNECTION_LOST`.
4. `end` from the engine, browser close, or a deadline: main sends the final `rdp-error` /
   `rdp-close` (unless the browser is gone), posts `quit`, closes the relay and the websocket, and
   kills the engine after `ENGINE_QUIT_KILL_MS`.
5. Engine exit, crash or IPC disconnect without `end` → `RDP_ERROR_INTERNAL`
   (`RDP_ERROR_RESOURCE_LIMIT` when caused by the heap or RSS limit). The main process keeps running.
