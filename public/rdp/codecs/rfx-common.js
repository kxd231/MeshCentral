/**
* @description RemoteFX tile primitives shared by rfx.js (MS-RDPRFX) and the Progressive decoder: RLGR1/RLGR3, sub-band layout,
* differential LL3, dequantization, inverse DWT 5/3 and YCbCr to RGBA
* @license Apache-2.0
*
* MS-RDPRFX 3.1.8 (RLGR pseudocode, DWT, quantization, ICT). The arithmetic and the order of the stages follow
* FreeRDP libfreerdp/codec/rfx_rlgr.c, rfx_dwt.c, rfx_quantization.c, rfx_differential.h, rfx_decode.c and
* primitives/prim_colors.c (Copyright 2011 Vic Lee, Marc-Andre Moreau and others; Apache-2.0) so the output is
* bit-identical with FreeRDP for conforming streams. Every int16 store wraps like the C code, an entropy value
* outside int16 is an error (CodecError 'INVALID'), as is a differential sum outside int16.
*
* A tile is 4096 coefficients per component in the sub-band layout of rfx_quantization.c:
*   HL1 0 (32x32), LH1 1024, HH1 2048, HL2 3072 (16x16), LH2 3328, HH2 3584, HL3 3840 (8x8), LH3 3904, HH3 3968, LL3 4032
* Everything works on a TileWorkspace (typed arrays allocated once): the hot path allocates nothing.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('./errors.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs['rfx-common'] = factory(root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (errors) {
    'use strict';
    const CodecError = errors.CodecError;

    const TILE_DIM = 64;
    const TILE_COEFFS = 4096;
    const COMPONENT_MAX_BYTES = 0xFFFF;         // YLen / CbLen / CrLen are u16
    const BITS_PAD = 16;                        // zero bytes after the entropy data: window reads never leave the array
    const BAND = Object.freeze({ HL1: 0, LH1: 1024, HH1: 2048, HL2: 3072, LH2: 3328, HH2: 3584, HL3: 3840, LH3: 3904, HH3: 3968, LL3: 4032 });
    const BAND_SIZE = Object.freeze({ HL1: 1024, LH1: 1024, HH1: 1024, HL2: 256, LH2: 256, HH2: 256, HL3: 64, LH3: 64, HH3: 64, LL3: 64 });
    const QUANT_VALUES = 10;                    // per quantization table, in the order LL3 LH3 HL3 HH3 LH2 HL2 HH2 LH1 HL1 HH1
    const LITTLE_ENDIAN = (new Uint8Array(new Uint32Array([1]).buffer)[0] === 1);

    // Constants of RLGR1/RLGR3 (MS-RDPRFX 3.1.8.1.7.3)
    const KPMAX = 80, LSGR = 3, UP_GR = 4, DN_GR = 6, UQ_GR = 3, DQ_GR = 3;

    // Memory of one workspace: 4 Int16 tiles, the padded entropy input and the 64x64 pixel tile
    const WORKSPACE_BYTES = (4 * TILE_COEFFS * 2) + (COMPONENT_MAX_BYTES + BITS_PAD) + (TILE_COEFFS * 4);

    class TileWorkspace {
        constructor() {
            this.y = new Int16Array(TILE_COEFFS);
            this.cb = new Int16Array(TILE_COEFFS);
            this.cr = new Int16Array(TILE_COEFFS);
            this.tmp = new Int16Array(TILE_COEFFS);                     // inverse DWT scratch
            this.bits = new Uint8Array(COMPONENT_MAX_BYTES + BITS_PAD); // entropy input, zero padded
            this.bitsView = new DataView(this.bits.buffer);
            this.bitsLength = 0;
            const pixels = new ArrayBuffer(TILE_COEFFS * 4);
            this.pixels32 = new Uint32Array(pixels);                    // one decoded 64x64 tile, RGBA, alpha 255
            this.pixels8 = new Uint8ClampedArray(pixels);
        }

        // Copies `length` bytes of entropy data to the padded input buffer
        load(src, start, length) {
            if (length > COMPONENT_MAX_BYTES) { throw new CodecError('INVALID', 'RLGR input length'); }
            this.bits.set(src.subarray(start, start + length), 0);
            this.bits.fill(0, length, length + BITS_PAD);
            this.bitsLength = length;
        }
    }

    function invalid(what) { throw new CodecError('INVALID', what); }

    // ---- RLGR ---------------------------------------------------------------------------------------------------
    // Reads the next 32 bits at bit position `pos` of the zero padded buffer
    function peek32(b, pos) {
        const i = pos >>> 3, s = pos & 7;
        const hi = b.getInt32(i, false);
        return (s === 0) ? hi : ((hi << s) | (b.getUint8(i + 4) >>> (8 - s)));
    }

    // Number of consecutive zero bits (ones = false) or one bits (ones = true) from `pos`, at most `limit`
    function runLength(b, pos, limit, ones) {
        let n = 0;
        for (;;) {
            let w = peek32(b, pos + n);
            if (ones) { w = ~w; }
            if (w !== 0) {
                n += Math.clz32(w);
                return (n > limit) ? limit : n;
            }
            n += 32;
            if (n >= limit) { return limit; }
        }
    }

    // Decodes `ws.bitsLength` bytes of RLGR data (ws.load) into out[0..4095]. mode3: RLGR3, otherwise RLGR1.
    // Like FreeRDP, a stream that ends early leaves the rest of the coefficients zero.
    function rlgrDecode(ws, out, mode3) {
        const b = ws.bitsView, total = ws.bitsLength * 8;
        // Clear once, not once per short zero run (TypedArray.fill crosses the builtin boundary).
        // This also leaves every coefficient after an early entropy end at zero.
        out.fill(0, 0, TILE_COEFFS);
        let pos = 0, n = 0;
        let k = 1, kp = k << LSGR, kr = 1, krp = kr << LSGR;
        while ((pos < total) && (n < TILE_COEFFS)) {
            if (k !== 0) {
                // Run-length mode: unary count of zero runs, run remainder, sign, unary code, code remainder
                const prefix = peek32(b, pos);
                let vk = prefix === 0 ? runLength(b, pos, total - pos, false) : Math.min(Math.clz32(prefix), total - pos);
                let available = 32 - vk - 1;
                const prefixShift = vk + 1;
                pos += vk;
                if (total - pos < 1) { break; }
                pos += 1;
                let run = 0;
                while ((vk > 0) && (kp < KPMAX)) {
                    run += (1 << k);
                    kp += UP_GR;
                    if (kp > KPMAX) { kp = KPMAX; }
                    k = kp >> LSGR;
                    vk--;
                }
                if (vk > 0) { run += vk * (1 << k); }   // kp is clamped at KPMAX: k stays 10
                if (total - pos < k) { break; }
                const runWord = available >= k + 1 ? (prefix << prefixShift) : peek32(b, pos);
                if (available < k + 1) { available = 32; }
                if (k > 0) { run += runWord >>> (32 - k); }
                pos += k;
                if (total - pos < 1) { break; }
                const w = runWord << k, sign = w >>> 31;
                vk = Math.clz32(~(w << 1));
                let code;
                const bits = 1 + vk + 1 + kr;
                if (bits <= available - k && bits <= total - pos) {
                    code = (w >>> (32 - bits)) & ((1 << kr) - 1);
                    code = (code | (vk << kr)) & 0xFFFF;
                    pos += bits;
                } else {
                    pos += 1;
                    vk = runLength(b, pos, total - pos, true);
                    pos += vk;
                    if (total - pos < 1) { break; }
                    pos += 1;
                    if (total - pos < kr) { break; }
                    code = (kr > 0) ? (peek32(b, pos) >>> (32 - kr)) : 0;
                    pos += kr;
                    code = (code | (vk << kr)) & 0xFFFF;
                }
                if (vk === 0) {
                    krp = (krp > 2) ? (krp - 2) : 0;
                    kr = krp >> LSGR;
                } else if (vk !== 1) {
                    krp += vk;
                    if (krp > KPMAX) { krp = KPMAX; }
                    kr = krp >> LSGR;
                }
                kp = (kp > DN_GR) ? (kp - DN_GR) : 0;
                k = kp >> LSGR;
                const code1 = code + 1;
                if (code1 > 32767) { invalid('RLGR magnitude'); }
                if (run > TILE_COEFFS - n) { run = TILE_COEFFS - n; }
                n += run;
                if (n < TILE_COEFFS) { out[n++] = sign ? -code1 : code1; }
            } else {
                // The common Golomb-Rice code fits in one lookahead word (unary + remainder).
                // Keep the bounded slow path for arbitrarily long unary input and truncated streams.
                const w = peek32(b, pos);
                let vk = Math.clz32(~w), code;
                const bits = vk + 1 + kr;
                if (bits <= 32 && bits <= total - pos) {
                    code = (w >>> (32 - bits)) & ((1 << kr) - 1);
                    code = (code | (vk << kr)) & 0xFFFF;
                    pos += bits;
                } else {
                    vk = runLength(b, pos, total - pos, true);
                    pos += vk;
                    if (total - pos < 1) { break; }
                    pos += 1;
                    if (total - pos < kr) { break; }
                    code = (kr > 0) ? (peek32(b, pos) >>> (32 - kr)) : 0;
                    pos += kr;
                    code = (code | (vk << kr)) & 0xFFFF;
                }
                if (vk === 0) {
                    krp = (krp > 2) ? (krp - 2) : 0;
                    kr = krp >> LSGR;
                } else if (vk !== 1) {
                    krp += vk;
                    if (krp > KPMAX) { krp = KPMAX; }
                    kr = krp >> LSGR;
                }
                if (!mode3) {
                    let mag;
                    if (code === 0) {
                        kp += UQ_GR;
                        if (kp > KPMAX) { kp = KPMAX; }
                        k = kp >> LSGR;
                        mag = 0;
                    } else {
                        kp = (kp > DQ_GR) ? (kp - DQ_GR) : 0;
                        k = kp >> LSGR;
                        const half1 = (code + 1) >> 1;
                        if (half1 > 32767) { invalid('RLGR magnitude'); }
                        mag = (code & 1) ? -half1 : (code >> 1);
                    }
                    out[n++] = mag;
                } else {
                    // RLGR3: two values with the same code, val1 has nIdx bits
                    const nIdx = (code !== 0) ? (32 - Math.clz32(code)) : 0;
                    if (total - pos < nIdx) { break; }
                    const val1 = (nIdx === 0) ? 0 : ((bits + nIdx <= 32) ?
                        ((w >>> (32 - bits - nIdx)) & ((1 << nIdx) - 1)) : (peek32(b, pos) >>> (32 - nIdx)));
                    pos += nIdx;
                    const val2 = (code - val1) >>> 0;   // unsigned: val1 > code wraps and fails the range check below
                    if (val1 !== 0 && val2 !== 0) {
                        kp = (kp > 2 * DQ_GR) ? (kp - (2 * DQ_GR)) : 0;
                        k = kp >> LSGR;
                    } else if (val1 === 0 && val2 === 0) {
                        kp += 2 * UQ_GR;
                        if (kp > KPMAX) { kp = KPMAX; }
                        k = kp >> LSGR;
                    }
                    const v1a = val1 >>> 1, v1b = (val1 + 1) >>> 1;
                    if (v1a > 32767 || v1b > 32767) { invalid('RLGR magnitude'); }
                    out[n++] = (val1 & 1) ? -v1b : v1a;
                    const v2a = val2 >>> 1, v2b = Math.floor((val2 + 1) / 2);
                    if (v2a > 32767 || v2b > 32767) { invalid('RLGR magnitude'); }
                    if (n < TILE_COEFFS) { out[n++] = (val2 & 1) ? -v2b : v2a; }
                }
            }
        }
    }

    // ---- differential, quantization, inverse DWT ------------------------------------------------------------------
    // LL3 is stored as differences of neighbours (rfx_differential.h); the running sum must stay inside int16
    function differentialLL3(buf) {
        let prev = buf[BAND.LL3];
        for (let i = BAND.LL3 + 1; i < TILE_COEFFS; i++) {
            const sum = prev + buf[i];
            if (sum > 32767 || sum < -32768) { invalid('differential LL3'); }
            buf[i] = sum;
            prev = sum;
        }
    }

    function shiftBand(buf, start, count, factor) {
        if (factor === 0) { return; }
        for (let i = start; i < start + count; i++) { buf[i] = buf[i] << factor; }
    }

    // q[qOff .. qOff + 9]: the ten 4-bit values of one quantization table (LL3 LH3 HL3 HH3 LH2 HL2 HH2 LH1 HL1 HH1).
    // A value below 1 is invalid (FreeRDP); the shift is value - 1 (MS-RDPRFX 3.1.8.1.2)
    function dequantize(buf, q, qOff) {
        for (let i = 0; i < QUANT_VALUES; i++) { if (q[qOff + i] < 1) { invalid('quantization value'); } }
        shiftBand(buf, BAND.HL1, 1024, q[qOff + 8] - 1);
        shiftBand(buf, BAND.LH1, 1024, q[qOff + 7] - 1);
        shiftBand(buf, BAND.HH1, 1024, q[qOff + 9] - 1);
        shiftBand(buf, BAND.HL2, 256, q[qOff + 5] - 1);
        shiftBand(buf, BAND.LH2, 256, q[qOff + 4] - 1);
        shiftBand(buf, BAND.HH2, 256, q[qOff + 6] - 1);
        shiftBand(buf, BAND.HL3, 64, q[qOff + 2] - 1);
        shiftBand(buf, BAND.LH3, 64, q[qOff + 1] - 1);
        shiftBand(buf, BAND.HH3, 64, q[qOff + 3] - 1);
        shiftBand(buf, BAND.LL3, 64, q[qOff] - 1);
    }

    // One inverse level on buf[base .. base + 4 * sw * sw): bands HL, LH, HH, LL (sw x sw each) become one 2sw x 2sw block
    function idwtBlock(buf, base, sw, tmp) {
        const tw = sw << 1, sq = sw * sw;
        // Fuse the even/odd horizontal lifting steps. Carry the wrapped even sample in a
        // register: the following odd sample must use int16, not the unbounded difference.
        for (let band = 0; band < 2; band++) {
            let lo = base + (band === 0 ? 3 * sq : sq), hi = base + band * 2 * sq;
            let d = band * 2 * sq;
            for (let y = 0; y < sw; y++, lo += sw, hi += sw, d += tw) {
                let h = buf[hi];
                let even = ((buf[lo] - h) << 16) >> 16;
                tmp[d] = even;
                for (let x = 1; x < sw; x++) {
                    const nextH = buf[hi + x];
                    const next = ((buf[lo + x] - ((h + nextH + 1) >> 1)) << 16) >> 16;
                    tmp[d + 2 * x - 1] = (h << 1) + ((even + next) >> 1);
                    tmp[d + 2 * x] = next;
                    h = nextH; even = next;
                }
                tmp[d + tw - 1] = (h << 1) + even;
            }
        }
        // Vertical lifting traverses contiguous rows instead of strided columns. Each
        // iteration writes the next even row and completes the preceding odd row.
        const hOff = sw * tw;
        for (let x = 0; x < tw; x++) { buf[base + x] = tmp[x] - tmp[hOff + x]; }
        for (let y = 1; y < sw; y++) {
            const l = y * tw, h = hOff + l, d = base + 2 * l;
            for (let x = 0; x < tw; x++) {
                const even = ((tmp[l + x] - ((tmp[h - tw + x] + tmp[h + x] + 1) >> 1)) << 16) >> 16;
                buf[d + x] = even;
                buf[d - tw + x] = (tmp[h - tw + x] << 1) + ((buf[d - 2 * tw + x] + even) >> 1);
            }
        }
        const last = base + (tw - 2) * tw;
        for (let x = 0; x < tw; x++) { buf[last + tw + x] = (tmp[hOff + (sw - 1) * tw + x] << 1) + buf[last + x]; }
    }

    // Specialize the dominant 64x64 level; the smaller two share the general kernel.
    function idwt32(buf, tmp) {
        const base = 0, sw = 32, tw = 64, sq = 1024;
        // Fuse the even/odd horizontal lifting steps. Carry the wrapped even sample in a
        // register: the following odd sample must use int16, not the unbounded difference.
        for (let band = 0; band < 2; band++) {
            let lo = base + (band === 0 ? 3 * sq : sq), hi = base + band * 2 * sq;
            let d = band * 2 * sq;
            for (let y = 0; y < sw; y++, lo += sw, hi += sw, d += tw) {
                let h = buf[hi];
                let even = ((buf[lo] - h) << 16) >> 16;
                tmp[d] = even;
                for (let x = 1; x < sw; x++) {
                    const nextH = buf[hi + x];
                    const next = ((buf[lo + x] - ((h + nextH + 1) >> 1)) << 16) >> 16;
                    tmp[d + 2 * x - 1] = (h << 1) + ((even + next) >> 1);
                    tmp[d + 2 * x] = next;
                    h = nextH; even = next;
                }
                tmp[d + tw - 1] = (h << 1) + even;
            }
        }
        // Vertical lifting traverses contiguous rows instead of strided columns. Each
        // iteration writes the next even row and completes the preceding odd row.
        const hOff = sw * tw;
        for (let x = 0; x < tw; x++) { buf[base + x] = tmp[x] - tmp[hOff + x]; }
        for (let y = 1; y < sw; y++) {
            const l = y * tw, h = hOff + l, d = base + 2 * l;
            for (let x = 0; x < tw; x++) {
                const even = ((tmp[l + x] - ((tmp[h - tw + x] + tmp[h + x] + 1) >> 1)) << 16) >> 16;
                buf[d + x] = even;
                buf[d - tw + x] = (tmp[h - tw + x] << 1) + ((buf[d - 2 * tw + x] + even) >> 1);
            }
        }
        const last = base + (tw - 2) * tw;
        for (let x = 0; x < tw; x++) { buf[last + tw + x] = (tmp[hOff + (sw - 1) * tw + x] << 1) + buf[last + x]; }
    }

    function idwt2d(buf, tmp) {
        idwtBlock(buf, 3840, 8, tmp);
        idwtBlock(buf, 3072, 16, tmp);
        idwt32(buf, tmp);
    }

    // ---- color --------------------------------------------------------------------------------------------------
    // ICT inverse as in primitives/prim_colors.c (divisor 16): Y = (y + 4096) << 16, R = (1.402525 Cr + Y) >> 21, ...
    // The coefficients carry 5 fractional bits, so the final shift is 16 + 5. Alpha 255.
    const C_CR_R = 91916, C_CR_G = 46819, C_CB_G = 22527, C_CB_B = 115992;

    // Converts the three 64x64 component tiles to out32 (RGBA bytes in memory order on a little-endian host)
    function ycbcrToRgba32(y, cb, cr, out32) {
        for (let i = 0; i < TILE_COEFFS; i++) {
            const yy = (y[i] + 4096) << 16, b = cb[i], r = cr[i];
            let R = (r * C_CR_R + yy) >> 21;
            let G = (yy - (b * C_CB_G) - (r * C_CR_G)) >> 21;
            let B = (b * C_CB_B + yy) >> 21;
            R = (R < 0) ? 0 : ((R > 255) ? 255 : R);
            G = (G < 0) ? 0 : ((G > 255) ? 255 : G);
            B = (B < 0) ? 0 : ((B > 255) ? 255 : B);
            out32[i] = 0xFF000000 | (B << 16) | (G << 8) | R;
        }
    }

    // The same through bytes, independent of the host byte order
    function ycbcrToRgba8(y, cb, cr, out8) {
        for (let i = 0, o = 0; i < TILE_COEFFS; i++, o += 4) {
            const yy = (y[i] + 4096) << 16, b = cb[i], r = cr[i];
            let R = (r * C_CR_R + yy) >> 21;
            let G = (yy - (b * C_CB_G) - (r * C_CR_G)) >> 21;
            let B = (b * C_CB_B + yy) >> 21;
            out8[o] = (R < 0) ? 0 : ((R > 255) ? 255 : R);
            out8[o + 1] = (G < 0) ? 0 : ((G > 255) ? 255 : G);
            out8[o + 2] = (B < 0) ? 0 : ((B > 255) ? 255 : B);
            out8[o + 3] = 255;
        }
    }

    function ycbcrToRgba(ws, forceBytes) {
        if (LITTLE_ENDIAN && forceBytes !== true) { ycbcrToRgba32(ws.y, ws.cb, ws.cr, ws.pixels32); }
        else { ycbcrToRgba8(ws.y, ws.cb, ws.cr, ws.pixels8); }
    }

    // One component: entropy data (already in ws.bits) to ws.<target>[0..4095] after dequantization and the inverse DWT
    function decodeComponent(ws, target, mode3, q, qOff) {
        rlgrDecode(ws, target, mode3);
        differentialLL3(target);
        dequantize(target, q, qOff);
        idwt2d(target, ws.tmp);
    }

    return Object.freeze({
        TILE_DIM: TILE_DIM, TILE_COEFFS: TILE_COEFFS, COMPONENT_MAX_BYTES: COMPONENT_MAX_BYTES, BAND: BAND, BAND_SIZE: BAND_SIZE,
        QUANT_VALUES: QUANT_VALUES, WORKSPACE_BYTES: WORKSPACE_BYTES, LITTLE_ENDIAN: LITTLE_ENDIAN,
        TileWorkspace: TileWorkspace, rlgrDecode: rlgrDecode, differentialLL3: differentialLL3, dequantize: dequantize,
        idwt2d: idwt2d, ycbcrToRgba: ycbcrToRgba, ycbcrToRgba32: ycbcrToRgba32, ycbcrToRgba8: ycbcrToRgba8, decodeComponent: decodeComponent
    });
});
