# Web-RDP wire protocol: browser ⇄ server (version 1)

Interface contract: change the code and this document together.
Constants: `public/rdp/shared/constants.js` (`WIRE_*`, `GFX_*`), limits: `public/rdp/shared/limits.js`
(names in `CAPS` below), error names and hints: `public/rdp/shared/errors.js`.

## Transport

- WebSocket `wss://<server>/<domain>/mstscrelay.ashx`, authenticated exactly as today
  (session cookie for `node/...`, or the encrypted login cookie in `infos.ip`).
- The server sets the websocket `maxPayload` (receiver and permessage-deflate) to `INFOS_MSG_MAX_BYTES`
  until the peer is **authorized** (rights resolved), then to `CLIENT_MSG_MAX_BYTES`, so a larger message is refused by the
  websocket library (close 1009) before it is buffered or inflated. When the library does not expose
  these limits the session is refused (`RDP_ERROR_INTERNAL`) and the server logs it.
- Before parsing, after `infos`: a message larger than `CLIENT_SMALL_MSG_MAX_BYTES` must start with
  `["clipboard",` or `["utype",` (otherwise it is invalid and counted); without full control it is dropped
  unparsed. All messages together are limited to `CLIENT_BYTES_PER_SECOND` (token bucket); excess
  messages are dropped unparsed.
- **Message rate**: before anything is parsed, every message (acks, pings, pointer moves, messages in
  `AUTHORIZING` / `CONNECTING`, ignored ones) takes one token of a bucket of `CLIENT_MESSAGE_BURST` that refills
  at `CLIENT_MESSAGES_PER_SECOND`. A message without a token is dropped unparsed; `CLIENT_OVERRATE_MAX` of them in
  a row (the bucket not back to an eighth in between) close the session with `RDP_ERROR_CLIENT_PROTOCOL`. Messages
  ignored in `AUTHORIZING` / `CONNECTING` (everything except `ping`, `pong`, `disconnect`) are counted: the
  `CLIENT_PREACTIVE_IGNORED_MAX`-th closes the session. A real session sends tens of messages per second.
- A socket without a valid `infos` after `INFOS_TIMEOUT_MS` is closed (`RDP_ERROR_CLIENT_PROTOCOL`). The
  server pings every `WS_PING_INTERVAL_MS` and terminates a socket without a pong for `WS_PONG_TIMEOUT_MS`. Any message from the browser counts as a sign of life,
  and the check is skipped while data is queued for the socket (the pong sits behind it; the stall rule below decides).
  A ping tick delayed by a blocked event loop is not held against the browser.
- **Text frames**: one JSON array `[type, ...args]` per frame, both directions.
- **Binary frames**: server → browser only. Byte 0 is the frame type (`WIRE`), all integers
  little-endian, no padding, one frame ≤ `WIRE_FRAME_MAX_BYTES`. A binary frame from the browser
  closes the session with `RDP_ERROR_CLIENT_PROTOCOL`.

## Session states (server)

| State | Entered when | Browser messages accepted | Anything else |
|---|---|---|---|
| `AWAIT_INFOS` | websocket open | `infos` | close, `RDP_ERROR_CLIENT_PROTOCOL` |
| `AUTHORIZING` | valid `infos` received | `ping`, `pong`, `disconnect` | dropped silently (not counted) |
| `CONNECTING` | rights resolved, engine started | `ping`, `pong`, `disconnect` | dropped silently |
| `ACTIVE` | `rdp-connect` sent | every message below except `infos` | `infos`: dropped silently |
| `CLOSING` | `rdp-error` / `rdp-close` sent or socket closing | none | dropped |

Input is forwarded only in `ACTIVE`, after the user's rights (view-only, limited input) are known.
No binary frame is sent before `rdp-connect`.

## Validation

- A message is valid only if it is an array whose first element is a known type string, with
  **exactly** the arity in the tables below, and every argument of the stated type and range.
  Integers must be safe integers; numbers must be finite. Strings must not contain U+0000.
- Invalid messages and unknown types in `ACTIVE` are dropped and counted;
  `CLIENT_INVALID_MAX` in a row close the session with `RDP_ERROR_CLIENT_PROTOCOL`.
- Rate limits per session (sliding second):
  - input (`mouse`, `wheel`, `scancode`, `unicode`, `sync`): `INPUT_MAX_EVENTS_PER_SECOND`.
    Excess pointer moves (`mouse` with button 0) are coalesced to the latest position; any other
    excess input closes the session with `RDP_ERROR_CLIENT_PROTOCOL` (dropping a key-up would leave
    a key stuck on the remote side);
  - control (`clipboard`, `resize`, `visibility`, `ping`, `pong`): `CONTROL_MAX_MESSAGES_PER_SECOND`,
    excess dropped. `clipboard` and `resize` are also coalesced: only the latest pending one is kept;
  - `ack`, `gfx-ack`, `client-error`, `disconnect`, `utype`: not rate limited, validated by their rules.

### Desktop size changes

The server follows the desktop size (`rdp-connect`, legacy reactivation, GFX RESETGRAPHICS; IPC `desktop`).
For `DESKTOP_CHANGE_GRACE_MS` after a change, `mouse` / `wheel` coordinates up to the larger of the old and
the new size are accepted and clamped to the new desktop (events the browser sent before it saw the
change are not invalid); afterwards only the current size is valid.

## Permissions

Rights come from `GetNodeWithRights` as today (`MESHRIGHT_REMOTECONTROL` required, `checkRelayRights`
for a relay device). Enforced on the server; the browser hides controls only for convenience.

| Message / option | full control | limited input | view-only |
|---|---|---|---|
| `mouse`, `wheel` | yes | yes | dropped |
| `scancode` | yes | only the allowed key set (as today in `CreateMstscRelay`) | dropped |
| `unicode`, `utype` | yes | dropped | dropped |
| `sync` | yes | yes | dropped |
| `clipboard` (browser → remote) | yes | dropped | dropped |
| `rdp-clipboard` (remote → browser) | yes | yes | yes |
| `resize` | yes | yes | dropped (the browser scales the image) |
| `visibility`, `ack`, `gfx-ack` | yes | yes | yes |
| `infos.options.alternateShell`, `workingDir` | used | ignored (empty) | ignored (empty) |
| `savepass`, `useServerCreds` | as today, `domain.allowsavingdevicecredentials` respected | same | same |

## Browser → server (JSON)

| Message | Arguments | Notes |
|---|---|---|
| `['infos', o]` | see below | first message |
| `['mouse', x, y, button, down]` | x: 0..width−1, y: 0..height−1 of the current desktop (see "Desktop size changes"); button: 0 move, 1 left, 2 right, 3 middle, 4 X1, 5 X2; down: bool (false for button 0) | |
| `['wheel', x, y, delta, horizontal]` | delta: −255..255, non-zero (positive = up / right); horizontal: bool | |
| `['scancode', code, down]` | code: 0x01..0x7F, or 0xE001..0xE07F for extended keys; down: bool | |
| `['unicode', unit, down]` | unit: UTF-16 code unit 0x0001..0xFFFF; down: bool | |
| `['utype', text]` | string ≤ `UTYPE_MAX_CHARS` (longer is rejected) | typed one unit per `UTYPE_INTERVAL_MS` by the main process; `\n` → Enter, `\r` skipped; replaces a pending text |
| `['sync', locks]` | 0..15: bit 0 Scroll Lock, 1 Num Lock, 2 Caps Lock, 3 Kana (TS_SYNC_EVENT) | sent on focus |
| `['clipboard', text]` | string, UTF-16LE size with terminator ≤ `CLIPBOARD_MAX_BYTES` | |
| `['resize', width, height]` | `DESKTOP_MIN_DIM..DESKTOP_MAX_DIM`, width even | latest wins; ignored without a DISP channel (MS-RDPEDISP, both modes). The engine paces the requests (one outstanding, at least 500 ms apart, at most 6 per minute) and fits them to the server's limits; the size that counts is the one the server applies (`rdp-resize` / RESETGRAPHICS) |
| `['visibility', visible]` | bool | false → Suppress Output, true → allow + Refresh Rect |
| `['gfx-ack', frameId, queueDepth]` | frameId: 0..0xFFFFFFFF; queueDepth: 0..0xFFFFFFFE (bytes) | rules in Flow control |
| `['ack', total]` | 0..2^53−1, cumulative bytes | rules in Flow control |
| `['client-error', code]` | one of `TRUNCATED`, `INVALID`, `LIMIT`, `UNSUPPORTED`, `INTERNAL` | session ends with `RDP_ERROR_CLIENT_DECODE` (detail = code) |
| `['ping']`, `['pong']` | — | keep-alive through the agent control channel, as today |
| `['disconnect']` | — | clean close |

### `infos`

```js
['infos', {
  ip: string,                 // required, 1..IP_FIELD_MAX_CHARS: 'node/<domain>/<id>' or the encrypted login cookie
  port: any,                  // ignored; the port comes from the device or the cookie
  screen: { width, height },  // required, DESKTOP_MIN_DIM..DESKTOP_MAX_DIM; an odd width is rounded down
  domain: string,             // default ''; each credential ≤ CREDENTIAL_FIELD_MAX_CHARS (255),
  username: string,           //   longer is rejected (never truncated)
  password: string,
  locale: string,             // default 'en-US'; ≤ LOCALE_MAX_CHARS, /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/
  options: {                  // default {}; every field optional
    savepass: bool,           // default false
    useServerCreds: bool,     // default false
    flags: int,               // TS_PERF_* performance flags, 0..0x1FF, default 0
    gfx: 'legacy' | 'gfx' | 'h264',   // requested graphics mode, default 'gfx'; the server clamps it to 'legacy' when settings.webRdp.gfx is "off"
    bpp: 15 | 16 | 24 | 32,   // legacy only, default 32
    workingDir: string,       // ≤ INFO_FIELD_MAX_CHARS, default ''; see Permissions
    alternateShell: string,   // ≤ INFO_FIELD_MAX_CHARS, default ''; see Permissions
    browser: {                // capability report, measured before connecting; default: nothing supported
      h264: { ok: bool, decodeMs: number },   // decodeMs finite, 0..60000; Avc420Decoder.probe() result
      avc444: { ok: bool, decodeMs: number }, // default { ok: false, decodeMs: 0 }; Avc444Decoder.probe() result (one stream per layout decoded, views combined, pixels checked); needs h264.ok; ignored when settings.webRdp.h264 is false
      offscreenCanvas: bool,
      rfx: bool               // default false; the worker's RemoteFX self-test passed (RfxDecoder.probe); honoured only with settings.webRdp.gfx = "dev"
    }
  }
}]
```

- Unknown keys are ignored. A wrong type or range in a known key makes `infos` invalid: the server
  sends `['rdp-error', { code: 'RDP_ERROR_CLIENT_PROTOCOL' }]` and closes.
- Credentials are moved out of the message object right after validation (IPC.md "Credentials");
  they are never echoed, logged or stored except by `savepass` as today.
- Unset/null or `true` `settings.webRdp.gfx` means `"on"`, `false` means `"off"`. Strings `"on"|"off"|"dev"` are case-insensitive. Every other value means `"off"`, with one warning per server process when settings are resolved (including startup).
- `settings.webRdp.gfx` is enforced by the server, whatever the browser sends: `"on"` (default) accepts `options.gfx` as sent,
  `"off"` replaces it with `'legacy'` (no GFX channel is ever offered), `"dev"` is `"on"` and additionally honours `browser.rfx`. A browser that
  fails before the first picture of a GFX session may open a new connection with `options.gfx = 'legacy'` (rdp/IPC.md is not involved:
  each connection is an independent session).
- The graphics mode and capability sets are chosen by the server from
  `options.gfx`, `options.browser` and `GFX_CAPSETS_ALLOWED`. Set B (8.1 + AVC420) requires
  `gfx == 'h264'` and `browser.h264.ok`. Set D (10.4, AVC444 / AVC444v2) additionally requires `browser.avc444.ok`, so Windows then sends H.264 instead of
  ClearCodec + Progressive. `settings.webRdp.h264 = false` (server setting, default true) clamps `gfx: 'h264'` to `'gfx'` and clears `h264.ok` and `avc444.ok`:
  no AVC capability set is then offered whatever the browser reports.

## Server → browser (JSON)

| Message | Arguments |
|---|---|
| `['rdp-connect', o]` | `{ wire: 1, width, height, mode: 'legacy' \| 'gfx', gfx: null \| { capsVersion, flags } }` |
| `['rdp-resize', o]` | `{ width, height }`: legacy desktop size changed (Deactivate-All / reactivation). The browser resets legacy decoder state (RemoteFX, NSCodec); the pointer cache is **kept** (xrdp refers to shapes set before the reactivation). In GFX mode resizes arrive in-band as RESETGRAPHICS, except when the server restarts the graphics pipeline (xrdp: Deactivate-All, the RDPGFX channel is closed and created again): then `rdp-resize` is sent after the new pipeline is confirmed and before any of its frames, and the browser drops every GFX object (surfaces, caches, encoding contexts, decoders) and starts with an empty client of the given size |
| `['rdp-clipboard', text]` | remote clipboard text changed |
| `['rdp-error', o]` | `{ code, detail?, phase?, hint?, cert? }`, then the websocket closes. `code`: `RDP_ERROR_*`; `detail`: symbolic name or `0xXXXXXXXX`; `phase`: `PHASE` value; `hint`: fixed hint id. All validated by `RdpError`. `cert`: only with `RDP_ERROR_CERT_CHANGED`, `{ expected: 'AA:..:FF' \| null, actual: 'AA:..:FF' }`, the pinned and the presented SHA-256 fingerprint (public values), shown to the user next to the error |
| `['rdp-close']` | clean end (logoff, disconnect by the user), then the websocket closes |
| `['ping']`, `['pong']` | as today |

The browser shows the translated text for `code` (and `hint`); `detail` only in small print.

## Server → browser (binary)

All frames are validated by the server before sending and re-validated by the browser, which is
also a target of a malicious RDP server. Order is preserved within and across frames.

### `0x01` BITMAP (legacy bitmap update)

```
u8   type = 0x01
u8   reserved = 0
u16  count                         1..BITMAP_MAX_RECTS
count × {
  u8   codec                       WIRE_BITMAP_CODEC: 0 raw, 1 interleaved RLE, 2 planar
  u8   bpp                         raw: 15, 16, 24, 32; interleaved: 15, 16, 24; planar: 32
  u8   flags                       WIRE_BITMAP_FLAG.BOTTOM_UP: raw rows stored bottom-up
  u8   reserved = 0
  u16  destLeft, destTop           top-left of the rectangle on the desktop
  u16  width, height               visible size, 1..BITMAP_MAX_DIM; destLeft+width ≤ desktop width, same for height
  u16  bitmapWidth, bitmapHeight   encoded size, ≥ width/height, 1..BITMAP_MAX_DIM
  u32  length                      payload bytes
  u8   payload[length]             TS_BITMAP_DATA bitmapDataStream without the compression header
}
```

The server converts TS_BITMAP_DATA (inclusive right/bottom) to this form and does not decode.
Rectangle header: 20 bytes. The frame stays below `WIRE_BATCH_MAX_BYTES` unless it carries a single
rectangle.

### `0x02` SURFACE_BITS (legacy surface commands, MS-RDPBCGR 2.2.9.2.1 / 2.2.9.2.2)

```
u8   type = 0x02
u8   codec                         WIRE_SURFACE_CODEC: 1 RemoteFX, 2 NSCodec
u16  reserved = 0
u16  destLeft, destTop             target rectangle on the desktop (right/bottom exclusive)
u16  destRight, destBottom         destRight > destLeft, ≤ desktop width; same for bottom
u8   bpp                           TS_BITMAP_DATA_EX.bpp (32)
u8   flags = 0
u16  reserved = 0
u16  width, height                 TS_BITMAP_DATA_EX width/height, 1..BITMAP_MAX_DIM
u32  length                        payload bytes
u8   payload[length]               TS_BITMAP_DATA_EX.bitmapData (exTsHeader removed)
```

- Set Surface Bits and Stream Surface Bits map to the same frame.
- Frame Marker commands are consumed by the server: the client does not advertise the Frame
  Acknowledge capability, flow control uses the byte window below.
- RemoteFX output rectangles are clipped by the decoder to the target rectangle and the desktop.
- The server advertises Surface Commands and Bitmap Codecs only for codecs whose decoders exist, only in legacy mode at 32 bpp, and
  only when `infos.options.browser.rfx` is true **and** the server runs the Web-RDP developer setting (`settings.webRdp.gfx = "dev"`):
  with "on" (default) and "off" the server drops `browser.rfx`, so legacy mode keeps plain bitmap updates. Only RemoteFX is advertised; NSCodec is not offered yet.

### `0x10` GFX

```
u8   type = 0x10
...  one or more complete RDPGFX PDUs, each with its RDPGFX_HEADER (cmdId u16, flags u16, pduLength u32)
```

- PDUs are ZGFX-decompressed, reassembled from the DVC and validated by the server state machine: `pduLength` fits the frame; surfaces, rectangles, cache slots and codec ids are within limits
  and refer to live objects; STARTFRAME/ENDFRAME are properly paired. Drawing operations
  (WIRETOSURFACE_1/2, SOLIDFILL, SURFACETOSURFACE, SURFACETOCACHE, CACHETOSURFACE) must be inside a
  frame. The legality of management operations (RESETGRAPHICS, CREATE/DELETESURFACE,
  MAPSURFACETOOUTPUT, DELETEENCODINGCONTEXT, EVICTCACHEENTRY) inside and outside frames is defined
  in rdp/GFX-CAPS.md, following MS-RDPEGFX and its test suite sequences.
- Only `GFX_FORWARDED` cmdIds are sent. CAPSCONFIRM is consumed by the server (version and flags go
  to `rdp-connect.gfx`); CACHEIMPORTREPLY never occurs (no cache import offer is sent); window and
  scaled mapping are rejected (no allowed capability set requires them).
- A PDU is never split across frames. A frame carrying several PDUs stays below `WIRE_BATCH_MAX_BYTES`.
- The engine batches consecutive PDUs (also from several DVC messages) into one frame: at most one END_FRAME per frame, and
  it is the frame's last PDU, so a `gfx-ack` / `endOffset` pair still belongs to exactly one frame; a PDU that would take a frame
  above `WIRE_BATCH_MAX_BYTES` starts the next frame, a PDU above it travels alone. The engine posts at most
  `ENGINE_OUT_FRAMES_PER_SECOND` frames per second (burst `ENGINE_OUT_FRAME_BURST`); more wait (backpressure, nothing is dropped).

### `0x20` POINTER

```
u8   type = 0x20
u8   kind                              WIRE_POINTER
kind 0 HIDDEN                          (no more bytes)
kind 1 SYSTEM_DEFAULT                  (no more bytes)
kind 2 SET:      u16 cacheIndex        0..POINTER_CACHE_MAX_ENTRIES−1, or 0xFFFF = do not cache
                 u16 hotX, hotY        < width, < height
                 u16 width, height     1..POINTER_MAX_DIM
                 u8  rgba[width*height*4]   unpremultiplied RGBA, rows top-down
kind 3 CACHED:   u16 cacheIndex        an index set earlier in this activation
kind 4 POSITION: u16 x, y              server moved the pointer
```

Pointer shapes are converted to RGBA in the engine (XOR/AND masks, 1–32 bpp, large pointers): small,
bounded work that keeps the browser simple. The pointer cache survives `rdp-resize` and a
reactivation. The browser renders shapes as CSS `cursor: url(...) hotX hotY`.

## Flow control

Every stage has a byte budget; when it is full the previous stage stops reading. GFX and bitmap data
are never dropped (they depend on surface and codec state).

### Byte window (both modes)

- The server counts `sent` = total bytes of binary frames handed to the websocket.
- The browser counts `processed` = total bytes of binary frames whose every operation has been
  applied: decoded, drawn into its surface and, for surfaces mapped to the output, composed onto the
  visible canvas (including `VideoDecoder` output). Frames are processed strictly in order.
- The browser sends `['ack', processed]` when `processed` grew by `ACK_MIN_INTERVAL_BYTES`, or
  `ACK_MAX_DELAY_MS` after the last growth while `processed` > last ack.
- The server accepts an `ack` only if `total` is a safe integer, ≥ the previous ack and ≤ `sent`;
  otherwise the session ends with `RDP_ERROR_CLIENT_PROTOCOL`.
- The server sends the next frame only while `sent − acked < WINDOW_BYTES`, so at most
  `WINDOW_BYTES + WIRE_FRAME_MAX_BYTES` are un-acked. Credit is released per processed frame, not per
  logical GFX frame, so a large GFX frame never deadlocks the window.
- Browser hard limit: received − processed > `BROWSER_PENDING_MAX_BYTES` → immediately
  `['client-error', 'LIMIT']` (checked on receipt in the UI thread before handing data to the worker,
  and again in the worker). No timer is involved.

### GFX frame acknowledgements

- For every END_FRAME the server records `{ frameId, endOffset }`, where `endOffset` is the `sent`
  value after the frame that carries the END_FRAME.
- The browser sends `['gfx-ack', frameId, queueDepth]` when END_FRAME of that frame has been
  processed (as defined above), **before** the `ack` whose total reaches `endOffset`.
  `queueDepth` = received − processed bytes, at most 0xFFFFFFFE; `SUSPEND_FRAME_ACKNOWLEDGEMENT`
  (0xFFFFFFFF) is never sent.
- The server (engine, IPC.md "ACK validation") accepts a `gfx-ack` only for the **oldest** recorded frame, once. Anything else
  (unknown, duplicate, out of order, a frame whose END_FRAME was not sent) → `RDP_ERROR_CLIENT_PROTOCOL`.
  An `ack` reaching the `endOffset` of a frame without its `gfx-ack` → `RDP_ERROR_CLIENT_PROTOCOL`.
- On acceptance the server sends RDPGFX_FRAME_ACKNOWLEDGE_PDU with `queueDepth` (0 =
  `QUEUE_DEPTH_UNAVAILABLE`) and `totalFramesDecoded` = number of accepted `gfx-ack`s since the GFX
  channel opened (not reset by RESETGRAPHICS; a reopened channel starts at zero with an empty ledger).
  frameIds are compared for equality only, so wrapping is harmless; `totalFramesDecoded` is a u32 and
  wraps modulo 2^32 like the field.
- There is no separate GFX ack deadline: a missing `gfx-ack` blocks the `ack` that would cover its
  END_FRAME, so the stall rule below applies to it.
- More than `GFX_MAX_UNACKED_FRAMES` recorded frames → the engine stops producing frames and stops
  acknowledging `net` input until acks arrive (backpressure, not an error).

### Stall

- The websocket reports progress per completed write only, so a large frame on a slow link shows
  none for a long time. The deadline therefore grows with the data in flight:
  stall when `sent > acked` and the `ack` total has not increased for
  `STALL_TIMEOUT_MS + 1000 × (sent − acked) / STALL_MIN_BYTES_PER_SECOND` ms
  → `RDP_ERROR_CLIENT_STALLED`. A maximal frame (32 MiB) at 32 KiB/s gets about 17 minutes.
- The engine acknowledges `out` frames to the main process in batches (one `out-ack` per event loop turn).
- `['visibility', false]` → Suppress Output; the browser keeps processing and acknowledging data
  already in flight.

## Compatibility

- Version 1 replaces the node-rdpjs format (`rdp-bitmap` JSON + raw binary). The old
  `public/mstsc/*` client is not compatible and is removed with node-rdpjs.
- `rdp-connect.wire` carries `WIRE_VERSION`. A browser that does not know the version shows an error
  asking to reload the page.
