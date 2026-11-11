/**
* @description Web-RDP browser: parser and validator of the binary frames in rdp/WIRE.md
* @license Apache-2.0
*
* The browser is a target of a malicious RDP server, so every field is validated against
* RdpShared.limits before anything is allocated. The parser reads no pixel data: it returns views
* into the frame for the worker to hand to the decoders. Throws CodecError only
* (TRUNCATED, INVALID, LIMIT), which the worker reports as ['client-error', code].
* BITMAP and POINTER are parsed here. GFX frames are accepted only when the caller says the session negotiated GFX
* (opts.gfx; the PDUs inside are parsed by gfx/pdu.js); SURFACE_BITS (legacy Surface Commands) only when the caller
* says the session advertised them (opts.surfaceBits), otherwise it is INVALID: the server must not send it to a client
* that did not ask.
* Usable from Node (require) and from a worker (importScripts → self.RdpClient.wireParser).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('./shared/limits.js'), require('./shared/constants.js'), require('./codecs/errors.js'));
    } else {
        root.RdpClient = root.RdpClient || {};
        root.RdpClient.wireParser = factory(root.RdpShared.limits, root.RdpShared.constants, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, constants, codecErrors) {
    'use strict';
    const CodecError = codecErrors.CodecError;
    const WIRE = constants.WIRE;
    const CODEC = constants.WIRE_BITMAP_CODEC;
    const POINTER = constants.WIRE_POINTER;

    const DECODED_AREA_FACTOR = 2; // client-side limits, not in the wire contract
    const MIN_PIXEL_BUDGET = limits.BITMAP_MAX_RECTS * 64 * 64; // 1 Mpx
    const BITMAP_HEADER_BYTES = 4;
    const BITMAP_RECT_HEADER_BYTES = 20;
    const POINTER_SET_HEADER_BYTES = 12; // type, kind, cacheIndex, hotX, hotY, width, height

    // Valid bpp per bitmap codec (rdp/WIRE.md 0x01 BITMAP)
    const BPP_BY_CODEC = {};
    BPP_BY_CODEC[CODEC.RAW] = [15, 16, 24, 32];
    BPP_BY_CODEC[CODEC.INTERLEAVED] = [15, 16, 24];
    BPP_BY_CODEC[CODEC.PLANAR] = [32];

    function toView(frame) {
        if (frame instanceof Uint8Array) { return frame; }
        if (frame instanceof ArrayBuffer) { return new Uint8Array(frame); }
        throw new CodecError('INVALID', 'frame is not binary');
    }

    // size: { width, height } of the current desktop; both must be positive integers
    function parseBitmap(buf, dv, size) {
        if (buf.length < BITMAP_HEADER_BYTES) { throw new CodecError('TRUNCATED', 'bitmap header'); }
        if (buf[1] !== 0) { throw new CodecError('INVALID', 'bitmap reserved'); }
        const count = dv.getUint16(2, true);
        if ((count < 1) || (count > limits.BITMAP_MAX_RECTS)) { throw new CodecError('INVALID', 'bitmap rect count'); }
        // A frame with several rectangles is a batch and stays small; a single rectangle may be large
        if ((count > 1) && (buf.length > limits.WIRE_BATCH_MAX_BYTES)) { throw new CodecError('LIMIT', 'bitmap batch size'); }
        // The rectangle headers alone must fit before the loop allocates the result
        if (buf.length < BITMAP_HEADER_BYTES + (count * BITMAP_RECT_HEADER_BYTES)) { throw new CodecError('TRUNCATED', 'bitmap rect headers'); }

        // Decompression bomb guard: the byte window counts compressed bytes, so a few KiB of RLE can describe
        // a full-size rectangle. One frame may decode to at most DECODED_AREA_FACTOR desktops of encoded pixels.
        // The floor admits a contract-valid batch of BITMAP_MAX_RECTS tiles of 64x64 on a small desktop.
        const pixelBudget = Math.max(size.width * size.height * DECODED_AREA_FACTOR, MIN_PIXEL_BUDGET);
        let pixels = 0;
        const rects = [];
        let pos = BITMAP_HEADER_BYTES;
        for (let i = 0; i < count; i++) {
            if (buf.length - pos < BITMAP_RECT_HEADER_BYTES) { throw new CodecError('TRUNCATED', 'bitmap rect header'); }
            const codec = buf[pos], bpp = buf[pos + 1], flags = buf[pos + 2], reserved = buf[pos + 3];
            const destLeft = dv.getUint16(pos + 4, true), destTop = dv.getUint16(pos + 6, true);
            const width = dv.getUint16(pos + 8, true), height = dv.getUint16(pos + 10, true);
            const bitmapWidth = dv.getUint16(pos + 12, true), bitmapHeight = dv.getUint16(pos + 14, true);
            const length = dv.getUint32(pos + 16, true);
            pos += BITMAP_RECT_HEADER_BYTES;

            const bpps = BPP_BY_CODEC[codec];
            if (bpps === undefined) { throw new CodecError('INVALID', 'bitmap codec'); }
            if (bpps.indexOf(bpp) < 0) { throw new CodecError('INVALID', 'bitmap bpp'); }
            if ((flags & ~constants.WIRE_BITMAP_FLAG.BOTTOM_UP) !== 0) { throw new CodecError('INVALID', 'bitmap flags'); }
            if (((flags & constants.WIRE_BITMAP_FLAG.BOTTOM_UP) !== 0) && (codec !== CODEC.RAW)) { throw new CodecError('INVALID', 'bottom-up flag on a compressed bitmap'); }
            if (reserved !== 0) { throw new CodecError('INVALID', 'bitmap rect reserved'); }
            if ((width < 1) || (height < 1) || (width > limits.BITMAP_MAX_DIM) || (height > limits.BITMAP_MAX_DIM)) { throw new CodecError('INVALID', 'bitmap size'); }
            if ((bitmapWidth < width) || (bitmapHeight < height) || (bitmapWidth > limits.BITMAP_MAX_DIM) || (bitmapHeight > limits.BITMAP_MAX_DIM)) { throw new CodecError('INVALID', 'bitmap encoded size'); }
            if ((destLeft + width > size.width) || (destTop + height > size.height)) { throw new CodecError('INVALID', 'bitmap outside the desktop'); }
            if (bitmapWidth * bitmapHeight > limits.SURFACES_MAX_PIXELS) { throw new CodecError('LIMIT', 'bitmap pixels'); }
            pixels += bitmapWidth * bitmapHeight;
            if (pixels > pixelBudget) { throw new CodecError('LIMIT', 'decoded pixels per frame'); }
            if (length < 1) { throw new CodecError('INVALID', 'bitmap payload length'); }
            if (length > buf.length - pos) { throw new CodecError('TRUNCATED', 'bitmap payload'); }

            rects.push({
                codec: codec, bpp: bpp, bottomUp: ((flags & constants.WIRE_BITMAP_FLAG.BOTTOM_UP) !== 0),
                destLeft: destLeft, destTop: destTop, width: width, height: height,
                bitmapWidth: bitmapWidth, bitmapHeight: bitmapHeight, payload: buf.subarray(pos, pos + length)
            });
            pos += length;
        }
        if (pos !== buf.length) { throw new CodecError('INVALID', 'bitmap trailing bytes'); }
        return { type: 'bitmap', rects: rects };
    }

    function parsePointer(buf, dv, size) {
        if (buf.length < 2) { throw new CodecError('TRUNCATED', 'pointer header'); }
        const kind = buf[1];
        switch (kind) {
            case POINTER.HIDDEN:
            case POINTER.SYSTEM_DEFAULT:
                if (buf.length !== 2) { throw new CodecError('INVALID', 'pointer trailing bytes'); }
                return { type: 'pointer', kind: kind };
            case POINTER.SET: {
                if (buf.length < POINTER_SET_HEADER_BYTES) { throw new CodecError('TRUNCATED', 'pointer header'); }
                const cacheIndex = dv.getUint16(2, true);
                const hotX = dv.getUint16(4, true), hotY = dv.getUint16(6, true);
                const width = dv.getUint16(8, true), height = dv.getUint16(10, true);
                if ((cacheIndex >= limits.POINTER_CACHE_MAX_ENTRIES) && (cacheIndex !== constants.WIRE_POINTER_NO_CACHE)) { throw new CodecError('INVALID', 'pointer cache index'); }
                if ((width < 1) || (height < 1) || (width > limits.POINTER_MAX_DIM) || (height > limits.POINTER_MAX_DIM)) { throw new CodecError('INVALID', 'pointer size'); }
                if ((hotX >= width) || (hotY >= height)) { throw new CodecError('INVALID', 'pointer hotspot'); }
                const need = POINTER_SET_HEADER_BYTES + (width * height * 4);
                if (buf.length < need) { throw new CodecError('TRUNCATED', 'pointer pixels'); }
                if (buf.length > need) { throw new CodecError('INVALID', 'pointer trailing bytes'); }
                return {
                    type: 'pointer', kind: kind, cacheIndex: cacheIndex, hotX: hotX, hotY: hotY,
                    width: width, height: height, rgba: buf.subarray(POINTER_SET_HEADER_BYTES, need)
                };
            }
            case POINTER.CACHED: {
                if (buf.length < 4) { throw new CodecError('TRUNCATED', 'cached pointer'); }
                if (buf.length > 4) { throw new CodecError('INVALID', 'pointer trailing bytes'); }
                const cacheIndex = dv.getUint16(2, true);
                if (cacheIndex >= limits.POINTER_CACHE_MAX_ENTRIES) { throw new CodecError('INVALID', 'pointer cache index'); }
                return { type: 'pointer', kind: kind, cacheIndex: cacheIndex };
            }
            case POINTER.POSITION: {
                if (buf.length < 6) { throw new CodecError('TRUNCATED', 'pointer position'); }
                if (buf.length > 6) { throw new CodecError('INVALID', 'pointer trailing bytes'); }
                const x = dv.getUint16(2, true), y = dv.getUint16(4, true);
                if ((x >= size.width) || (y >= size.height)) { throw new CodecError('INVALID', 'pointer position'); }
                return { type: 'pointer', kind: kind, x: x, y: y };
            }
            default:
                throw new CodecError('INVALID', 'pointer kind');
        }
    }

    const SURFACE_BITS_HEADER_BYTES = 24;
    const SURFACE = constants.WIRE_SURFACE_CODEC;

    // SURFACE_BITS (rdp/WIRE.md 0x02): one Set/Stream Surface Bits command. The payload stays a view; the decoder validates it.
    function parseSurfaceBits(buf, dv, size) {
        if (buf.length < SURFACE_BITS_HEADER_BYTES) { throw new CodecError('TRUNCATED', 'surface bits header'); }
        const codec = buf[1];
        if ((codec !== SURFACE.REMOTEFX) && (codec !== SURFACE.NSCODEC)) { throw new CodecError('INVALID', 'surface bits codec'); }
        if ((dv.getUint16(2, true) !== 0) || (dv.getUint16(14, true) !== 0)) { throw new CodecError('INVALID', 'surface bits reserved'); }
        const left = dv.getUint16(4, true), top = dv.getUint16(6, true), right = dv.getUint16(8, true), bottom = dv.getUint16(10, true);
        const bpp = buf[12], flags = buf[13];
        const width = dv.getUint16(16, true), height = dv.getUint16(18, true), length = dv.getUint32(20, true);
        if ((bpp !== 32) || (flags !== 0)) { throw new CodecError('INVALID', 'surface bits format'); }
        if ((right <= left) || (bottom <= top) || (right > size.width) || (bottom > size.height)) { throw new CodecError('INVALID', 'surface bits rectangle'); }
        if ((width < 1) || (height < 1) || (width > limits.BITMAP_MAX_DIM) || (height > limits.BITMAP_MAX_DIM)) { throw new CodecError('INVALID', 'surface bits size'); }
        if (length < 1) { throw new CodecError('INVALID', 'surface bits payload length'); }
        if (length > buf.length - SURFACE_BITS_HEADER_BYTES) { throw new CodecError('TRUNCATED', 'surface bits payload'); }
        if (length < buf.length - SURFACE_BITS_HEADER_BYTES) { throw new CodecError('INVALID', 'surface bits trailing bytes'); }
        return {
            type: 'surface', codec: codec, left: left, top: top, right: right, bottom: bottom, width: width, height: height,
            payload: buf.subarray(SURFACE_BITS_HEADER_BYTES)
        };
    }

    // GFX frame: the PDUs after the type byte, kept as a view. A frame with several PDUs is a batch and stays small.
    function parseGfx(buf, dv) {
        if (buf.length < 1 + constants.GFX_HEADER_SIZE) { throw new CodecError('TRUNCATED', 'GFX header'); }
        const first = dv.getUint32(1 + 4, true);
        if ((first < constants.GFX_HEADER_SIZE) || (first > buf.length - 1)) { throw new CodecError('INVALID', 'GFX PDU length'); }
        if ((first !== buf.length - 1) && (buf.length > limits.WIRE_BATCH_MAX_BYTES)) { throw new CodecError('LIMIT', 'GFX batch size'); }
        return { type: 'gfx', body: buf.subarray(1) };
    }

    // frame: ArrayBuffer | Uint8Array, size: { width, height } of the current desktop, opts: { gfx: bool, surfaceBits: bool }
    function parseFrame(frame, size, opts) {
        const buf = toView(frame);
        if (buf.length < 1) { throw new CodecError('TRUNCATED', 'empty frame'); }
        if (buf.length > limits.WIRE_FRAME_MAX_BYTES) { throw new CodecError('LIMIT', 'frame size'); }
        if ((size == null) || !Number.isInteger(size.width) || !Number.isInteger(size.height) || (size.width < 1) || (size.height < 1)) {
            throw new CodecError('INVALID', 'no desktop');
        }
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        switch (buf[0]) {
            case WIRE.BITMAP: return parseBitmap(buf, dv, size);
            case WIRE.POINTER: return parsePointer(buf, dv, size);
            case WIRE.GFX:
                if ((opts != null) && (opts.gfx === true)) { return parseGfx(buf, dv); }
                throw new CodecError('INVALID', 'frame type not supported by this client');
            case WIRE.SURFACE_BITS:
                if ((opts != null) && (opts.surfaceBits === true)) { return parseSurfaceBits(buf, dv, size); }
                throw new CodecError('INVALID', 'frame type not supported by this client');
            default:
                throw new CodecError('INVALID', 'frame type');
        }
    }

    return Object.freeze({ parseFrame: parseFrame, DECODED_AREA_FACTOR: DECODED_AREA_FACTOR, MIN_PIXEL_BUDGET: MIN_PIXEL_BUDGET, BITMAP_HEADER_BYTES: BITMAP_HEADER_BYTES, BITMAP_RECT_HEADER_BYTES: BITMAP_RECT_HEADER_BYTES, POINTER_SET_HEADER_BYTES: POINTER_SET_HEADER_BYTES });
});
