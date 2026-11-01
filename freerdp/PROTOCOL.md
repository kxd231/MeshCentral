# meshfreerdp ⇄ MeshCentral wire protocol

The `meshfreerdp` helper (C, libfreerdp3) talks to the MeshCentral server (`freerdpclient.js`)
only through **stdin** (MeshCentral → helper) and **stdout** (helper → MeshCentral). stderr carries
diagnostic text, which MeshCentral logs with `parent.debug('relay', ...)` (enable with `"debug": "relay"`).
The helper takes no command line arguments; credentials are never passed in argv or the environment.

## Frame

```
[u8 type][u32 LE length][payload: length bytes]
```

All multi-byte integers are **little-endian**. Text is UTF-8 without a terminator. The maximum `length`
is 64 MiB; a larger value is a protocol error and ends the session (ERROR/CLOSED).

## MeshCentral → helper (stdin)

| type | name | payload |
|------|------|---------|
| 0x81 | CONFIG | JSON (UTF-8). **Must be the first frame.** See below. |
| 0x82 | MOUSE | `u16 flags, u16 x, u16 y` (6 bytes). `flags` are FreeRDP `PTR_FLAGS_*`, computed by MeshCentral, including WHEEL/HWHEEL. Sent with `freerdp_input_send_mouse_event`. |
| 0x83 | KEY_SCANCODE | `u8 code, u8 down (0/1), u8 extended (0/1)` (3 bytes). Sent with `freerdp_input_send_keyboard_event_ex(input, down, FALSE, MAKE_RDP_SCANCODE(code, extended))`. |
| 0x84 | KEY_UNICODE | `u16 code, u8 down (0/1)` (3 bytes). Sent with `freerdp_input_send_unicode_keyboard_event`. |
| 0x85 | CLIPBOARD | UTF-8 text for the remote clipboard (cliprdr, CF_UNICODETEXT). |
| 0x86 | QUIT | Empty. The helper disconnects, sends CLOSED and exits with code 0. |

EOF on stdin behaves like QUIT, so the helper never outlives MeshCentral.
Input frames received before CONNECTED are ignored.

### CONFIG

```jsonc
{
  "host": "127.0.0.1",      // always the MeshCentral loopback relay
  "port": 51234,
  "domain": "", "username": "", "password": "",
  "width": 1024, "height": 768,
  "perfFlags": 0,           // optional, RDP PERF_* flags (MS-RDPBCGR 2.2.1.11.1.1.1)
  "workingDir": "",         // optional, FreeRDP_ShellWorkingDirectory
  "alternateShell": "",     // optional, FreeRDP_AlternateShell
  "keyboardLayout": 1033,   // optional KLID (0x409 en-US, 0x415 pl-PL, ...); 0 = default
  "jpegQuality": 75,        // optional, 1..100, default 75
  "gfx": true,              // optional, RDP graphics pipeline (rdpgfx), default true
  "h264": true,             // optional, H.264/AVC in GFX, default true; disabled if no decoder is available
  "colorDepth": 32          // optional, 15/16/24/32, only without GFX (GFX is always 32)
}
```

The helper connects with `ConnectionType=LAN` so that Windows honours `perfFlags`, and keeps network
auto-detect support enabled (Windows sends RTT requests with GFX).

### Mouse flags (MS-RDPBCGR 2.2.8.1.1.3.1.1.3)

```
PTR_FLAGS_HWHEEL         0x0400
PTR_FLAGS_WHEEL          0x0200
PTR_FLAGS_WHEEL_NEGATIVE 0x0100
WheelRotationMask        0x01FF   (9-bit two's complement, NEGATIVE is the sign bit)
PTR_FLAGS_MOVE           0x0800
PTR_FLAGS_DOWN           0x8000
PTR_FLAGS_BUTTON1        0x1000   (left)
PTR_FLAGS_BUTTON2        0x2000   (right)
PTR_FLAGS_BUTTON3        0x4000   (middle)
```

Mapping in `freerdpclient.js`:

- `sendPointerEvent(x, y, button, isPressed)`: button 1/2/3 → BUTTON1/2/3, otherwise MOVE; `isPressed` adds DOWN.
- `sendWheelEvent(x, y, step, isNegative, isHorizontal)`: HWHEEL or WHEEL; a negative `step` flips `isNegative`;
  `step` is capped at 255; flags `|= isNegative ? (WHEEL_NEGATIVE | ((-step) & 0xFF)) : (step & 0xFF)`.

### Scancodes

The browser sends `['scancode', code, down]` with extended keys as `0xE000 | scancode`
(57419 = 0xE04B = left arrow, 57435 = 0xE05B = left Windows key). MeshCentral sets
`extended = (code & 0xFF00) == 0xE000` and sends `code & 0xFF`.

## Helper → MeshCentral (stdout)

| type | name | payload |
|------|------|---------|
| 0x01 | CONNECTED | JSON `{"width":W,"height":H}`, the actual desktop size. Sent again after a server-side resize. |
| 0x02 | TILE | 9-byte header `u16 x, u16 y, u16 w, u16 h, u8 fmt`, then the image. `fmt=0`: raw RGBA, top-down, `w*h*4` bytes. `fmt=1`: baseline JPEG, 4:2:0. Tiles are at most 256×256; tiles with `w*h < 1024` are always raw. |
| 0x03 | POINTER | UTF-8 CSS `cursor` value: `"default"` or `"none"`. |
| 0x04 | CLIPBOARD | UTF-8, new remote clipboard text. |
| 0x05 | ERROR | JSON `{"code":<freerdp_get_last_error>,"name":"FREERDP_ERROR_..."}`. The name is FreeRDP's `ERRCONNECT_X`/`ERRINFO_X` label with the prefix replaced, e.g. `FREERDP_ERROR_LOGON_FAILURE`. |
| 0x06 | CLOSED | Empty. Always the last frame before the process exits, also after ERROR. |
| 0x07 | LOG | UTF-8, optional diagnostics. |

Order: CONNECTED → (TILE | POINTER | CLIPBOARD | CONNECTED)* → [ERROR] → CLOSED.
After each CONNECTED the helper sends the whole screen as tiles.

## MeshCentral → browser

For each TILE, the binary image is sent first (`ws.send(buffer)`), followed by:

```
['rdp-bitmap', { destLeft:x, destTop:y, destRight:x+w-1, destBottom:y+h-1, width:w, height:h, bitsPerPixel:32, isCompress:false, fmt }]
```

Other messages:

- `['rdp-connect', {width, height}]`: session established, actual desktop size.
- `['rdp-resize', {width, height}]`: the desktop size changed.
- `['rdp-pointer', css]`, `['rdp-clipboard', text]`, `['rdp-close']`.
- `['rdp-error', name, code]`, e.g. `['rdp-error', 'FREERDP_ERROR_AUTHENTICATION_FAILED', 131081]`.
  MeshCentral itself can send `FREERDP_HELPER_NOT_FOUND` and `FREERDP_HELPER_FAILED`.

Browser options (`infos.options`): `flags` (PERF_*), `gfx` (`'h264'`, `'gfx'` or `'legacy'`),
`quality` (50/75/90) and `bpp` (15/16/24/32). The relay only accepts these values and maps them to CONFIG.
