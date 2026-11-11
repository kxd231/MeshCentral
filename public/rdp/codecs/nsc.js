/**
 * @description MS-RDPNSC planes, RLE, chroma recovery and AYCoCg to RGBA (top-down).
 * @license Apache-2.0
 * Algorithm adapted from FreeRDP libfreerdp/codec/nsc.c, Apache-2.0:
 * Copyright 2011 Samsung (Jiten Pathy), 2012 Vic Lee, 2016 Armin Novak / Thincast.
 * Unlike the native decoder, each RLE reader is confined to its declared plane.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.nsc = factory(root.RdpShared.limits, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors) {
    'use strict';
    const fail = code => { throw new errors.CodecError(code); };
    const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
    const clip = n => Math.max(0, Math.min(255, n));

    function decode(src, rect, dst, params) {
        try {
            if (!(src instanceof Uint8Array) || !rect || !dst || !params) { fail('INVALID'); }
            const w = params.bitmapWidth, h = params.bitmapHeight;
            if (!integer(w, 1, limits.BITMAP_MAX_DIM) || !integer(h, 1, limits.BITMAP_MAX_DIM) ||
                !integer(dst.width, 1, limits.SURFACE_MAX_DIM) || !integer(dst.height, 1, limits.SURFACE_MAX_DIM) ||
                dst.width * dst.height > limits.SURFACES_MAX_PIXELS ||
                !integer(rect.x, 0, dst.width) || !integer(rect.y, 0, dst.height) ||
                !integer(rect.width, 1, w) || !integer(rect.height, 1, h) ||
                rect.x + rect.width > dst.width || rect.y + rect.height > dst.height ||
                !integer(dst.stride, dst.width * 4, Math.floor(Number.MAX_SAFE_INTEGER / dst.height))) { fail('LIMIT'); }
            if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID'); }
            if (dst.data.length < dst.stride * dst.height || src.length > limits.GFX_PDU_MAX_BYTES) { fail('LIMIT'); }
            if (src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength &&
                dst.data.byteOffset < src.byteOffset + src.byteLength) { fail('INVALID'); }
            if (src.length < 20) { fail('TRUNCATED'); }
            const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
            const counts = [0, 4, 8, 12].map(i => view.getUint32(i, true));
            const cll = src[16], cs = src[17];
            if (cll < 1 || cll > 7 || cs > 1) { fail('INVALID'); }
            if (counts.reduce((a, b) => a + b, 0) > src.length - 20) { fail('TRUNCATED'); }
            const rw = Math.ceil(w / 8) * 8, ch = Math.ceil(h / 2);
            const sizes = [cs ? rw * h : w * h, cs ? (rw / 2) * ch : w * h,
                cs ? (rw / 2) * ch : w * h, w * h];
            let input = 20;
            const planes = counts.map((count, i) => {
                const size = sizes[i], start = input, end = start + count;
                input = end;
                if (!count) { return null; } // an omitted plane is all 0xff, including alpha
                if (count >= size) { return src.subarray(start, start + size); }
                // RLE always ends with four literal bytes. Check before allocating the bounded plane.
                if (size < 5 || count < 5) { fail('INVALID'); }
                const out = new Uint8Array(size);
                let p = start, o = 0;
                const need = n => { if (n > end - p) { fail('TRUNCATED'); } };
                while (size - o > 4) {
                    need(1); const value = src[p++];
                    if (size - o === 5) { out[o++] = value; continue; }
                    need(1);
                    if (value !== src[p]) { out[o++] = value; continue; }
                    p++; need(1); let run = src[p++];
                    if (run === 255) { need(4); run = view.getUint32(p, true); p += 4; }
                    else { run += 2; }
                    if (run > size - o - 4) { fail('INVALID'); }
                    out.fill(value, o, o + run); o += run;
                }
                need(4); out.set(src.subarray(p, p + 4), o);
                return out;
            });
            const value = (plane, i) => plane === null ? 255 : plane[i];
            for (let y = 0; y < rect.height; y++) {
                let output = (rect.y + y) * dst.stride + rect.x * 4;
                for (let x = 0; x < rect.width; x++, output += 4) {
                    const yi = y * (cs ? rw : w) + x;
                    const ci = cs ? (y >>> 1) * (rw / 2) + (x >>> 1) : yi;
                    const luma = value(planes[0], yi);
                    const co = (value(planes[1], ci) << (cll + 23)) >> 24;
                    const cg = (value(planes[2], ci) << (cll + 23)) >> 24;
                    dst.data[output] = clip(luma + co - cg);
                    dst.data[output + 1] = clip(luma + cg);
                    dst.data[output + 2] = clip(luma - co - cg);
                    dst.data[output + 3] = value(planes[3], y * w + x);
                }
            }
        } catch (e) { throw errors.toCodecError(e); }
    }
    return Object.freeze({ decode });
});
