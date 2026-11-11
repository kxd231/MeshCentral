/*
 * @description AVC444 kernels for WebAssembly SIMD: YUV444 to RGBA with the reverse filter, and the luma-view combine
 * @license Apache-2.0
 *
 * Bit-identical to the JavaScript code of public/rdp/codecs/avc444.js (Yuv444Planes.toRgba / applyLuma), which follows FreeRDP
 * libfreerdp/primitives/prim_YUV.c (general_YUV444ToRGB, YUV2R/G/B, CONDITIONAL_CLIP; Apache-2.0). Freestanding: no libc, no allocation;
 * the caller (JavaScript) lays the planes out in the linear memory and passes byte offsets.
 * Build: tools/avc444-simd/build.sh (clang -target wasm32 -msimd128 -mbulk-memory), the result is embedded in public/rdp/codecs/avc444-simd.js.
 */
#include <wasm_simd128.h>

typedef unsigned char u8;
#define EXPORT(n) __attribute__((export_name(n)))
#define FILTER_THRESHOLD 30

static inline u8 clamp8(int v) { return (u8)((v < 0) ? 0 : ((v > 255) ? 255 : v)); }

// One pixel exactly like the JavaScript loop: c = Y << 8, d = U - 128, e = V - 128, BT.709 full range, clamped
static inline void px1(u8 y, int u, int v, u8* o) {
    const int c = (int)y << 8, d = u - 128, e = v - 128;
    o[0] = clamp8((c + (403 * e)) >> 8);
    o[1] = clamp8((c - (48 * d) - (120 * e)) >> 8);
    o[2] = clamp8((c + (475 * d)) >> 8);
    o[3] = 255;
}

// 8 pixels: Y, U, V as u16x8 (values 0..255) → R, G, B as i16x8 (before clamping: -202..454).
// The JavaScript code computes (c + 403 e) >> 8 with c = Y << 8; as c is a multiple of 256 that is Y + ((403 e) >> 8) exactly (floor), and
// 403 e = 256 e + 147 e, 475 d = 256 d + 219 d: every term fits 16 bits, so eight samples are done per instruction.
static inline void half8(v128_t y, v128_t u, v128_t v, v128_t* r, v128_t* g, v128_t* b) {
    const v128_t k128 = wasm_i16x8_splat(128);
    const v128_t d = wasm_i16x8_sub(u, k128), e = wasm_i16x8_sub(v, k128);
    const v128_t rt = wasm_i16x8_add(e, wasm_i16x8_shr(wasm_i16x8_mul(e, wasm_i16x8_splat(147)), 8));
    const v128_t gt = wasm_i16x8_shr(wasm_i16x8_neg(wasm_i16x8_add(wasm_i16x8_mul(d, wasm_i16x8_splat(48)), wasm_i16x8_mul(e, wasm_i16x8_splat(120)))), 8);
    const v128_t bt = wasm_i16x8_add(d, wasm_i16x8_shr(wasm_i16x8_mul(d, wasm_i16x8_splat(219)), 8));
    *r = wasm_i16x8_add(y, rt);
    *g = wasm_i16x8_add(y, gt);
    *b = wasm_i16x8_add(y, bt);
}

// 16 pixels → 64 bytes of RGBA (alpha 255)
static inline void px16(v128_t y, v128_t u, v128_t v, u8* o) {
    v128_t r0, g0, b0, r1, g1, b1;
    half8(wasm_u16x8_extend_low_u8x16(y), wasm_u16x8_extend_low_u8x16(u), wasm_u16x8_extend_low_u8x16(v), &r0, &g0, &b0);
    half8(wasm_u16x8_extend_high_u8x16(y), wasm_u16x8_extend_high_u8x16(u), wasm_u16x8_extend_high_u8x16(v), &r1, &g1, &b1);
    const v128_t r = wasm_u8x16_narrow_i16x8(r0, r1), g = wasm_u8x16_narrow_i16x8(g0, g1), b = wasm_u8x16_narrow_i16x8(b0, b1);   // saturates to 0..255
    const v128_t a = wasm_i8x16_splat((signed char)0xFF);
    const v128_t rg0 = wasm_i8x16_shuffle(r, g, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23);
    const v128_t rg1 = wasm_i8x16_shuffle(r, g, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31);
    const v128_t ba0 = wasm_i8x16_shuffle(b, a, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23);
    const v128_t ba1 = wasm_i8x16_shuffle(b, a, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31);
    wasm_v128_store(o, wasm_i8x16_shuffle(rg0, ba0, 0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23));
    wasm_v128_store(o + 16, wasm_i8x16_shuffle(rg0, ba0, 8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31));
    wasm_v128_store(o + 32, wasm_i8x16_shuffle(rg1, ba1, 0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23));
    wasm_v128_store(o + 48, wasm_i8x16_shuffle(rg1, ba1, 8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31));
}

// Reverse filter of 8 lanes (u16x8): t = clamp(4 * a - right - below - below-right, 0, 255); the value of a changes only on the lanes of `pm` where |t - a| >= 30
static inline v128_t filter8(v128_t a, v128_t right, v128_t below, v128_t belowRight, v128_t pm) {
    v128_t t = wasm_i16x8_sub(wasm_i16x8_sub(wasm_i16x8_sub(wasm_i16x8_shl(a, 2), right), below), belowRight);
    t = wasm_i16x8_min(wasm_i16x8_max(t, wasm_i16x8_splat(0)), wasm_i16x8_splat(255));
    const v128_t big = wasm_i16x8_ge(wasm_i16x8_abs(wasm_i16x8_sub(t, a)), wasm_i16x8_splat(FILTER_THRESHOLD));
    return wasm_v128_bitselect(t, a, wasm_v128_and(big, pm));
}

static inline v128_t filter16(v128_t a, v128_t right, v128_t below, v128_t belowRight, v128_t pm) {
    const v128_t lo = filter8(wasm_u16x8_extend_low_u8x16(a), wasm_u16x8_extend_low_u8x16(right), wasm_u16x8_extend_low_u8x16(below), wasm_u16x8_extend_low_u8x16(belowRight), pm);
    const v128_t hi = filter8(wasm_u16x8_extend_high_u8x16(a), wasm_u16x8_extend_high_u8x16(right), wasm_u16x8_extend_high_u8x16(below), wasm_u16x8_extend_high_u8x16(belowRight), pm);
    return wasm_u8x16_narrow_i16x8(lo, hi);
}

static inline int filter1(int a, int right, int below, int belowRight) {
    int t = (4 * a) - right - below - belowRight;
    t = (t < 0) ? 0 : ((t > 255) ? 255 : t);
    const int diff = t - a;
    return (((diff < 0) ? -diff : diff) >= FILTER_THRESHOLD) ? t : a;
}

/*
 * RGBA of the box [x, x + w) x [y, y + h) of the planes (stride pw, height ph) → out, tight rows, alpha 255. The reverse filter applies to the first
 * sample of every 2x2 block of the frame (even rows / columns counted from the destination origin: px = dx & 1, py = dy & 1 are the parities of
 * the origin); noFilter skips it (the caller knows that every block of the box holds one chroma value, so the filter cannot change anything).
 */
EXPORT("toRgba")
void to_rgba(const u8* Y, const u8* U, const u8* V, int pw, int ph, int x, int y, int w, int h, int px, int py, int noFilter, u8* out) {
    const v128_t pmEven = wasm_i16x8_make(-1, 0, -1, 0, -1, 0, -1, 0), pmOdd = wasm_i16x8_make(0, -1, 0, -1, 0, -1, 0, -1);
    const v128_t pm = (((x - px) & 1) == 0) ? pmEven : pmOdd;      // lanes of the block-first samples (16 samples per step: the parity does not change)
    for (int r = 0; r < h; r++) {
        const int sy = y + r;
        const u8 *yr = Y + (sy * pw) + x, *ur = U + (sy * pw) + x, *vr = V + (sy * pw) + x;
        u8* o = out + ((long)r * w * 4);
        const int filt = !noFilter && (((sy - py) & 1) == 0) && ((sy + 1) < ph);
        int k = 0;
        if (!filt) {
            for (; (k + 16) <= w; k += 16) { px16(wasm_v128_load(yr + k), wasm_v128_load(ur + k), wasm_v128_load(vr + k), o + (4 * k)); }
            for (; k < w; k++) { px1(yr[k], ur[k], vr[k], o + (4 * k)); }
            continue;
        }
        const u8 *ub = ur + pw, *vb = vr + pw;
        // a 16-sample step reads the right neighbour of its last sample: it must lie in the row (sx + 1 < pw)
        for (; ((k + 16) <= w) && ((x + k + 16) < pw); k += 16) {
            const v128_t uf = filter16(wasm_v128_load(ur + k), wasm_v128_load(ur + k + 1), wasm_v128_load(ub + k), wasm_v128_load(ub + k + 1), pm);
            const v128_t vf = filter16(wasm_v128_load(vr + k), wasm_v128_load(vr + k + 1), wasm_v128_load(vb + k), wasm_v128_load(vb + k + 1), pm);
            px16(wasm_v128_load(yr + k), uf, vf, o + (4 * k));
        }
        for (; k < w; k++) {
            int u = ur[k], v = vr[k];
            if ((((x + k - px) & 1) == 0) && ((x + k + 1) < pw)) {
                u = filter1(u, ur[k + 1], ub[k], ub[k + 1]);
                v = filter1(v, vr[k + 1], vb[k], vb[k + 1]);
            }
            px1(yr[k], u, v, o + (4 * k));
        }
    }
}

/*
 * Luma view (general_LumaToYUV444): `rows` rows of n samples. Y is copied, U and V (half resolution: one sample per two columns and per
 * two rows, the first row of the rectangle is even) are replicated over 2x2 blocks. dst rows start at (y + r) * pw + x. n may be odd.
 */
EXPORT("luma")
void luma(u8* Y, u8* U, u8* V, int pw, int x, int y, int n, int rows, const u8* sy, int syStride, const u8* su, const u8* sv, int cStride) {
    const int pairs = n >> 1;
    for (int r = 0; r < rows; r++) {
        const long d = ((long)(y + r) * pw) + x;
        __builtin_memcpy(Y + d, sy + ((long)r * syStride), (unsigned)n);
        const u8 *cu = su + ((long)(r >> 1) * cStride), *cv = sv + ((long)(r >> 1) * cStride);
        u8 *du = U + d, *dv = V + d;
        int i = 0;
        for (; (i + 8) <= pairs; i += 8) {
            const v128_t a = wasm_v128_load64_zero(cu + i), b = wasm_v128_load64_zero(cv + i);
            wasm_v128_store(du + (2 * i), wasm_i8x16_shuffle(a, a, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7));
            wasm_v128_store(dv + (2 * i), wasm_i8x16_shuffle(b, b, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7));
        }
        for (; i < pairs; i++) { du[2 * i] = du[(2 * i) + 1] = cu[i]; dv[2 * i] = dv[(2 * i) + 1] = cv[i]; }
        if (n & 1) { du[n - 1] = cu[pairs]; dv[n - 1] = cv[pairs]; }
    }
}

/*
 * Chroma view of AVC444v2 (general_ChromaV2ToYUV444): `rows` rows of n samples of the rectangle that starts at frame column fx0 (a multiple
 * of 16) and frame row fy0 (even) and at plane column x / row y. In every row the odd columns of U and V come from the luma plane of the
 * view: U from sY[c], V from sY[half + c] with c = (column - 1) / 2; in the odd rows the even columns come from the U and V planes of the view
 * (column 0 mod 4 from sU, 2 mod 4 from sV; V of the plane `quarter` samples further). A sample whose source column lies beyond the row of the
 * view (the halves are further apart than the picture is wide when the width is not a multiple of 32) is not written. sY points at the row
 * of the view that belongs to fy0, sU / sV at the chroma row of it.
 */
EXPORT("chromaV2")
void chroma_v2(u8* U, u8* V, int pw, int x, int y, int fx0, int n, int rows, const u8* sY, int vw, const u8* sU, const u8* sV, int cw, int half, int quarter) {
    for (int r = 0; r < rows; r++) {
        u8 *du = U + ((long)(y + r) * pw) + x, *dv = V + ((long)(y + r) * pw) + x;
        const u8* row = sY + ((long)r * vw);
        int k = 0;
        for (; (k + 16) <= n; k += 16) {
            const int c0 = (fx0 + k) >> 1;
            if (((c0 + 7) >= vw) || ((half + c0 + 7) >= vw)) { break; }
            const v128_t ou = wasm_v128_load(du + k), ov = wasm_v128_load(dv + k);
            wasm_v128_store(du + k, wasm_i8x16_shuffle(ou, wasm_v128_load64_zero(row + c0), 0, 16, 2, 17, 4, 18, 6, 19, 8, 20, 10, 21, 12, 22, 14, 23));
            wasm_v128_store(dv + k, wasm_i8x16_shuffle(ov, wasm_v128_load64_zero(row + half + c0), 0, 16, 2, 17, 4, 18, 6, 19, 8, 20, 10, 21, 12, 22, 14, 23));
        }
        for (; k < n; k++) {
            const int fx = fx0 + k;
            if (fx & 1) {
                const int c = (fx - 1) >> 1;
                if (c < vw) { du[k] = row[c]; }
                if ((half + c) < vw) { dv[k] = row[half + c]; }
            }
        }
        if (!(r & 1)) { continue; }
        const u8 *cu = sU + ((long)((r - 1) >> 1) * cw), *cv = sV + ((long)((r - 1) >> 1) * cw);
        k = 0;
        for (; (k + 16) <= n; k += 16) {
            const int q0 = (fx0 + k) >> 2;
            if (((q0 + 3) >= cw) || ((quarter + q0 + 3) >= cw)) { break; }
            const v128_t pu = wasm_i8x16_shuffle(wasm_v128_load32_zero(cu + q0), wasm_v128_load32_zero(cv + q0), 0, 16, 1, 17, 2, 18, 3, 19, 0, 0, 0, 0, 0, 0, 0, 0);
            const v128_t pv = wasm_i8x16_shuffle(wasm_v128_load32_zero(cu + quarter + q0), wasm_v128_load32_zero(cv + quarter + q0), 0, 16, 1, 17, 2, 18, 3, 19, 0, 0, 0, 0, 0, 0, 0, 0);
            const v128_t ou = wasm_v128_load(du + k), ov = wasm_v128_load(dv + k);
            wasm_v128_store(du + k, wasm_i8x16_shuffle(ou, pu, 16, 1, 17, 3, 18, 5, 19, 7, 20, 9, 21, 11, 22, 13, 23, 15));
            wasm_v128_store(dv + k, wasm_i8x16_shuffle(ov, pv, 16, 1, 17, 3, 18, 5, 19, 7, 20, 9, 21, 11, 22, 13, 23, 15));
        }
        for (; k < n; k++) {
            const int fx = fx0 + k;
            if (!(fx & 1)) {
                const int q = fx >> 2;
                const u8* pu = (fx & 2) ? cv : cu;
                if (q < cw) { du[k] = pu[q]; }
                if ((quarter + q) < cw) { dv[k] = pu[quarter + q]; }
            }
        }
    }
}
