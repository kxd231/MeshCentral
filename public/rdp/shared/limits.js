/**
* @description Web-RDP limits shared by the server engine and the browser worker
* @license Apache-2.0
*
* Contract file: shared by the server and the browser; change code and documentation (rdp/WIRE.md) together.
* Every limit is checked BEFORE allocating memory. Exceeding one closes the session with
* RDP_ERROR_RESOURCE_LIMIT (server) or a CodecError 'LIMIT' (browser); it never grows a buffer.
* Usable from Node (require) and from a browser worker (importScripts → self.RdpShared.limits).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(); }
    else { root.RdpShared = root.RdpShared || {}; root.RdpShared.limits = factory(); }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';
    const KiB = 1024, MiB = 1024 * 1024;

    // One RDPGFX PDU after ZGFX decompression
    const GFX_PDU_MAX_BYTES = 32 * MiB;
    // One binary websocket frame (server → browser): the largest payload plus frame headers
    const WIRE_FRAME_MAX_BYTES = GFX_PDU_MAX_BYTES + 64;
    // Binary bytes the server may have sent but the browser not yet acknowledged (both modes).
    // Rule "send while in flight < window": the overshoot is at most one frame.
    const WINDOW_BYTES = 4 * MiB;
    // Clipboard text, UTF-16LE bytes including the terminating null
    const CLIPBOARD_MAX_BYTES = 4 * MiB;

    return Object.freeze({
        // Desktop and surfaces (MS-RDPEDISP allows 200..8192, width must be even)
        DESKTOP_MIN_DIM: 200,
        DESKTOP_MAX_DIM: 8192,
        SURFACE_MAX_DIM: 8192,
        SURFACE_MAX_COUNT: 64,
        SURFACES_MAX_PIXELS: 128 * MiB,             // sum of width*height over all live surfaces

        // RDPGFX cache. Every capability set we advertise bounds the server to 4096 slots and
        // 16 MiB (SMALL_CACHE flag, or implicit for the versions without the flag).
        GFX_CACHE_MAX_SLOTS: 4096,
        GFX_CACHE_MAX_BYTES: 16 * MiB,
        GFX_PROGRESSIVE_MAX_CONTEXTS: 64,           // live progressive codec contexts
        GFX_MAX_UNACKED_FRAMES: 1024,               // frames with END_FRAME sent and no gfx-ack yet

        GFX_PDU_MAX_BYTES: GFX_PDU_MAX_BYTES,
        WIRE_FRAME_MAX_BYTES: WIRE_FRAME_MAX_BYTES,
        WIRE_BATCH_MAX_BYTES: 1 * MiB,              // a frame carrying several PDUs or rectangles stays below this

        // Pointers
        POINTER_MAX_DIM: 384,
        POINTER_CACHE_MAX_ENTRIES: 32,

        // Legacy bitmap updates: one rectangle
        BITMAP_MAX_DIM: 8192,
        BITMAP_MAX_RECTS: 256,                      // rectangles in one BITMAP frame

        CLIPBOARD_MAX_BYTES: CLIPBOARD_MAX_BYTES,

        // Flow control (rdp/WIRE.md "Flow control")
        WINDOW_BYTES: WINDOW_BYTES,
        BROWSER_PENDING_MAX_BYTES: WINDOW_BYTES + WIRE_FRAME_MAX_BYTES,   // hard limit, checked on receipt
        ACK_MIN_INTERVAL_BYTES: 64 * KiB,           // browser sends ['ack'] at least this often ...
        ACK_MAX_DELAY_MS: 50,                       // ... or this long after processing, while anything is un-acked
        STALL_TIMEOUT_MS: 30000,                    // base deadline for an ack while data is un-acked (WIRE.md "Stall")
        STALL_MIN_BYTES_PER_SECOND: 32 * KiB,       // slowest link we wait for: the deadline grows by in-flight bytes / this rate

        // Browser memory (worker): retained decoder state, reserved through the decoder budget.
        // Worst case of one tab (a hostile server, own session only): surfaces up to SURFACES_MAX_PIXELS (512 MiB RGBA), this budget (256 MiB),
        // the GFX cache (16 MiB), the output canvas (up to 8192 x 8192 x 4 = 256 MiB), transient decode buffers (up to 256 MiB) and the frames
        // waiting to be applied (BROWSER_PENDING_MAX_BYTES, 36 MiB): about 1.3 GiB. Surfaces, canvas and transient buffers are not charged to this budget.
        BROWSER_CODEC_STATE_MAX_BYTES: 256 * MiB,
        AVC_MAX_PENDING_FRAMES: 4,                  // submitted to VideoDecoder, not yet drawn and closed

        // Browser → server messages
        CLIENT_MSG_MAX_BYTES: (12 * MiB) + (4 * KiB), // one websocket message: 2 Mi UTF-16 units of clipboard, each escaped as \uXXXX, plus the envelope
        CLIENT_INVALID_MAX: 3,                      // invalid messages in a row before the session is closed
        UTYPE_MAX_CHARS: 65536,
        UTYPE_INTERVAL_MS: 5,
        INPUT_MAX_EVENTS_PER_SECOND: 2000,          // mouse, wheel, keyboard; excess is dropped
        CONTROL_MAX_MESSAGES_PER_SECOND: 20,        // clipboard, resize, visibility, sync, ping; excess is dropped
        IP_FIELD_MAX_CHARS: 2048,                   // infos.ip (node id or encrypted cookie)
        // Client Info strings, UTF-16 units; 512 bytes including the terminator (MS-RDPBCGR 2.2.1.11.1.1).
        CREDENTIAL_FIELD_MAX_CHARS: 255,           // reject longer credentials, never truncate
        INFO_FIELD_MAX_CHARS: 255,                 // alternate shell, working directory
        LOCALE_MAX_CHARS: 35
    });
});
