/**
* @description RDP 6.0 Planar (RGB / AYCoCg, raw / RLE, optional alpha and 4:2:0) to RGBA
* @license Apache-2.0
*
* MS-RDPEGDI 2.2.2.5.1 and 3.1.9. RLE/delta and color conversion adapted from
* FreeRDP libfreerdp/codec/planar.c (Copyright 2013 Marc-Andre Moreau, 2016 Armin
* Novak / Thincast Technologies GmbH) and primitives/prim_YCoCg.c (Copyright 2014
* Hewlett-Packard Development Company, L.P.), licensed under Apache-2.0.
* bottomUp selects source scanlines during composition, before top-left cropping.
* opaque forces desktop alpha to 255 while still validating any encoded alpha plane.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.planar = factory(root.RdpShared.limits, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors) {
    'use strict';
    const { CodecError, toCodecError } = errors;
    const fail = code => { throw new CodecError(code); };
    const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
    const clip = n => Math.max(0, Math.min(255, n));

    function validate(src, rect, dst, params) {
        if (!(src instanceof Uint8Array) || !rect || !dst || !params) { fail('INVALID'); }
        if (typeof params.bottomUp !== 'boolean' || typeof params.opaque !== 'boolean') { fail('INVALID'); }
        if (!integer(params.bitmapWidth, 1, limits.BITMAP_MAX_DIM) ||
            !integer(params.bitmapHeight, 1, limits.BITMAP_MAX_DIM) ||
            !integer(dst.width, 1, limits.SURFACE_MAX_DIM) || !integer(dst.height, 1, limits.SURFACE_MAX_DIM) ||
            dst.width * dst.height > limits.SURFACES_MAX_PIXELS ||
            !integer(rect.x, 0, dst.width) || !integer(rect.y, 0, dst.height) ||
            !integer(rect.width, 1, params.bitmapWidth) || !integer(rect.height, 1, params.bitmapHeight) ||
            rect.x + rect.width > dst.width || rect.y + rect.height > dst.height ||
            !integer(dst.stride, dst.width * 4, Number.MAX_SAFE_INTEGER / dst.height)) { fail('LIMIT'); }
        if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID'); }
        if (dst.data.length < dst.stride * dst.height) { fail('LIMIT'); }
        if (src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength &&
            dst.data.byteOffset < src.byteOffset + src.byteLength) { fail('INVALID'); }
    }

    function decode(src, rect, dst, params) {
        try {
            validate(src, rect, dst, params);
            if (!src.length) { fail('TRUNCATED'); }
            const { bitmapWidth: width, bitmapHeight: height } = params;
            const header = src[0], cll = header & 7, cs = (header & 8) !== 0;
            const rle = (header & 16) !== 0, alpha = (header & 32) === 0;
            // Reserved header bits are ignored, as in FreeRDP. CS is legal only with AYCoCg.
            if (cs && !cll) { fail('INVALID'); }
            const cw = cs ? Math.ceil(width / 2) : width, ch = cs ? Math.ceil(height / 2) : height;
            if (rle) {
                // One control emits at most 47 pixels and never crosses a row.
                // Widths 1/2 require 1/2 literal bytes too (run codes 1/2 mean 16/32).
                // For w >= 3, ceil(w/47) controls suffice even for implicit zero rows.
                const minimum = (w, h) => h * (w < 3 ? w + 1 : Math.ceil(w / 47));
                const required = 1 + (alpha ? minimum(width, height) : 0) +
                    minimum(width, height) + 2 * minimum(cw, ch);
                if (src.length < required) { fail('INVALID'); }
            }
            let input = 1;
            const plane = (w, h) => {
                const size = w * h;
                if (!rle) {
                    if (src.length - input < size) { fail('TRUNCATED'); }
                    const out = src.subarray(input, input + size); input += size; return out;
                }
                // All plane sizes are bounded by the validated bitmap dimensions.
                const out = new Uint8Array(size);
                for (let y = 0; y < h; y++) {
                    let x = 0, value = 0; // each row starts with an implicit zero color/delta
                    const row = y * w;
                    while (x < w) {
                        if (input >= src.length) { fail('TRUNCATED'); }
                        const control = src[input++];
                        let raw = control >>> 4, run = control & 15;
                        if (run === 1 || run === 2) { run = raw + run * 16; raw = 0; }
                        if (raw + run === 0 || raw + run > w - x) { fail('INVALID'); }
                        if (src.length - input < raw) { fail('TRUNCATED'); }
                        for (let i = 0; i < raw + run; i++, x++) {
                            if (i < raw) {
                                value = src[input++];
                                if (y) { value = (value & 1) ? -((value >>> 1) + 1) : value >>> 1; }
                            }
                            out[row + x] = y ? (out[row - w + x] + value) & 255 : value;
                        }
                    }
                }
                return out;
            };
            const a = alpha ? plane(width, height) : null;
            const red = plane(width, height), green = plane(cw, ch), blue = plane(cw, ch);
            // FreeRDP tolerates bytes after complete RLE planes. Raw permits one pad.
            if (!rle && input !== src.length && input + 1 !== src.length) { fail('INVALID'); }
            const shift = cll - 1;
            for (let y = 0; y < rect.height; y++) {
                const sourceY = params.bottomUp ? height - 1 - y : y;
                let output = (rect.y + y) * dst.stride + rect.x * 4;
                for (let x = 0; x < rect.width; x++, output += 4) {
                    const i = sourceY * width + x;
                    const c = cs ? (sourceY >>> 1) * cw + (x >>> 1) : i;
                    if (cll) {
                        // Shift before sign extension: CLL contains the /2 in the inverse transform.
                        const co = (green[c] << (shift + 24)) >> 24;
                        const cg = (blue[c] << (shift + 24)) >> 24;
                        dst.data[output] = clip(red[i] - cg - co);
                        dst.data[output + 1] = clip(red[i] + cg);
                        dst.data[output + 2] = clip(red[i] - cg + co);
                    } else {
                        dst.data[output] = red[i]; dst.data[output + 1] = green[i]; dst.data[output + 2] = blue[i];
                    }
                    dst.data[output + 3] = !params.opaque && a ? a[i] : 255;
                }
            }
        } catch (e) { throw toCodecError(e); }
    }
    return Object.freeze({ decode });
});
