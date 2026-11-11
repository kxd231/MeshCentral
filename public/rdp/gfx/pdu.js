/**
* @description Browser parser of the RDPGFX PDUs inside a WIRE.GFX frame (MS-RDPEGFX 2.2.2), strict lengths, no pixel work
* @license Apache-2.0
*
* The server validated the PDUs, but the browser is a target of a malicious server too: every length is checked again
* and anything not in GFX_FORWARDED is refused. Throws CodecError only. Rectangles are right/bottom exclusive on the
* wire and returned as { x, y, width, height }; state-dependent checks (live surfaces, bounds) belong to the client.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('../shared/constants.js'), require('../codecs/errors.js'));
    } else {
        root.RdpGfx = root.RdpGfx || {};
        root.RdpGfx.pdu = factory(root.RdpShared.limits, root.RdpShared.constants, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, constants, codecErrors) {
    'use strict';
    const CodecError = codecErrors.CodecError;
    const C = constants.GFX_CMD;
    const HEADER = constants.GFX_HEADER_SIZE;
    const FORWARDED = new Set(constants.GFX_FORWARDED);
    const RESET_PDU_BYTES = 340;
    const MAX_MONITORS = 16;

    function parseRect(dv, pos) {
        const left = dv.getUint16(pos, true), top = dv.getUint16(pos + 2, true), right = dv.getUint16(pos + 4, true), bottom = dv.getUint16(pos + 6, true);
        if ((right <= left) || (bottom <= top)) { throw new CodecError('INVALID', 'empty rectangle'); }
        return { x: left, y: top, width: right - left, height: bottom - top };
    }

    function need(size, n, what) { if (size !== n) { throw new CodecError((size < n) ? 'TRUNCATED' : 'INVALID', what + ' length'); } }

    function pixelFormat(v) {
        if ((v !== constants.GFX_PIXEL_FORMAT.XRGB_8888) && (v !== constants.GFX_PIXEL_FORMAT.ARGB_8888)) { throw new CodecError('INVALID', 'pixel format'); }
        return v;
    }

    // buf: Uint8Array holding PDUs back to back; pos: offset of the next header.
    // → { cmd: { id, size, ... }, next } where next is the offset after the PDU
    function parseNext(buf, pos) {
        if (buf.length - pos < HEADER) { throw new CodecError('TRUNCATED', 'PDU header'); }
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const id = dv.getUint16(pos, true), flags = dv.getUint16(pos + 2, true), size = dv.getUint32(pos + 4, true);
        if (flags !== 0) { throw new CodecError('INVALID', 'PDU flags'); }
        if (size < HEADER) { throw new CodecError('INVALID', 'PDU length'); }
        if (size > limits.GFX_PDU_MAX_BYTES) { throw new CodecError('LIMIT', 'PDU length'); }
        if (size > buf.length - pos) { throw new CodecError('TRUNCATED', 'PDU body'); }
        if (!FORWARDED.has(id)) { throw new CodecError('INVALID', 'PDU type'); }
        const b = pos + HEADER, body = size - HEADER;
        const cmd = { id: id, size: size };
        switch (id) {
            case C.CREATESURFACE:
                need(body, 7, 'CreateSurface');
                cmd.surfaceId = dv.getUint16(b, true); cmd.width = dv.getUint16(b + 2, true); cmd.height = dv.getUint16(b + 4, true);
                cmd.pixelFormat = pixelFormat(dv.getUint8(b + 6));
                if ((cmd.width < 1) || (cmd.height < 1)) { throw new CodecError('INVALID', 'surface size'); }
                break;
            case C.DELETESURFACE:
                need(body, 2, 'DeleteSurface');
                cmd.surfaceId = dv.getUint16(b, true);
                break;
            case C.STARTFRAME:
                need(body, 8, 'StartFrame');
                cmd.timestamp = dv.getUint32(b, true); cmd.frameId = dv.getUint32(b + 4, true);
                break;
            case C.ENDFRAME:
                need(body, 4, 'EndFrame');
                cmd.frameId = dv.getUint32(b, true);
                break;
            case C.MAPSURFACETOOUTPUT:
                need(body, 12, 'MapSurfaceToOutput');
                cmd.surfaceId = dv.getUint16(b, true);
                if (dv.getUint16(b + 2, true) !== 0) { throw new CodecError('INVALID', 'MapSurfaceToOutput reserved'); }
                cmd.x = dv.getUint32(b + 4, true); cmd.y = dv.getUint32(b + 8, true);
                break;
            case C.RESETGRAPHICS: {
                if (size !== RESET_PDU_BYTES) { throw new CodecError((size < RESET_PDU_BYTES) ? 'TRUNCATED' : 'INVALID', 'ResetGraphics length'); }
                cmd.width = dv.getUint32(b, true); cmd.height = dv.getUint32(b + 4, true);
                const count = dv.getUint32(b + 8, true);
                if (count > MAX_MONITORS) { throw new CodecError('LIMIT', 'monitor count'); }
                if ((cmd.width < limits.DESKTOP_MIN_DIM) || (cmd.height < limits.DESKTOP_MIN_DIM) ||
                    (cmd.width > limits.DESKTOP_MAX_DIM) || (cmd.height > limits.DESKTOP_MAX_DIM)) { throw new CodecError('LIMIT', 'desktop size'); }
                if (cmd.width * cmd.height > limits.SURFACES_MAX_PIXELS) { throw new CodecError('LIMIT', 'desktop pixels'); }
                // The monitor definitions are validated like the server does (rdp/gfx/rdpgfx.js): the browser does not trust it
                let primary = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < count; i++) {
                    const m = b + 12 + (i * 20);
                    const left = dv.getInt32(m, true), top = dv.getInt32(m + 4, true), right = dv.getInt32(m + 8, true), bottom = dv.getInt32(m + 12, true), flags = dv.getUint32(m + 16, true);
                    if ((left > right) || (top > bottom) || (right - left + 1 > cmd.width) || (bottom - top + 1 > cmd.height) || ((flags & ~1) !== 0)) { throw new CodecError('INVALID', 'monitor definition'); }
                    if ((Math.abs(left) > limits.DESKTOP_MAX_DIM) || (Math.abs(top) > limits.DESKTOP_MAX_DIM) || (Math.abs(right) > limits.DESKTOP_MAX_DIM) || (Math.abs(bottom) > limits.DESKTOP_MAX_DIM)) { throw new CodecError('LIMIT', 'monitor position'); }
                    if ((flags & 1) !== 0) { if ((left !== 0) || (top !== 0) || (++primary > 1)) { throw new CodecError('INVALID', 'primary monitor'); } }
                    minX = Math.min(minX, left); minY = Math.min(minY, top); maxX = Math.max(maxX, right); maxY = Math.max(maxY, bottom);
                }
                if ((count > 0) && ((primary !== 1) || (maxX - minX + 1 > cmd.width) || (maxY - minY + 1 > cmd.height))) { throw new CodecError('INVALID', 'monitor layout'); }
                cmd.monitors = count;
                break;
            }
            case C.SOLIDFILL: {
                if (body < 8) { throw new CodecError('TRUNCATED', 'SolidFill'); }
                cmd.surfaceId = dv.getUint16(b, true);
                // RDPGFX_COLOR32: B, G, R, XA
                cmd.color = { b: buf[b + 2], g: buf[b + 3], r: buf[b + 4], a: buf[b + 5] };
                const n = dv.getUint16(b + 6, true);
                need(body, 8 + (n * 8), 'SolidFill');
                cmd.rects = new Array(n);
                for (let i = 0; i < n; i++) { cmd.rects[i] = parseRect(dv, b + 8 + (i * 8)); }
                break;
            }
            case C.SURFACETOSURFACE: {
                if (body < 14) { throw new CodecError('TRUNCATED', 'SurfaceToSurface'); }
                cmd.srcId = dv.getUint16(b, true); cmd.dstId = dv.getUint16(b + 2, true);
                cmd.src = parseRect(dv, b + 4);
                const n = dv.getUint16(b + 12, true);
                need(body, 14 + (n * 4), 'SurfaceToSurface');
                cmd.points = new Array(n);
                for (let i = 0; i < n; i++) { cmd.points[i] = { x: dv.getUint16(b + 14 + (i * 4), true), y: dv.getUint16(b + 16 + (i * 4), true) }; }
                break;
            }
            case C.SURFACETOCACHE:
                need(body, 20, 'SurfaceToCache');
                cmd.surfaceId = dv.getUint16(b, true);
                cmd.slot = dv.getUint16(b + 10, true);
                if ((cmd.slot < 1) || (cmd.slot > limits.GFX_CACHE_MAX_SLOTS)) { throw new CodecError('INVALID', 'cache slot'); }
                cmd.src = parseRect(dv, b + 12);
                break;
            case C.CACHETOSURFACE: {
                if (body < 6) { throw new CodecError('TRUNCATED', 'CacheToSurface'); }
                cmd.slot = dv.getUint16(b, true); cmd.surfaceId = dv.getUint16(b + 2, true);
                if ((cmd.slot < 1) || (cmd.slot > limits.GFX_CACHE_MAX_SLOTS)) { throw new CodecError('INVALID', 'cache slot'); }
                const n = dv.getUint16(b + 4, true);
                need(body, 6 + (n * 4), 'CacheToSurface');
                cmd.points = new Array(n);
                for (let i = 0; i < n; i++) { cmd.points[i] = { x: dv.getUint16(b + 6 + (i * 4), true), y: dv.getUint16(b + 8 + (i * 4), true) }; }
                break;
            }
            case C.EVICTCACHEENTRY:
                need(body, 2, 'EvictCacheEntry');
                cmd.slot = dv.getUint16(b, true);
                if ((cmd.slot < 1) || (cmd.slot > limits.GFX_CACHE_MAX_SLOTS)) { throw new CodecError('INVALID', 'cache slot'); }
                break;
            case C.DELETEENCODINGCONTEXT:
                need(body, 6, 'DeleteEncodingContext');
                cmd.surfaceId = dv.getUint16(b, true); cmd.contextId = dv.getUint32(b + 2, true);
                break;
            case C.WIRETOSURFACE_1: {
                if (body < 17) { throw new CodecError('TRUNCATED', 'WireToSurface1'); }
                cmd.surfaceId = dv.getUint16(b, true); cmd.codecId = dv.getUint16(b + 2, true);
                cmd.pixelFormat = pixelFormat(dv.getUint8(b + 4));
                cmd.dest = parseRect(dv, b + 5);
                const n = dv.getUint32(b + 13, true);
                if (n !== body - 17) { throw new CodecError((n > body - 17) ? 'TRUNCATED' : 'INVALID', 'WireToSurface1 data length'); }
                if (n < 1) { throw new CodecError('INVALID', 'WireToSurface1 empty data'); }
                cmd.data = buf.subarray(b + 17, b + 17 + n);
                break;
            }
            case C.WIRETOSURFACE_2: {
                if (body < 13) { throw new CodecError('TRUNCATED', 'WireToSurface2'); }
                cmd.surfaceId = dv.getUint16(b, true); cmd.codecId = dv.getUint16(b + 2, true);
                cmd.contextId = dv.getUint32(b + 4, true);
                cmd.pixelFormat = pixelFormat(dv.getUint8(b + 8));
                const n = dv.getUint32(b + 9, true);
                if (n !== body - 13) { throw new CodecError((n > body - 13) ? 'TRUNCATED' : 'INVALID', 'WireToSurface2 data length'); }
                cmd.data = buf.subarray(b + 13, b + 13 + n);
                break;
            }
            default: throw new CodecError('INVALID', 'PDU type');
        }
        return { cmd: cmd, next: pos + size };
    }

    return Object.freeze({ parseNext: parseNext, RESET_PDU_BYTES: RESET_PDU_BYTES });
});
