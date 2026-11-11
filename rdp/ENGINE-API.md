# Web-RDP engine API: engine ⇄ RDP connection

`rdp/engine.js` owns the IPC channel (rdp/IPC.md), flow control, budgets, the GFX frame ledger,
engine timeouts and secret wiping. The RDP protocol itself lives in a **connection** object
(built on the transport and NLA blocks of rdp/protocol/transport.js). This file is the whole interface between them.
The unit tests use a fake implementation of this interface.

## Module

`rdp/protocol/connection.js` exports `createConnection(io)` and returns a connection object.
The engine requires it lazily when `start` arrives; a missing module ends the session with
`RDP_ERROR_INTERNAL`. Like every module the engine loads, it must not require `net`, `dgram`,
`http`, `https`, `http2`, `child_process`, `cluster`, `inspector`, `fs` or `worker_threads`, must use
string literals in `require()` (no aliases of `require`), must not use `process.binding`,
`process.dlopen`, `import()`, `eval`, `fetch` or `WebSocket`, and calls `tls.connect` only with
`socket:` (a unit test checks this: an architectural lint, not a sandbox). In process mode the engine runs under the Node permission
model with read access to `rdp/` and `public/rdp/shared/` only: a dependency outside these
directories (e.g. `node_modules/node-forge`) must be added to `permissionArgs()` in `rdp/client.js`.

## `io` (provided by the engine, frozen)

| Member | Meaning |
|---|---|
| `io.config` | `start.config` (rdp/IPC.md), frozen. `config.trust` (`{ fingerprint256, nlaSeen }`) must reach `transport.connect` (the spread of `io.config` does that): the certificate is checked right after the TLS handshake and a TLS-only selection is refused when `nlaSeen`, both before any credential is sent |
| `io.credentials` | `{ domain, username, password }`: `Uint8Array` UTF-16LE, no terminator, ≤ 255 units each. Owned by the engine, zeroed by `wipeSecrets()` |
| `io.transport` | `Duplex` to the RDP server through the agent relay, the only socket: hand it to the transport (below). `'end'` when the relay closed (`net-end`). Writes are flow controlled (the write callback waits for relay credit), so respect `write()` returning false. `unshift()` throws: delivered bytes are counted as pushed − `readableLength` |
| `io.signal` | `AbortSignal`, aborted at `CONNECT_TIMEOUT_MS` (reason `RdpError` TIMEOUT with the phase) and when the session ends (`io.end`, `quit`, exit). Pass it to `transport.connect` |
| `io.limits` | the limits table (`rdp/core/limits.js`), with test overrides |
| `io.phase(p)` | report progress (`PHASE` value). `'nla'` starts `NLA_TIMEOUT_MS`, any other phase stops it. Errors and timeouts carry the last phase |
| `io.connected({ width, height, mode, gfx, tls })` | once, when the session is active. `mode` `'legacy'`/`'gfx'`, `gfx` `null` or `{ capsVersion, flags }`, `tls.fingerprint256` as `AA:BB:...` (Node's `getPeerCertificate().fingerprint256`), `nla` (bool, CredSSP completed: `transport.connect` result `credssp != null`). Stops `CONNECT_TIMEOUT_MS` |
| `io.resized(width, height)` | legacy reactivation with a new desktop size, or a GFX pipeline restart after its new CapsConfirm (both after `connected`): the main process gets `desktop` and the browser `rdp-resize` |
| `io.desktop(width, height)` | any other desktop size change, i.e. GFX RESETGRAPHICS: the main process validates pointer coordinates against it (WIRE.md "Desktop size changes"; old coordinates are clamped for `DESKTOP_CHANGE_GRACE_MS`). The connection still clamps input to its own desktop |
| `io.sendFrame(frame, endFrameIds, options)` | one complete WIRE frame (`Uint8Array`, byte 0 = `WIRE` type, ≤ `WIRE_FRAME_MAX_BYTES`), only after `connected`. For a `WIRE.GFX` frame, `endFrameIds` lists the frameId of every END_FRAME PDU it carries, in order (or `null`); they belong to the GFX generation current at this call. A GFX frame may carry several PDUs with at most one END_FRAME, the last PDU (WIRE.md). Never blocks: frames wait in order in an engine queue (also held back by `ENGINE_OUT_FRAMES_PER_SECOND`) charged to `ENGINE_ALLOC_MAX_BYTES`, released when the frame is posted. **Charge**: by default the engine reserves `frame.length` itself and the caller keeps (and later releases) whatever it reserved to build the frame (`slowpath.js` works this way: its writer reservation is released after the `yield`). With `options.charged = n` the caller hands over `n` bytes it already reserved: the engine does not reserve again and releases those `n` bytes when the frame is posted; the caller must not release them. **Ownership passes to the engine**: do not modify, reuse or wipe the buffer afterwards (it may still be queued); build every frame in a fresh buffer |
| `io.outputBlocked()` | true while frames wait or no frame credit is left (browser window, websocket queue, `GFX_MAX_UNACKED_FRAMES`). Stop reading the TLS socket while true; `connection.drain()` is called when it clears |
| `io.sendClipboard(text)` | remote clipboard text (`(length + 1) × 2 ≤ CLIPBOARD_MAX_BYTES`); a newer text replaces one not yet acknowledged |
| `io.gfxChannel()` | the RDPGFX channel was opened or closed: a new channel generation. `totalFramesDecoded` restarts at zero; frames of the old generation still in the browser stay in the ledger, their `gfx-ack`s are accepted but not forwarded or counted |
| `io.holdInput(bool)` | stop / resume acknowledging relay input (e.g. while reassembly is at its budget). Input is also held automatically while output is blocked or the relay output is full |
| `io.reserve(n)` / `io.release(n)` | charge / release large buffers (reassembly, ZGFX history and output, GFX message queue, TLS write jobs, frames being built) to `ENGINE_ALLOC_MAX_BYTES`. Frames already posted to the main process are not charged here (they live in the IPC pipe and the main process, bounded by `ENGINE_OUTPUT_QUEUE_BYTES` and the global budget). The engine stores no pointer pixels. `reserve` throws `RdpError('RDP_ERROR_RESOURCE_LIMIT')` before anything is allocated |
| `io.secret(buf)` | register a derived secret (NT hash, NTOWFv2, session / sealing keys, encoded TSCredentials, encoded Client Info) so every exit path zeroes it; returns `buf` |
| `io.wipe(buf)` | zero one secret now (e.g. NLA keys when CredSSP completes) |
| `io.wipeSecrets()` | zero the credentials and every registered secret. Call it right after Client Info is sent (NLA and TLS-only). The engine also calls it on `end`, `quit`, uncaught exceptions and exit. `transport.connect` wipes its own NLA secrets (NTLM keys, TSCredentials) before it resolves or rejects; it does not wipe `io.credentials` |
| `io.log(level, msg)` | `'debug'` / `'warn'`, only when `config.debug`; ≤ 1024 chars, 50 per second. Build lines only from constants, numbers and PHASE names: never from received data, exception messages or credentials |
| `io.end(err)` | (an `RdpError` with code `RDP_ERROR_CERT_CHANGED` may carry the presented fingerprint in the plain property `certFingerprint`, set by `transport.connect`; the engine validates it and sends it as `end.cert`) the session is over. `null` → clean (`rdp-close`), otherwise any error: `RdpError` keeps code / detail / phase / hint, anything else becomes `RDP_ERROR_INTERNAL` with the class name only. Once; later calls are ignored |

## Using the transport (`rdp/protocol/transport.js`)

```js
start: function () {
    const self = this;
    transport.connect(io.transport, {
        security: io.config.security,            // 'nla' refuses TLS-only servers before any credential is sent
        credentials: io.credentials,             // not wiped by transport.connect: call io.wipeSecrets() after Client Info
        serverName: io.config.serverName, clientName: io.config.clientName,
        signal: io.signal,                       // the engine owns the deadline (and aborts on end / quit)
        onPhase: function (p) { io.phase(p); }   // x224 → tls → nla
    }).then(function (r) {
        if (self.closed) { r.socket.destroy(); return; }
        self.tls = r.socket;                     // paused, positioned after the handshake
        r.socket.on('error', function (e) { io.end(e); });
        r.socket.on('close', function () { io.end(new RdpError('RDP_ERROR_CONNECTION_LOST', { phase: ... })); });
        r.socket.on('data', onData);             // listeners first, then resume: no byte or error is lost
        r.socket.resume();
        // ... MCS / GCC (phase 'mcs'), Client Info, then io.wipeSecrets() ...
    }, function (err) { io.end(err); });
},
close: function () { this.closed = true; if (this.tls) { this.tls.destroy(); } }   // io.signal is already aborted
```

The engine owns the `AbortController` behind `io.signal`. The connection never aborts it, and cancels its own
work in `close()`. `connection.close()` runs after `io.signal` is aborted, so a pending `transport.connect`
rejects with TIMEOUT (ignored after the end).

## Connection object (called by the engine)

| Method | When |
|---|---|
| `start()` | after `start`: begin with X.224 on `io.transport` |
| `input(ev)` | one input event (rdp/IPC.md `input.ev`), rights already applied. Ignore it when not active |
| `clipboard(text)` | local clipboard text for the remote side |
| `resize(width, height)` | browser resize request (DISP), already validated |
| `visibility(visible)` | Suppress Output (`false`) / allow + Refresh Rect (`true`) |
| `gfxAck({ frameId, queueDepth, totalFramesDecoded })` | an accepted browser frame ack: send RDPGFX_FRAME_ACKNOWLEDGE_PDU with these values (`queueDepth` bytes, 0 = unavailable) |
| `drain()` | optional: output was blocked and is free again |
| `close()` | once, on `end`, `quit` or exit: release timers and sockets synchronously; must not throw |

An exception thrown by any of these methods ends the session through `io.end(err)`. Errors in
asynchronous code must be passed to `io.end(err)`; anything that still escapes is caught by the
engine's `uncaughtException` handler, which sends `end` (class name only) and exits.

## What the engine does around the connection

- `net` → `io.transport` readable side; `net-ack` covers the bytes the connection (TLS) has read out
  of the transport, only while input is not held, no frame waits, the relay output is below
  `RELAY_OUTPUT_QUEUE_BYTES` and no input event is queued (same rule as rdp/IPC.md "net-ack semantics").
  What the connection has read it keeps bounded: parsed PDUs, reassembly charged through `io.reserve`, or
  `io.holdInput(true)` / pausing the TLS socket while it cannot take more.
- Transport writes → `net` chunks ≤ `IPC_CHUNK_MAX_BYTES`, posted while engine → relay in flight is
  below `RELAY_OUTPUT_QUEUE_BYTES`; the write callback is delayed until then.
- Input events are delivered while relay output is below its budget; otherwise they wait in a
  queue (≤ `ENGINE_INPUT_EVENTS_MAX`, consecutive pointer moves coalesced; overflow ends the session
  with `RDP_ERROR_RESOURCE_LIMIT`).
- The GFX ledger records `{ frameId, endOffset, generation }` for each id in `endFrameIds` when the frame
  is posted; browser `gfx-ack` / `ack` are checked against it (rdp/IPC.md "ACK validation") before
  `gfxAck()` is called, only for frames of the current generation (`io.gfxChannel()`).
- Timeouts: `CONNECT_TIMEOUT_MS` from `start` to `io.connected()`, `NLA_TIMEOUT_MS` while the phase is
  `nla`; both end with `RDP_ERROR_TIMEOUT` and the phase.
