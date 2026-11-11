/**
* @description RDPGFX Alpha (MS-RDPEGFX 2.2.4.3): raw/RLE alpha-only updates, top-down RGBA
* @license Apache-2.0
*
* Reference: FreeRDP libfreerdp/gdi/gfx.c, gdi_SurfaceCommand_Alpha / gdi_apply_alpha
* (Copyright 2014 Marc-Andre Moreau, 2016 Armin Novak / Thincast Technologies GmbH,
* Apache-2.0). Unlike that reference, reject overlong runs. Like it, ignore bytes after the last pixel
* (raw: after w*h bytes; RLE: after the run that completes the area) and accept zero-length runs.
* Validate the entire stream before writing, so malformed input leaves dst unchanged.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.alpha = factory(root.RdpShared.limits, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors) {
    'use strict';
    const { CodecError, toCodecError } = errors;
    const fail = code => { throw new CodecError(code); };
    const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

    function decode(src, rect, dst, params) {
        try {
            if (!(src instanceof Uint8Array) || !rect || !dst) { fail('INVALID'); }
            if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID'); }
            if (src.length > limits.GFX_PDU_MAX_BYTES ||
                !integer(dst.width, 1, limits.SURFACE_MAX_DIM) || !integer(dst.height, 1, limits.SURFACE_MAX_DIM) ||
                dst.width * dst.height > limits.SURFACES_MAX_PIXELS ||
                !integer(rect.x, 0, dst.width) || !integer(rect.y, 0, dst.height) ||
                !integer(rect.width, 1, dst.width) || !integer(rect.height, 1, dst.height) ||
                rect.x + rect.width > dst.width || rect.y + rect.height > dst.height ||
                !integer(dst.stride, dst.width * 4, Math.floor(Number.MAX_SAFE_INTEGER / dst.height)) ||
                dst.data.length < dst.stride * dst.height) { fail('LIMIT'); }
            if (src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength &&
                dst.data.byteOffset < src.byteOffset + src.byteLength) { fail('INVALID'); }
            if (src.length < 4) { fail('TRUNCATED'); }
            if (src[0] !== 0x4C || src[1] !== 0x41) { fail('INVALID'); }
            const pixels = rect.width * rect.height;
            const compressed = src[2] !== 0 || src[3] !== 0; // every nonzero UINT16 means RLE
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);

            // Walk segments twice: first validate all lengths, then write only alpha. No pixel scratch/state.
            function runs(write) {
                let pos = 4, count = 0;
                let output = rect.y * dst.stride + rect.x * 4 + 3, x = 0;
                while (count < pixels) { // bytes after the run that completes the area are ignored, as FreeRDP does
                    if (src.length - pos < 2) { fail('TRUNCATED'); }
                    const value = src[pos++];
                    let length = src[pos++];
                    if (length === 0xFF) {
                        if (src.length - pos < 2) { fail('TRUNCATED'); }
                        length = view.getUint16(pos, true); pos += 2;
                        if (length === 0xFFFF) {
                            if (src.length - pos < 4) { fail('TRUNCATED'); }
                            length = view.getUint32(pos, true); pos += 4;
                        }
                    }
                    if (length > pixels - count) { fail('INVALID'); }
                    count += length;
                    if (write) {
                        for (let i = 0; i < length; i++) {
                            dst.data[output] = value;
                            output += 4;
                            if (++x === rect.width) { x = 0; output += dst.stride - rect.width * 4; }
                        }
                    }
                }
            }
            const validateOnly = !!(params && params.validateOnly); // check the stream, write nothing (XRGB discards alpha)
            if (compressed) { runs(false); if (!validateOnly) { runs(true); } }
            else {
                if (src.length - 4 < pixels) { fail('TRUNCATED'); }
                if (validateOnly) { return; }
                let input = 4;
                for (let y = 0; y < rect.height; y++) {
                    let output = (rect.y + y) * dst.stride + rect.x * 4 + 3;
                    for (let x = 0; x < rect.width; x++, output += 4) { dst.data[output] = src[input++]; }
                }
            }
        } catch (e) { throw toCodecError(e); }
    }
    return Object.freeze({ decode });
});
