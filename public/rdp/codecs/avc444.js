/**
* @description RDPGFX AVC444 / AVC444v2 (WebCodecs): two H.264 views combined into YUV444, converted to RGBA
* @license Apache-2.0
*
* MS-RDPEGFX 2.2.4.5 (RDPGFX_AVC444_BITMAP_STREAM), 3.3.8.3.2 (YUV420p stream combination for YUV444 mode) and the AVC444v2
* layout of 3.3.8.3.3. The combine step (B1..B9 of the two layouts), the reverse filter (threshold 30) and the colour matrix
* follow FreeRDP libfreerdp/primitives/prim_YUV.c (general_LumaToYUV444, general_ChromaV1ToYUV444, general_ChromaV2ToYUV444,
* general_YUV444ToRGB, YUV2R/G/B, CONDITIONAL_CLIP; Apache-2.0, Copyright 2014 Marc-Andre Moreau, 2015-2017 Armin Novak,
* Norbert Federa, Vic Lee, Thincast Technologies GmbH), re-implemented here with frame-origin addressing instead of the
* per-rectangle origin of FreeRDP (identical for macroblock-aligned rectangles, which are what servers send).
*
* The main (luma) view and the auxiliary (chroma) view are encoded by one encoder and decoded by ONE decoder as one H.264 stream
* (2.2.4.5): the luma chunk, then the chroma chunk, outputs matched by timestamp. The decoder is an Avc420Decoder (shared with AVC420 pictures
* of the surface), so every rule of avc420.js (ordering, deadlines, budgets, frame ownership) holds per frame. No DOM: the decoders come from `opts`
* (VideoDecoder, EncodedVideoChunk, timers), so Node tests use fakes.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'), require('./avc420.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.avc444 = factory(root.RdpShared.limits, root.RdpCodecs.errors, root.RdpCodecs.avc420);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, codecErrors, avc420) {
    'use strict';
    const CodecError = codecErrors.CodecError;

    const CODEC_AVC444 = 0x0E, CODEC_AVC444V2 = 0x0F;
    const LC_BOTH = 0, LC_LUMA = 1, LC_CHROMA = 2;
    const FILTER_THRESHOLD = 30;            // reverse filter: a change below this keeps the main-view value (3.3.8.3.2)
    const MAX_DIM = limits.SURFACE_MAX_DIM;

    function roundUp16(v) { return (v + 15) & ~15; }
    function roundUp32(v) { return (v + 31) & ~31; }

    const PROBE_TIMEOUT_MS = 3000;          // no result by then: the decoder does not work
    const PROBE_MAX_MS = 3000;              // decoding the probe pictures of both layouts (cold start included) takes longer: too slow

    // 64x64 YUV444 test picture (left half: columns alternate red / blue, right half: rows alternate green / magenta, lower 16 rows grey)
    // split into the main view and the auxiliary view of AVC444 (v1) and AVC444v2 (v2). Each layout is ONE H.264 stream made by one of
    // Chrome's own encoders (baseline 1.1, Annex B): the main view is the IDR picture, the auxiliary view the following P picture, as a
    // server sends it. Without the auxiliary view the left half would be all red and the right half all
    // green, so the probe cannot pass with a wrong combine step.
    const PROBE = {
        main1: '000000016742c01e8c684269a80808083c2211a80000000168ce3c800000000165b8000409fc3e10fc2d038070001500700e320f0e01c6401c038c83c7000101c8e000204dffffc250e01c6401c038c83c38071900700e320fc6023c21f0bc3800080308018cb0e000200c2021961c000401840432c380008030808658e000202b1c000409ef758ad62bc21f087b09c380008030808658700010061010cb0e000200c2021961c000401840432deebaf843e10f6138700010061010cb0e000200c2021961c000401840432c38000803080865bdf1fffe08a2800080b78e000203b1c000409ed45daed7',
        aux1: '0000000161e0007e409f361fb0587a81c000405c28c401c000405c280941e1c000405c2809401c000405c280941e0700010101b100700010101a90718700010101a90070001010185208f1c000424238000800e6ff66d87b8700010170a02500700010170a025078700010170a02500700010170a025078700010101a900700010101a904718700010101a90070001010185208f9bfe18070bcb001f2c03e3800088bc7000106dc466c9ac166ec161ed81c00040743ea00e000203a1ed0787000101d0f6803800080e87d41e070001016094803800080b04a41e1c000405825200e000202c10720f999b61d9b61ee1c00040743da00e000203a1ed0787000101d0f6803800080e870b41e1c000405825200e000202c12907870001016094803800080b041c83e68601c300d84e5800f96007e23364d60b3760b0f6c0e000204a0fa803800081283ea0f0e000204a0ba803800081283ea0af03800080e06c401c00040703620f0e00020381b1007000101c0c1083e666d8766d87b87000102507d401c00040941f50787000102505d401c00040941c3505787000101c0d8803800080e06c41e1c000407036200e0002038182107cd0c038601b09cb001f2c00fc462abc611555555555555555621710b885c0',
        main2: '000000016742c01e8c684269a80808083c2211a80000000168ce3c800000000165b8000409fc3e10fc2d038070001500700e320f0e01c6401c038c83c7000101c8e000204dffffc250e01c6401c038c83c38071900700e320fc6023c21f0bc3800080308018cb0e000200c2021961c000401840432c380008030808658e000202b1c000409ef758ad62bc21f087b09c380008030808658700010061010cb0e000200c2021961c000401840432deebaf843e10f6138700010061010cb0e000200c2021961c000401840432c38000803080865bdf1fffe08a2800080b78e000203b1c000409ed45daed7',
        aux2: '0000000161e0007e409f37fffc11450001036f1c000405e3800080bf2a0a40e00020460a029907000102305014c8380008118280a641c000408c1405320e00020460a029907000102105014c8380008118280a641c00040841405320e00020460a029907000102305014c8380008118280a641c000408c1405320e00020460a029907000102105014c8380008118280a641c00040841405321c00040d23800081566c3fff0452c007e38001a8e0006bc40520e00020162911c000402c5220e00020162911c000402c522380008058a447000100b1488e00020162911c000402c5220e00020162911c000402c5220e00020162911c000402c522380008058a447000100b1488e00020162911c000402c5223800084247000108ccf62f30043e10f61387000102907007b2c38000814838035961c00040a41c01acb0e00020520e00d65cee2bf0a41c000403c722380008078e441c000403c722380008078e447000100f1c88e000201e3911c000403c722380008078e441c000403c722380008078e441c000403c722380008078e447000100f1c88e000201e3911c000403c722380008078e447000109c8e00021499ef3421f087b09c3800081981c00b6587000103303801acb0e0002066070035961c00040cc0e006b2e77f8520e000202a1488e000202a14883800080a85223800080a85223800080a85223800080a85223800080a85223800080a85220e000202a1488e000202a14880e000203e600aa9607000101f300554b0e000202a1488e000202a14883800080f9802aa581c000407cc01552c380008554700010b4f8c22aaaaaaaaaaaaaaac42f10b885e'
    };


    // Payload → { lc, first, second }: Uint8Array views of the AVC420 streams (metablock + Annex B). second is null unless LC is 0.
    function parsePayload(src) {
        if (!(src instanceof Uint8Array)) { throw new CodecError('INVALID', 'source is not binary'); }
        if (src.length < 4) { throw new CodecError('TRUNCATED', 'AVC444 header'); }
        const info = new DataView(src.buffer, src.byteOffset, src.byteLength).getUint32(0, true);
        const lc = info >>> 30, size = info & 0x3FFFFFFF;
        if (lc === 3) { throw new CodecError('INVALID', 'AVC444 LC'); }
        const body = src.length - 4;
        if (lc !== LC_BOTH) { return { lc: lc, first: src.subarray(4), second: null }; }
        if ((size < 4) || (size > body)) { throw new CodecError('INVALID', 'AVC444 stream 1 length'); }
        if (body - size < 4) { throw new CodecError('TRUNCATED', 'AVC444 stream 2'); }
        return { lc: lc, first: src.subarray(4, 4 + size), second: src.subarray(4 + size) };
    }

    const SIMD_MAX_PIXELS = 4096 * 2304;
    const OUT_REGION_BYTES = 4 * 1024 * 1024;       // RGBA band of the SIMD kernel (the page reads at most this much at a time, gfx/client.js READ_BAND_BYTES)

    // The WebAssembly kernels (avc444-simd.js) are used only after they reproduced the JavaScript path on pseudo-random planes once: the filtered and the
    // unfiltered conversion, the luma combine and the AVC444v2 chroma combine. A module that is not available is remembered; a failed allocation is not
    // (a transient lack of memory must not switch the kernels off for the whole worker): the check runs again with the next surface.
    const simdChecked = new WeakMap();
    function simdWorks(simd) {
        if ((simd == null) || (typeof simd.create !== 'function')) { return false; }
        let ok = simdChecked.get(simd);
        if (ok !== undefined) { return ok; }
        if ((typeof simd.available === 'function') && !simd.available()) { simdChecked.set(simd, false); return false; }
        ok = false;
        try {
            const w = 48, h = 32;
            let seed = 0x5EED1234;
            const rnd = function () { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
            const a = new Yuv444Planes(w, h, null), b = new Yuv444Planes(w, h, { simd: simd, trusted: true });
            if (b.k === null) { return false; }
            const same = function (x, y) { for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) { return false; } } return true; };
            const mkView = function () {
                const v = { width: w, height: h, rs: 0, auxWidth: 64, y: new Uint8Array(w * h), u: new Uint8Array(w * h / 4), v: new Uint8Array(w * h / 4) };
                for (let i = 0; i < v.y.length; i++) { v.y[i] = rnd(); }
                for (let i = 0; i < v.u.length; i++) { v.u[i] = rnd(); v.v[i] = rnd(); }
                return v;
            };
            ok = true;
            for (let i = 0; i < a.y.length; i++) {
                a.y[i] = rnd(); a.u[i] = (rnd() & 3) ? 128 + (rnd() & 15) : rnd(); a.v[i] = (rnd() & 3) ? 120 + (rnd() & 15) : rnd();
            }
            b.y.set(a.y); b.u.set(a.u); b.v.set(a.v);
            for (const box of [{ x: 0, y: 0, width: w, height: h }, { x: 3, y: 2, width: 41, height: 29 }]) {
                for (const o of [0, 1]) {
                    for (const flat of [false, true]) {
                        if (!same(a.toRgba(box, o, o, null, flat), b.toRgba(box, o, o, null, flat))) { ok = false; }
                    }
                }
            }
            const regions = [{ x: 0, y: 0, width: w, height: h }];
            a.clear(); b.clear();
            const luma = mkView(), chroma = mkView();
            for (const q of [a, b]) { q.applyLuma(luma, regions, 0, 0); q.applyChromaV2(chroma, regions, 0, 0); }
            if (!same(a.y, b.y) || !same(a.u, b.u) || !same(a.v, b.v)) { ok = false; }
        } catch (ex) { return false; }
        simdChecked.set(simd, ok);
        return ok;
    }

    // Yuv444 planes of one surface (padded to 16, so every 2x2 block exists) with the combine step and the conversion to RGBA.
    // opts.simd: the avc444-simd.js module. The planes then live in a WebAssembly memory together with a region for the decoded views (scratchView)
    // and a region for RGBA bands, and the luma combine and the conversion run 16 samples at a time; the results are the same bytes.
    class Yuv444Planes {
        constructor(width, height, opts) {
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width < 1) || (height < 1) || (width > MAX_DIM) || (height > MAX_DIM)) {
                throw new CodecError('LIMIT', 'YUV444 plane size');
            }
            this.pw = roundUp16(width); this.ph = roundUp16(height);
            this.k = null;
            const simd = (opts && opts.simd) || null, budget = (opts && opts.budget) || null;
            const jsBytes = this.pw * this.ph * 3;
            let held = 0;               // asked from the budget before the memory exists (a refusal allocates nothing)
            try {
                // Larger surfaces keep the JavaScript path: SIMD_MAX_PIXELS is a pixel count (8192 x 1152 qualifies as well as 4096 x 2304)
                if ((simd !== null) && (this.pw * this.ph <= SIMD_MAX_PIXELS) && ((opts.trusted === true) || simdWorks(simd))) {
                    const kopts = { pw: this.pw, ph: this.ph, scratchBytes: Math.ceil(this.pw * this.ph * 1.5), outBytes: Math.min(OUT_REGION_BYTES, this.pw * this.ph * 4) };
                    const kb = (typeof simd.bytesFor === 'function') ? simd.bytesFor(kopts) : 0;
                    if (kb > 0) {
                        if (budget !== null) { budget.reserve(kb); held = kb; }
                        this.k = simd.create(kopts);
                        if ((this.k === null) && (held > 0)) { budget.release(held); held = 0; }
                    }
                }
                if (this.k !== null) {
                    const n = this.pw * this.ph;
                    this.y = this.k.y.subarray(0, n); this.u = this.k.u.subarray(0, n); this.v = this.k.v.subarray(0, n);
                    this.bytes = this.k.bytes;
                } else {
                    if (budget !== null) { budget.reserve(jsBytes); held = jsBytes; }
                    this.y = new Uint8Array(this.pw * this.ph);
                    this.u = new Uint8Array(this.pw * this.ph);
                    this.v = new Uint8Array(this.pw * this.ph);
                    this.bytes = jsBytes;
                }
            } catch (ex) {
                if ((held > 0) && (budget !== null)) { try { budget.release(held); } catch (e2) { /* budget already reset */ } }
                throw ex;
            }
        }

        // A buffer for a decoded view from the WebAssembly memory (the luma combine then reads it in place), or null
        scratchView(bytes) { return ((this.k !== null) && (bytes <= this.k.scratchBytes)) ? this.k.scratch.subarray(0, bytes) : null; }

        close() { this.k = null; }

        clear() { this.y.fill(0); this.u.fill(128); this.v.fill(128); }

        // Region (surface coordinates) → rectangle of the view in frame coordinates, grown to whole macroblocks (16x16 grid of the
        // picture; 3.3.8.3.2: colour conversion is done for the entire macroblock, the region mask is applied afterwards) and clipped to the view and
        // to the planes; null when empty. dx, dy: the destination rectangle origin (the H.264 picture starts there).
        _frameRect(r, dx, dy, view) {
            const x0 = Math.max(0, (r.x - dx) & ~15), y0 = Math.max(0, (r.y - dy) & ~15);
            const x1 = Math.min(roundUp16(r.x - dx + r.width), view.width, this.pw - dx), y1 = Math.min(roundUp16(r.y - dy + r.height), view.height, this.ph - dy);
            if ((r.x < dx) || (r.y < dy) || (x1 <= x0) || (y1 <= y0)) { return null; }
            return { x0: x0, y0: y0, x1: x1, y1: y1 };
        }

        // Rows [rs, re) of the view (frame coordinates, multiples of 16) that the regions need, or null when no region reaches the view.
        // Every layout keeps the data of a 16-row block of the picture inside the same 16-row block of the auxiliary view.
        bandOf(regions, dx, dy, width, height) {
            let rs = Infinity, re = 0;
            const probe = { width: width, height: height };
            for (const r of regions) {
                const f = this._frameRect(r, dx, dy, probe);
                if (f === null) { continue; }
                rs = Math.min(rs, f.y0); re = Math.max(re, roundUp16(f.y1));      // whole macroblock rows: a layout keeps a 16-row block inside the same block of the view (readView clamps to the picture)
            }
            return (re > rs) ? { rs: rs, re: re } : null;
        }

        // Luma view (main view B1 + B2/B3): Y of the region, half-resolution U/V replicated over the 2x2 blocks (general_LumaToYUV444).
        // view: { width, height, rs, y, u, v }: the rows from rs (a band of the picture, see bandOf), planar 4:2:0 with tight rows.
        // → the rectangles written, in surface coordinates (whole 2x2 blocks: inside them U and V are constant per block)
        applyLuma(view, regions, dx, dy) {
            const pw = this.pw, vw = view.width, cw = vw >> 1, rs = view.rs | 0, crs = rs >> 1;
            const written = [];
            const src = (this.k !== null) ? this._kernelSource(view) : null;
            for (const r of regions) {
                const f = this._frameRect(r, dx, dy, view);
                if (f === null) { continue; }
                written.push({ x: dx + f.x0, y: dy + f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0 });
                const n = f.x1 - f.x0;
                // The kernel reads rows [f.y0, f.y1) of the band and the chroma rows of them: the view must hold all of them
                if ((src !== null) && ((f.y0 & 1) === 0) && (f.y0 >= rs) && (((f.y1 - rs) * vw) <= view.y.length) && ((((((f.y1 - 1) >> 1) - crs) + 1) * cw) <= Math.min(view.u.length, view.v.length))) {
                    this.k.luma(dx + f.x0, dy + f.y0, n, f.y1 - f.y0, src.y + ((f.y0 - rs) * vw) + f.x0, vw,
                        src.u + (((f.y0 >> 1) - crs) * cw) + (f.x0 >> 1), src.v + (((f.y0 >> 1) - crs) * cw) + (f.x0 >> 1), cw);
                    continue;
                }
                for (let fy = f.y0; fy < f.y1; fy++) {
                    const dst = ((fy + dy) * pw) + dx + f.x0;
                    this.y.set(view.y.subarray(((fy - rs) * vw) + f.x0, ((fy - rs) * vw) + f.x1), dst);
                    if ((fy & 1) && (fy > f.y0)) {
                        // the same chroma row as the row above
                        this.u.copyWithin(dst, dst - pw, dst - pw + n);
                        this.v.copyWithin(dst, dst - pw, dst - pw + n);
                        continue;
                    }
                    const cu = view.u, cv = view.v, U = this.u, V = this.v;
                    let ci = (((fy >> 1) - crs) * cw) + (f.x0 >> 1), d = dst;
                    const end = dst + (n & ~1);
                    for (; d < end; d += 2, ci++) {
                        const a = cu[ci], b = cv[ci];
                        U[d] = a; U[d + 1] = a; V[d] = b; V[d + 1] = b;
                    }
                    if (n & 1) { U[d] = cu[ci]; V[d] = cv[ci]; }
                }
            }
            return written;
        }

        // The view in the memory of the kernel: in place when it was read into scratchView(), else copied there (null: does not fit)
        _kernelSource(view) {
            const k = this.k;
            if ((view.y.buffer === k.buffer) && (view.u.buffer === k.buffer) && (view.v.buffer === k.buffer)) { return { y: view.y.byteOffset, u: view.u.byteOffset, v: view.v.byteOffset }; }
            const ly = (view.y.length + 15) & ~15, lu = (view.u.length + 15) & ~15, lv = view.v.length;
            if (ly + lu + lv > k.scratchBytes) { return null; }
            k.scratch.set(view.y, 0); k.scratch.set(view.u, ly); k.scratch.set(view.v, ly + lu);
            return { y: k.scratchP, u: k.scratchP + ly, v: k.scratchP + ly + lu };
        }

        // Chroma view of AVC444 (layout v1, general_ChromaV1ToYUV444): the odd rows of U and V are the luma plane of the view in
        // blocks of 8 rows (U for rows y mod 16 < 8, V for the others); the odd columns of the even rows are its U and V planes.
        applyChromaV1(view, regions, dx, dy) {
            const pw = this.pw, vw = view.width, cw = vw >> 1, rs = view.rs | 0, crs = rs >> 1;
            for (const r of regions) {
                const f = this._frameRect(r, dx, dy, view);
                if (f === null) { continue; }
                for (let fy = f.y0; fy < f.y1; fy++) {
                    const dst = ((fy + dy) * pw) + dx;
                    if (fy & 1) {
                        const k = (fy - 1) >> 1, aux = ((k >> 3) * 16) + (k & 7);
                        const uRow = aux, vRow = aux + 8;
                        if (vRow >= ((view.re != null) ? view.re : view.height)) { continue; }
                        for (let fx = f.x0; fx < f.x1; fx++) {
                            this.u[dst + fx] = view.y[((uRow - rs) * vw) + fx];
                            this.v[dst + fx] = view.y[((vRow - rs) * vw) + fx];
                        }
                    } else {
                        const crow = ((fy >> 1) - crs) * cw;
                        for (let fx = f.x0 | 1; fx < f.x1; fx += 2) {
                            this.u[dst + fx] = view.u[crow + (fx >> 1)];
                            this.v[dst + fx] = view.v[crow + (fx >> 1)];
                        }
                    }
                }
            }
        }

        // Chroma view of AVC444v2 (general_ChromaV2ToYUV444): the odd columns of every row are the left (U) and right (V) halves of
        // the luma plane of the view; in the odd rows the columns 0 mod 4 come from its U plane (U left, V right half) and the
        // columns 2 mod 4 from its V plane. The halves are `view.auxWidth` / 2 apart (default: the width of the view); the decoder passes the
        // surface width rounded up to 32 like FreeRDP yuv.c.
        applyChromaV2(view, regions, dx, dy) {
            const pw = this.pw, vw = view.width, cw = vw >> 1, rs = view.rs | 0, crs = rs >> 1;
            const total = (view.auxWidth != null) ? view.auxWidth : vw, half = total >> 1, quarter = total >> 2;
            const src = (this.k !== null) ? this._kernelSource(view) : null;
            for (const r of regions) {
                const f = this._frameRect(r, dx, dy, view);
                if (f === null) { continue; }
                if ((src !== null) && ((f.y0 & 1) === 0) && (f.y0 >= rs) && (((f.y1 - rs) * vw) <= view.y.length) && ((((((f.y1 - 1) >> 1) - crs) + 1) * cw) <= Math.min(view.u.length, view.v.length))) {
                    const cRow = ((f.y0 >> 1) - crs) * cw;
                    this.k.chromaV2(dx + f.x0, dy + f.y0, f.x0, f.x1 - f.x0, f.y1 - f.y0, src.y + ((f.y0 - rs) * vw), vw, src.u + cRow, src.v + cRow, cw, half, quarter);
                    continue;
                }
                for (let fy = f.y0; fy < f.y1; fy++) {
                    const dst = ((fy + dy) * pw) + dx;
                    // A sample that would lie beyond the row of the picture (the half offset is wider than the picture when the width is not
                    // a multiple of 32) is not in the stream: FreeRDP reads decoder padding there; the value of the main view stays
                    for (let fx = f.x0 | 1; fx < f.x1; fx += 2) {
                        const s = ((fy - rs) * vw) + ((fx - 1) >> 1);
                        const c = (fx - 1) >> 1;
                        if (c < vw) { this.u[dst + fx] = view.y[s]; }
                        if (half + c < vw) { this.v[dst + fx] = view.y[s + half]; }
                    }
                    if (fy & 1) {
                        const crow = (((fy - 1) >> 1) - crs) * cw;
                        for (let fx = f.x0 + ((f.x0 & 1) ? 1 : 0); fx < f.x1; fx += 2) {
                            const q = fx >> 2;
                            const pu = (fx & 2) ? view.v : view.u;
                            if (q < cw) { this.u[dst + fx] = pu[crow + q]; }
                            if (quarter + q < cw) { this.v[dst + fx] = pu[crow + quarter + q]; }
                        }
                    }
                }
            }
        }

        // RGBA of box (surface coordinates, inside the planes) → out (a Uint8ClampedArray; tight rows, alpha 255). The 2x2 blocks start at the even
        // frame coordinates (surface minus the destination origin): the main-view chroma of the first sample of a block is
        // the average of the four, so the reverse filter recovers it (3.3.8.3.2); a change below the threshold keeps the value.
        // flat: the caller knows that U and V are constant inside every 2x2 block of the box (the luma view was just combined over it and nothing
        // else), so the filter cannot change a value (4 * c - 3 * c = c) and is skipped. out == null with the WebAssembly kernel: the result is a view
        // of the kernel's band region, valid until the next call (a box that does not fit the region is converted in bands into a new array).
        toRgba(box, dx, dy, out, flat) {
            if (!Number.isSafeInteger(box.x) || !Number.isSafeInteger(box.y) || !Number.isSafeInteger(box.width) || !Number.isSafeInteger(box.height) ||
                (box.x < 0) || (box.y < 0) || (box.width < 1) || (box.height < 1) || (box.x + box.width > this.pw) || (box.y + box.height > this.ph)) { throw new CodecError('LIMIT', 'box outside the planes'); }
            const need = box.width * box.height * 4;
            if ((out != null) && (out.length < need)) { throw new CodecError('INTERNAL', 'output buffer'); }
            const noFilter = (flat === true);
            const k = this.k;
            if (k !== null) {
                const rows = k.rowsFit(box.width);
                if (rows >= box.height) {
                    const view = k.toRgba(box, dx, dy, noFilter);
                    if (out == null) { return view; }
                    new Uint8Array(out.buffer, out.byteOffset, need).set(new Uint8Array(view.buffer, view.byteOffset, need));
                    return out;
                }
                if (rows >= 1) {
                    const dst = (out != null) ? out : new Uint8ClampedArray(need);
                    const bytes = new Uint8Array(dst.buffer, dst.byteOffset, need);
                    for (let y = 0; y < box.height; y += rows) {
                        const part = { x: box.x, y: box.y + y, width: box.width, height: Math.min(rows, box.height - y) };
                        const view = k.toRgba(part, dx, dy, noFilter);
                        bytes.set(new Uint8Array(view.buffer, view.byteOffset, part.width * part.height * 4), y * box.width * 4);
                    }
                    return dst;
                }
            }
            return this._toRgbaJs(box, dx, dy, (out != null) ? out : new Uint8ClampedArray(need), noFilter);
        }

        _toRgbaJs(box, dx, dy, dst, noFilter) {
            const pw = this.pw, ph = this.ph, Y = this.y, U = this.u, V = this.v;
            const px = dx & 1, py = dy & 1, x0 = box.x, x1 = box.x + box.width, y1 = box.y + box.height;
            let o = 0;
            for (let sy = box.y; sy < y1; sy++) {
                const row = sy * pw;
                // Only the first sample of a 2x2 block (even frame row and column) is filtered, and only with its right and lower neighbours inside the planes
                const filt = !noFilter && (((sy - py) & 1) === 0) && (sy + 1 < ph);
                const partnerRow = row + pw;
                for (let sx = x0; sx < x1; sx++, o += 4) {
                    const i = row + sx;
                    let u = U[i], v = V[i];
                    if (filt && (((sx - px) & 1) === 0) && (sx + 1 < pw)) {
                        const j = partnerRow + sx;
                        let t = (4 * u) - U[i + 1] - U[j] - U[j + 1];
                        t = (t < 0) ? 0 : ((t > 255) ? 255 : t);
                        if (Math.abs(t - u) >= FILTER_THRESHOLD) { u = t; }
                        t = (4 * v) - V[i + 1] - V[j] - V[j + 1];
                        t = (t < 0) ? 0 : ((t > 255) ? 255 : t);
                        if (Math.abs(t - v) >= FILTER_THRESHOLD) { v = t; }
                    }
                    const c = Y[i] << 8, d = u - 128, e = v - 128;
                    dst[o] = (c + (403 * e)) >> 8;
                    dst[o + 1] = (c - (48 * d) - (120 * e)) >> 8;
                    dst[o + 2] = (c + (475 * d)) >> 8;
                    dst[o + 3] = 255;
                }
            }
            return dst;
        }
    }

    // VideoFrame → { width, height, rs, y, u, v }: rows [rs, re) (multiples of 16) of the macroblock-aligned picture (the visible size rounded
    // up to 16: the size the encoder laid the auxiliary view out in) as planar 4:2:0 with tight rows. I420 and NV12 (hardware decoders) are
    // read; only the band is copied. Some decoders report a coded height that is not a multiple of 16 (Chrome's software decoder: 66 for 64),
    // so only the visible size decides. scratch: { get(bytes), getUV(bytes) } reusable buffers.
    async function readView(frame, scratch, rs, re) {
        const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
        if ((vr.x !== 0) || (vr.y !== 0)) { throw new CodecError('UNSUPPORTED', 'H.264 picture with a cropped origin'); }
        const w = roundUp16(vr.width), h = roundUp16(vr.height);
        if ((vr.width < 1) || (vr.height < 1) || (w > MAX_DIM) || (h > MAX_DIM)) { throw new CodecError('INVALID', 'size of the H.264 picture'); }
        if ((frame.codedWidth < w) || (frame.codedHeight < h)) { throw new CodecError('UNSUPPORTED', 'the decoder returned less than the macroblock-aligned H.264 picture'); }
        if (rs == null) { rs = 0; re = h; }
        re = Math.min(re, h);
        if ((rs < 0) || (rs >= re) || ((rs & 15) !== 0)) { throw new CodecError('INTERNAL', 'band of the H.264 picture'); }
        const bh = re - rs, ys = w * bh, cs = ys >> 2, fmt = frame.format;
        const rect = { x: 0, y: rs, width: w, height: bh };
        if (fmt === 'I420') {
            const buf = scratch.get(ys + cs + cs);
            await frame.copyTo(buf, { rect: rect, layout: [{ offset: 0, stride: w }, { offset: ys, stride: w >> 1 }, { offset: ys + cs, stride: w >> 1 }] });
            return { width: w, height: h, rs: rs, re: re, y: buf.subarray(0, ys), u: buf.subarray(ys, ys + cs), v: buf.subarray(ys + cs, ys + cs + cs) };
        }
        if (fmt === 'NV12') {
            const buf = scratch.get(ys + cs + cs);
            await frame.copyTo(buf, { rect: rect, layout: [{ offset: 0, stride: w }, { offset: ys, stride: w }] });
            const uv = buf.subarray(ys, ys + cs + cs), planes = scratch.getUV(cs + cs);
            const u = planes.subarray(0, cs), v = planes.subarray(cs, cs + cs);
            for (let i = 0; i < cs; i++) { u[i] = uv[2 * i]; v[i] = uv[(2 * i) + 1]; }
            return { width: w, height: h, rs: rs, re: re, y: buf.subarray(0, ys), u: u, v: v };
        }
        throw new CodecError('UNSUPPORTED', 'VideoFrame format ' + String(fmt) + ': the decoder gives no CPU readable YUV420');
    }

    class Avc444Decoder {
        // opts: { budget, codecId (0x0E | 0x0F), decoder (a shared Avc420Decoder of the surface, MS-RDPEGFX 2.2.4.5: both views are one H.264
        // stream of one decoder; without it the decoder makes its own), VideoDecoder, EncodedVideoChunk, setTimeout, clearTimeout, decodeTimeoutMs }
        constructor(opts) {
            opts = opts || {};
            if ((opts.codecId !== CODEC_AVC444) && (opts.codecId !== CODEC_AVC444V2)) { throw new CodecError('INVALID', 'AVC444 codec id'); }
            this.opts = opts;
            this.budget = opts.budget || null;
            this.v2 = (opts.codecId === CODEC_AVC444V2);
            // The views are read back to the CPU as YUV, so the decoder is software (deterministic I420; hardware frames are often NV12 or GPU-only)
            this.ownsDecoder = (opts.decoder == null);
            this.dec = this.ownsDecoder ? new avc420.Avc420Decoder(Object.assign({}, opts, { hardwareAcceleration: 'prefer-software' })) : opts.decoder;
            if (!this.ownsDecoder && (typeof this.dec.preferSoftware === 'function')) { this.dec.preferSoftware(); }
            this.planes = null;
            this.planesBytes = 0;       // charged to the budget
            this.scratchBytes = 0;      // charged to the budget
            this.scratchBuf = null;
            this.uvBuf = null;
            this.closed = false;
            const self = this;
            this.scratch = { get: function (bytes) { return self._scratch(bytes); }, getUV: function (bytes) { return self._scratchUV(bytes); } };
        }

        _scratch(bytes) {
            // With the WebAssembly kernel the decoded view is read straight into its memory (the combine then reads it in place)
            const inKernel = (this.planes !== null) ? this.planes.scratchView(bytes) : null;
            if (inKernel !== null) { return inKernel; }
            if ((this.scratchBuf === null) || (this.scratchBuf.length < bytes)) {
                if (this.budget) { this.budget.reserve(bytes - (this.scratchBuf ? this.scratchBuf.length : 0)); }
                this.scratchBytes += bytes - (this.scratchBuf ? this.scratchBuf.length : 0);
                this.scratchBuf = new Uint8Array(bytes);
            }
            return this.scratchBuf;
        }

        _scratchUV(bytes) {
            if ((this.uvBuf === null) || (this.uvBuf.length < bytes)) {
                if (this.budget) { this.budget.reserve(bytes - (this.uvBuf ? this.uvBuf.length : 0)); }
                this.scratchBytes += bytes - (this.uvBuf ? this.uvBuf.length : 0);
                this.uvBuf = new Uint8Array(bytes);
            }
            return this.uvBuf;
        }

        _ensurePlanes(ctx) {
            if (this.planes !== null) {
                if ((this.planes.pw !== roundUp16(ctx.surfaceWidth)) || (this.planes.ph !== roundUp16(ctx.surfaceHeight))) { throw new CodecError('INVALID', 'surface size changed'); }
                return;
            }
            // The planes ask the budget themselves, before their memory is allocated
            const p = new Yuv444Planes(ctx.surfaceWidth, ctx.surfaceHeight, { simd: this.opts.simd || null, budget: this.budget });
            p.clear();
            this.planes = p; this.planesBytes = p.bytes;
        }

        // → Promise<null | { regions, combine(), toRgba(box, out), close() }>. Validation errors throw synchronously (CodecError).
        submit(src, ctx) {
            if (this.closed) { throw new CodecError('INTERNAL', 'decoder closed'); }
            const parts = parsePayload(src);
            if (!ctx || !Number.isSafeInteger(ctx.surfaceWidth) || !Number.isSafeInteger(ctx.surfaceHeight) || (ctx.destRect == null)) { throw new CodecError('INVALID', 'context'); }
            this._ensurePlanes(ctx);
            let lumaStream = null, chromaStream = null;
            if (parts.lc === LC_BOTH) { lumaStream = parts.first; chromaStream = parts.second; }
            else if (parts.lc === LC_LUMA) { lumaStream = parts.first; }
            else { chromaStream = parts.first; }
            const subctx = { surfaceWidth: ctx.surfaceWidth, surfaceHeight: ctx.surfaceHeight, destRect: ctx.destRect };
            let pl = null, pc = null;
            try {
                // One stream: the luma chunk first, then the chroma chunk (decode order = outputs matched by timestamp)
                if (lumaStream !== null) { pl = this.dec.submit(lumaStream, subctx); }
                if (chromaStream !== null) { pc = this.dec.submit(chromaStream, subctx); }
            } catch (ex) {
                // The first view is in flight: nobody will draw it, so its frame is closed as soon as it arrives. The picture cannot
                // be submitted again (the H.264 reference chain of the first view already advanced), so even a full budget ends the session.
                if (pl !== null) {
                    pl.then(function (r) { if (r) { r.frame.close(); } }, function () { /* failed */ });
                    if (ex.budget === true) { throw new CodecError('LIMIT', 'browser memory budget (second view)'); }
                }
                throw ex;
            }
            const self = this, dest = ctx.destRect;
            return settleViews(pl, pc).then(function (views) {
                if (views === null) { return null; }
                return self._result(views.luma, views.chroma, dest, roundUp32(ctx.surfaceWidth));
            });
        }

        _result(lumaResult, chromaResult, dest, auxWidth) {
            const self = this;
            const frames = [];
            if (lumaResult) { frames.push(lumaResult.frame); }
            if (chromaResult) { frames.push(chromaResult.frame); }
            const regions = [];
            if (lumaResult) { for (const r of lumaResult.regions) { regions.push(r); } }
            if (chromaResult) { for (const r of chromaResult.regions) { regions.push(r); } }
            let combined = false, closed = false;
            let flatRects = null;      // LC 1: the rectangles the luma view was combined over (U and V constant per 2x2 block inside them)
            const closeAll = function () {
                if (closed) { return; }
                closed = true;
                for (const f of frames) { try { f.close(); } catch (ex) { /* already closed */ } }
            };
            return {
                regions: regions,
                // The VideoFrame of a luma-only picture (LC 1) until combine() / close() (the page may read it through the browser's own conversion)
                lumaOnlyFrame: (lumaResult && !chromaResult) ? lumaResult.frame : null,
                combine: async function () {
                    if (combined || closed) { return; }
                    combined = true;
                    try {
                        if (self.closed || (self.planes === null)) { return; }
                        if (lumaResult) {
                            const band = self.planes.bandOf(lumaResult.regions, dest.x, dest.y, self._pictureWidth(lumaResult.frame), self._pictureHeight(lumaResult.frame));
                            if (band !== null) {
                                const view = await readView(lumaResult.frame, self.scratch, band.rs, band.re);
                                if (self.closed) { return; }
                                const written = self.planes.applyLuma(view, lumaResult.regions, dest.x, dest.y);
                                if (!chromaResult && ((dest.x & 1) === 0) && ((dest.y & 1) === 0)) { flatRects = written; }
                            }
                        }
                        if (chromaResult) {
                            const band = self.planes.bandOf(chromaResult.regions, dest.x, dest.y, self._pictureWidth(chromaResult.frame), self._pictureHeight(chromaResult.frame));
                            if (band !== null) {
                                const view = await readView(chromaResult.frame, self.scratch, band.rs, band.re);
                                if (self.closed) { return; }
                                // FreeRDP yuv.c:503-504: MIN(roundUp32(surface width), the decoder's stride); a picture narrower than the surface lays its halves out by its own width
                                view.auxWidth = Math.min(auxWidth, roundUp32(view.width));
                                if (self.v2) { self.planes.applyChromaV2(view, chromaResult.regions, dest.x, dest.y); }
                                else { self.planes.applyChromaV1(view, chromaResult.regions, dest.x, dest.y); }
                            }
                        }
                    } catch (ex) {
                        if (ex instanceof CodecError) { throw ex; }
                        throw (ex && (ex.name === 'NotSupportedError')) ? new CodecError('UNSUPPORTED', 'reading the H.264 picture') : codecErrors.toCodecError(ex);
                    } finally { closeAll(); }
                },
                // out == null: with the WebAssembly kernel the pixels are a view of its band region (valid until the next call; see zeroCopy)
                toRgba: function (box, out) {
                    if (self.closed || (self.planes === null)) { throw new CodecError('INTERNAL', 'decoder closed'); }
                    return self.planes.toRgba(box, dest.x, dest.y, out, (flatRects !== null) && coveredBy(box, flatRects));
                },
                get zeroCopy() { return (self.planes !== null) && (self.planes.k !== null); },
                close: closeAll
            };
        }

        // The WebAssembly kernels run this decoder's combine / conversion (dev statistics)
        get simd() { return (this.planes !== null) && (this.planes.k !== null); }

        _pictureWidth(frame) { const vr = frame.visibleRect; return roundUp16(vr ? vr.width : frame.codedWidth); }
        _pictureHeight(frame) { const vr = frame.visibleRect; return roundUp16(vr ? vr.height : frame.codedHeight); }

        // RESETGRAPHICS, DELETESURFACE: drop everything in flight; unresolved submissions resolve to null. A shared decoder is reset by its owner.
        reset() {
            if (this.ownsDecoder) { this.dec.reset(); }
            if (this.planes !== null) { this.planes.clear(); }
        }

        close() {
            this.closed = true;
            if (this.ownsDecoder) { this.dec.close(); }
            this.planes = null; this.scratchBuf = null; this.uvBuf = null;
            const n = this.planesBytes + this.scratchBytes;
            this.planesBytes = 0; this.scratchBytes = 0;
            if (this.budget && (n > 0)) { try { this.budget.release(n); } catch (ex) { /* budget already reset */ } }
        }
    }

    // box inside one of the rectangles
    function coveredBy(box, rects) {
        for (const r of rects) {
            if ((box.x >= r.x) && (box.y >= r.y) && (box.x + box.width <= r.x + r.width) && (box.y + box.height <= r.y + r.height)) { return true; }
        }
        return false;
    }

    function hex(str) { const b = new Uint8Array(str.length / 2); for (let i = 0; i < b.length; i++) { b[i] = parseInt(str.substr(i * 2, 2), 16); } return b; }

    // RDPGFX_AVC420_BITMAP_STREAM of one 64x64 region
    function probeStream(bits) {
        const m = new Uint8Array(4 + 8 + 2 + bits.length), dv = new DataView(m.buffer);
        dv.setUint32(0, 1, true); dv.setUint16(8, 64, true); dv.setUint16(10, 64, true); m[12] = 22; m[13] = 100; m.set(bits, 14);
        return m;
    }

    function probeChecks(px) {
        const at = function (x, y) { const o = ((y * 64) + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
        const red = at(8, 8), blue = at(9, 8), green = at(40, 8), magenta = at(40, 9), grey = at(8, 56);
        return (red[0] > 150) && (red[2] < 110) && (blue[2] > 150) && (blue[0] < 110) &&
            (green[1] > 150) && (green[0] < 110) && (green[2] < 110) && (magenta[0] > 150) && (magenta[2] > 150) && (magenta[1] < 110) &&
            grey.every(function (c) { return (c > 100) && (c < 156); });
    }

    // { ok, decodeMs }: decodes the built-in pictures of both layouts for real (two decoders each), combines the views and checks the pixels
    Avc444Decoder.probe = async function (opts) {
        opts = opts || {};
        const VD = opts.VideoDecoder || ((typeof VideoDecoder !== 'undefined') ? VideoDecoder : null);
        const Chunk = opts.EncodedVideoChunk || ((typeof EncodedVideoChunk !== 'undefined') ? EncodedVideoChunk : null);
        const now = opts.now || ((typeof performance !== 'undefined') ? function () { return performance.now(); } : function () { return Date.now(); });
        const timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : PROBE_TIMEOUT_MS;
        const maxMs = (opts.maxMs != null) ? opts.maxMs : PROBE_MAX_MS;
        const setT = opts.setTimeout || ((typeof setTimeout !== 'undefined') ? setTimeout : null);
        const clrT = opts.clearTimeout || ((typeof clearTimeout !== 'undefined') ? clearTimeout : null);
        const fail = { ok: false, decodeMs: 0 };
        if ((VD === null) || (Chunk === null)) { return fail; }
        const t0 = now();
        const ctx = { surfaceWidth: 64, surfaceHeight: 64, destRect: { x: 0, y: 0, width: 64, height: 64 } };
        let timer = null, dec = null;
        try {
            const guard = new Promise(function (resolve, reject) { if (setT !== null) { timer = setT(function () { reject(new Error('probe timeout')); }, timeoutMs); } });
            const run = async function () {
                for (const v of [{ id: CODEC_AVC444, main: PROBE.main1, aux: PROBE.aux1 }, { id: CODEC_AVC444V2, main: PROBE.main2, aux: PROBE.aux2 }]) {
                    dec = new Avc444Decoder({ VideoDecoder: VD, EncodedVideoChunk: Chunk, codecId: v.id, setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout, decodeTimeoutMs: timeoutMs });
                    const a = probeStream(hex(v.main)), b = probeStream(hex(v.aux));
                    const src = new Uint8Array(4 + a.length + b.length);
                    new DataView(src.buffer).setUint32(0, a.length, true); src.set(a, 4); src.set(b, 4 + a.length);
                    const r = await dec.submit(src, ctx);
                    if (r === null) { return false; }
                    try {
                        await r.combine();
                        if (!probeChecks(r.toRgba({ x: 0, y: 0, width: 64, height: 64 }))) { return false; }
                    } finally { r.close(); }
                    dec.close(); dec = null;
                }
                return true;
            };
            const ok = await Promise.race([run(), guard]);
            const ms = Math.round((now() - t0) * 10) / 10;
            return { ok: (ok === true) && (ms <= maxMs), decodeMs: Math.min(ms, 60000) };
        } catch (ex) {
            return fail;
        } finally {
            if (timer !== null) { clrT(timer); }
            if (dec !== null) { try { dec.close(); } catch (ex) { /* closed */ } }
        }
    };

    // Both views (the ones that were submitted) → { luma, chroma }, or null when a decoder was reset meanwhile. The first failure rejects
    // at once (a hung second decoder must not delay the error to its deadline); frames that are not used are closed, also the ones
    // that arrive later.
    function settleViews(pl, pc) {
        return new Promise(function (resolve, reject) {
            const got = { luma: null, chroma: null };
            let waiting = 0, done = false;
            const closeFrame = function (v) { if (v) { try { v.frame.close(); } catch (ex) { /* closed */ } } };
            const end = function () { done = true; closeFrame(got.luma); closeFrame(got.chroma); got.luma = got.chroma = null; };
            const watch = function (p, key) {
                if (p === null) { return; }
                waiting++;
                p.then(function (v) {
                    if (done) { closeFrame(v); return; }
                    if (v === null) { end(); resolve(null); return; }
                    got[key] = v;
                    if (--waiting === 0) { done = true; resolve(got); }
                }, function (err) {
                    if (done) { return; }
                    end(); reject(err);
                });
            };
            watch(pl, 'luma');
            watch(pc, 'chroma');
        });
    }

    return Object.freeze({
        Avc444Decoder: Avc444Decoder, Yuv444Planes: Yuv444Planes, parsePayload: parsePayload, readView: readView, PROBE: PROBE,
        CODEC_AVC444: CODEC_AVC444, CODEC_AVC444V2: CODEC_AVC444V2, FILTER_THRESHOLD: FILTER_THRESHOLD
    });
});
