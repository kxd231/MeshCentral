/**
* @description Web-RDP protocol constants shared by the server engine and the browser worker
* @license Apache-2.0
*
* Contract file: shared by the server and the browser; change code and documentation (rdp/WIRE.md) together.
* RDPGFX values are from MS-RDPEGFX (2.2.1.1, 2.2.1.2, 2.2.3, 2.2.2.13), checked by the unit tests.
* WIRE values define the binary frames between server and browser, see rdp/WIRE.md.
* Usable from Node (require) and from a browser worker (importScripts → self.RdpShared.constants).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(); }
    else { root.RdpShared = root.RdpShared || {}; root.RdpShared.constants = factory(); }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';

    // Version of the browser ⇄ server protocol in rdp/WIRE.md
    const WIRE_VERSION = 1;

    // First byte of every binary websocket frame (server → browser). The browser never sends binary frames.
    const WIRE = Object.freeze({
        BITMAP: 0x01,           // legacy bitmap update rectangles (raw, interleaved RLE, planar)
        SURFACE_BITS: 0x02,     // legacy surface commands (RemoteFX, NSCodec)
        GFX: 0x10,              // one or more complete, validated, decompressed RDPGFX PDUs
        POINTER: 0x20           // pointer shape, cached pointer, visibility, position
    });

    // Codec byte of a BITMAP rectangle
    const WIRE_BITMAP_CODEC = Object.freeze({ RAW: 0, INTERLEAVED: 1, PLANAR: 2 });

    // Codec byte of a SURFACE_BITS frame. The server maps the codec ids it assigned in the Bitmap
    // Codecs capability set to these values. Uncompressed surface bits are never advertised.
    const WIRE_SURFACE_CODEC = Object.freeze({ REMOTEFX: 1, NSCODEC: 2 });

    // Flags byte of a BITMAP rectangle
    const WIRE_BITMAP_FLAG = Object.freeze({ BOTTOM_UP: 0x01 });

    // Kind byte of a POINTER frame
    const WIRE_POINTER = Object.freeze({ HIDDEN: 0, SYSTEM_DEFAULT: 1, SET: 2, CACHED: 3, POSITION: 4 });
    const WIRE_POINTER_NO_CACHE = 0xFFFF;

    // RDPGFX_HEADER.cmdId (MS-RDPEGFX 2.2.1.5)
    const GFX_CMD = Object.freeze({
        WIRETOSURFACE_1: 0x0001,
        WIRETOSURFACE_2: 0x0002,
        DELETEENCODINGCONTEXT: 0x0003,
        SOLIDFILL: 0x0004,
        SURFACETOSURFACE: 0x0005,
        SURFACETOCACHE: 0x0006,
        CACHETOSURFACE: 0x0007,
        EVICTCACHEENTRY: 0x0008,
        CREATESURFACE: 0x0009,
        DELETESURFACE: 0x000A,
        STARTFRAME: 0x000B,
        ENDFRAME: 0x000C,
        FRAMEACKNOWLEDGE: 0x000D,
        RESETGRAPHICS: 0x000E,
        MAPSURFACETOOUTPUT: 0x000F,
        CACHEIMPORTOFFER: 0x0010,
        CACHEIMPORTREPLY: 0x0011,
        CAPSADVERTISE: 0x0012,
        CAPSCONFIRM: 0x0013,
        MAPSURFACETOWINDOW: 0x0015,
        QOEFRAMEACKNOWLEDGE: 0x0016,
        MAPSURFACETOSCALEDOUTPUT: 0x0017,
        MAPSURFACETOSCALEDWINDOW: 0x0018
    });

    // RDPGFX_HEADER size: cmdId (2) + flags (2) + pduLength (4)
    const GFX_HEADER_SIZE = 8;

    // Server → client cmdIds the server forwards to the browser inside a WIRE.GFX frame.
    // Everything else (CapsConfirm, CacheImportReply, RAIL window mapping, scaled mapping) is
    // handled or rejected by the server and never reaches the browser.
    const GFX_FORWARDED = Object.freeze([
        GFX_CMD.WIRETOSURFACE_1, GFX_CMD.WIRETOSURFACE_2, GFX_CMD.DELETEENCODINGCONTEXT, GFX_CMD.SOLIDFILL,
        GFX_CMD.SURFACETOSURFACE, GFX_CMD.SURFACETOCACHE, GFX_CMD.CACHETOSURFACE, GFX_CMD.EVICTCACHEENTRY,
        GFX_CMD.CREATESURFACE, GFX_CMD.DELETESURFACE, GFX_CMD.STARTFRAME, GFX_CMD.ENDFRAME,
        GFX_CMD.RESETGRAPHICS, GFX_CMD.MAPSURFACETOOUTPUT
    ]);

    // codecId of WireToSurface1/2 (MS-RDPEGFX 2.2.2.1, 2.2.2.2)
    const GFX_CODEC = Object.freeze({
        UNCOMPRESSED: 0x0000,
        CAVIDEO: 0x0003,        // RemoteFX
        CLEARCODEC: 0x0008,
        CAPROGRESSIVE: 0x0009,  // only in WireToSurface2
        PLANAR: 0x000A,
        AVC420: 0x000B,
        ALPHA: 0x000C,
        AVC444: 0x000E,
        AVC444v2: 0x000F
    });

    // RDPGFX pixelFormat (MS-RDPEGFX 2.2.1.4)
    const GFX_PIXEL_FORMAT = Object.freeze({ XRGB_8888: 0x20, ARGB_8888: 0x21 });

    // RDPGFX_CAPSET.version (MS-RDPEGFX 2.2.3)
    const GFX_CAPVERSION = Object.freeze({
        V8: 0x00080004,
        V81: 0x00080105,
        V10: 0x000A0002,
        V101: 0x000A0100,
        V102: 0x000A0200,
        V103: 0x000A0301,
        V104: 0x000A0400,
        V105: 0x000A0502,
        V106: 0x000A0600,
        V107: 0x000A0701
    });

    // RDPGFX_CAPSET flags (MS-RDPEGFX 2.2.3)
    const GFX_CAPS_FLAG = Object.freeze({
        THINCLIENT: 0x00000001,
        SMALL_CACHE: 0x00000002,
        AVC420_ENABLED: 0x00000010,
        AVC_DISABLED: 0x00000020,
        AVC_THINCLIENT: 0x00000040,
        SCALEDMAP_DISABLE: 0x00000080
    });

    // RDPGFX_FRAME_ACKNOWLEDGE_PDU.queueDepth special values (MS-RDPEGFX 2.2.2.13)
    const GFX_QUEUE_DEPTH = Object.freeze({ UNAVAILABLE: 0x00000000, SUSPEND_FRAME_ACKNOWLEDGEMENT: 0xFFFFFFFF });

    // Upper bound of the capability sets the client may ever advertise in WIRE version 1, in
    // preference order. A set from this list is advertised only when every codec and operation it
    // allows is implemented and tested (rdp/GFX-CAPS.md). Versions not listed are excluded:
    // 10.1 (no flags field, implies AVC444v2), 10.3 (no SMALL_CACHE flag), 10.5 and 10.6 (require
    // scaled output mapping, which is not forwarded), and 10.7. Set D is the only set that enables
    // AVC444 / AVC444v2: Windows 10 and 11 send H.264 only for a 10.4 set with AVC_THINCLIENT and without
    // AVC_DISABLED (then AVC444v2 exclusively); 10.x without AVC_THINCLIENT, and 8.1, give ClearCodec + Progressive.
    // `avc444: true` = needs the browser's AVC444 probe (infos.options.browser.avc444, rdp/WIRE.md) on top of `h264`.
    const GFX_CAPSETS_ALLOWED = Object.freeze([
        Object.freeze({ id: 'D', version: 0x000A0400, flags: 0x00000002 | 0x00000040, h264: true, avc444: true }),   // 10.4: SMALL_CACHE | AVC_THINCLIENT
        Object.freeze({ id: 'C', version: 0x000A0002, flags: 0x00000002 | 0x00000020 }),               // 10.0: SMALL_CACHE | AVC_DISABLED
        Object.freeze({ id: 'B', version: 0x00080105, flags: 0x00000002 | 0x00000010, h264: true }),   // 8.1: SMALL_CACHE | AVC420_ENABLED
        Object.freeze({ id: 'A', version: 0x00080004, flags: 0x00000002 })                             // 8.0: SMALL_CACHE
    ]);

    return Object.freeze({
        WIRE_VERSION: WIRE_VERSION,
        WIRE: WIRE,
        WIRE_BITMAP_CODEC: WIRE_BITMAP_CODEC,
        WIRE_SURFACE_CODEC: WIRE_SURFACE_CODEC,
        WIRE_BITMAP_FLAG: WIRE_BITMAP_FLAG,
        WIRE_POINTER: WIRE_POINTER,
        WIRE_POINTER_NO_CACHE: WIRE_POINTER_NO_CACHE,
        GFX_CMD: GFX_CMD,
        GFX_HEADER_SIZE: GFX_HEADER_SIZE,
        GFX_FORWARDED: GFX_FORWARDED,
        GFX_CODEC: GFX_CODEC,
        GFX_PIXEL_FORMAT: GFX_PIXEL_FORMAT,
        GFX_CAPVERSION: GFX_CAPVERSION,
        GFX_CAPS_FLAG: GFX_CAPS_FLAG,
        GFX_QUEUE_DEPTH: GFX_QUEUE_DEPTH,
        GFX_CAPSETS_ALLOWED: GFX_CAPSETS_ALLOWED
    });
});
