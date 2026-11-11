/**
* @description WebAssembly SIMD kernels for AVC444: YUV444 to RGBA with the reverse filter, and the luma-view combine (optional accelerator of avc444.js)
* @license Apache-2.0
*
* The kernels are written in C (tools/avc444-simd/avc444-simd.c, built by tools/avc444-simd/build.sh) and embedded below as base64. They compute
* exactly what the JavaScript code of avc444.js computes (the tests compare both on random planes), only 16 samples at a time. No DOM, no
* allocation after create(): one WebAssembly.Memory per surface holds the YUV444 planes, a region for the decoded views and a region for RGBA bands.
* create() returns null when WebAssembly SIMD is not available; avc444.js then runs its JavaScript path. The page CSP of MeshCentral allows
* 'wasm-unsafe-eval'; where a CSP forbids compiling WebAssembly the compile fails and the JavaScript path stays in use.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory();
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.avc444simd = factory();
    }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';

    /* GENERATED BEGIN */
    // Built by tools/avc444-simd/build.sh from tools/avc444-simd/avc444-simd.c; `build.sh --check` rebuilds and compares
    const WASM_TOOLCHAIN = 'Debian clang version 14.0.6';
    const WASM_SHA256 = 'c03ff4d6335cbda7e5aea280e9b81f1afbfc38a9b7043a8a5b3c8486fa10d183';
    const WASM_BASE64 =
        "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";
    /* GENERATED END */

    const PAGE = 65536;             // WebAssembly page; the first page holds the stack and static data of the module
    const MAX_PAGES = 30000;        // below 2 GiB
    function align64(n) { return (n + 63) & ~63; }

    let compiled;                   // undefined: not tried, null: not available, else WebAssembly.Module
    function compile() {
        if (compiled !== undefined) { return compiled; }
        compiled = null;
        try {
            if ((typeof WebAssembly !== 'object') || (WebAssembly === null) || (typeof WebAssembly.Module !== 'function') || (WASM_BASE64 === '')) { return compiled; }
            let bytes;
            if (typeof Buffer !== 'undefined') { bytes = new Uint8Array(Buffer.from(WASM_BASE64, 'base64')); }
            else { const bin = atob(WASM_BASE64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); } }
            if (WebAssembly.validate(bytes)) { compiled = new WebAssembly.Module(bytes); }
        } catch (ex) { compiled = null; }
        return compiled;
    }

    class Avc444Kernel {
        constructor(instance, memory, layout) {
            this.ex = instance.exports;
            this.memory = memory;
            this.buffer = memory.buffer;
            this.pw = layout.pw; this.ph = layout.ph;
            this.yP = layout.yP; this.uP = layout.uP; this.vP = layout.vP; this.scratchP = layout.scratchP; this.outP = layout.outP;
            this.scratchBytes = layout.scratchBytes; this.outBytes = layout.outBytes;
            const n = layout.planeBytes;
            this.y = new Uint8Array(this.buffer, this.yP, n);
            this.u = new Uint8Array(this.buffer, this.uP, n);
            this.v = new Uint8Array(this.buffer, this.vP, n);
            this.scratch = new Uint8Array(this.buffer, this.scratchP, this.scratchBytes);
            this.out = new Uint8ClampedArray(this.buffer, this.outP, this.outBytes);
            this.bytes = layout.total;
        }

        // Rows of `width` RGBA pixels that fit in the output region
        rowsFit(width) { return Math.floor(this.outBytes / (width * 4)); }

        // RGBA of the box → a view of the output region (valid until the next call), tight rows. The caller checked the box and rowsFit().
        toRgba(box, dx, dy, noFilter) {
            this.ex.toRgba(this.yP, this.uP, this.vP, this.pw, this.ph, box.x, box.y, box.width, box.height, dx & 1, dy & 1, noFilter ? 1 : 0, this.outP);
            return this.out.subarray(0, box.width * box.height * 4);
        }

        // Chroma view of AVC444v2: see tools/avc444-simd/avc444-simd.c. x, row: plane position of the rectangle; fx0: its frame column; srcY, srcU, srcV: pointers
        // to the row of the view (and the chroma row) that belongs to its first row
        chromaV2(x, row, fx0, n, rows, srcY, vw, srcU, srcV, cw, half, quarter) {
            this.ex.chromaV2(this.uP, this.vP, this.pw, x, row, fx0, n, rows, srcY, vw, srcU, srcV, cw, half, quarter);
        }

        // Luma view: y/u/v are Uint8Arrays of this memory. Rows from planes row `row`, column `x`, `n` samples, `rows` rows; sources are pointers.
        luma(x, row, n, rows, srcY, srcYStride, srcU, srcV, srcCStride) {
            this.ex.luma(this.yP, this.uP, this.vP, this.pw, x, row, n, rows, srcY, srcYStride, srcU, srcV, srcCStride);
        }
    }

    // The layout of one memory: { planeBytes, scratchBytes, outBytes, yP, uP, vP, scratchP, outP, total, pages }
    function layoutOf(opts) {
        const planeBytes = align64(opts.pw * opts.ph), scratchBytes = align64(opts.scratchBytes), outBytes = align64(opts.outBytes);
        const yP = PAGE, uP = yP + planeBytes, vP = uP + planeBytes, scratchP = vP + planeBytes, outP = scratchP + scratchBytes, total = outP + outBytes;
        return { planeBytes: planeBytes, scratchBytes: scratchBytes, outBytes: outBytes, yP: yP, uP: uP, vP: vP, scratchP: scratchP, outP: outP, total: total, pages: Math.ceil(total / PAGE) };
    }

    // Bytes of the memory create() allocates for the same opts (so that a budget can be asked before the allocation), or 0 when create() would refuse
    function bytesFor(opts) {
        const l = layoutOf(opts);
        return (l.pages > MAX_PAGES) ? 0 : l.pages * PAGE;
    }

    // opts: { pw, ph (planes, already rounded to 16), scratchBytes, outBytes } → Avc444Kernel | null
    function create(opts) {
        const mod = compile();
        if (mod === null) { return null; }
        try {
            const l = layoutOf(opts), planeBytes = l.planeBytes, scratchBytes = l.scratchBytes, outBytes = l.outBytes;
            const yP = l.yP, uP = l.uP, vP = l.vP, scratchP = l.scratchP, outP = l.outP, pages = l.pages;
            if (pages > MAX_PAGES) { return null; }
            const memory = new WebAssembly.Memory({ initial: pages });
            const instance = new WebAssembly.Instance(mod, { env: { memory: memory } });
            if ((typeof instance.exports.toRgba !== 'function') || (typeof instance.exports.luma !== 'function') || (typeof instance.exports.chromaV2 !== 'function')) { return null; }
            return new Avc444Kernel(instance, memory, { pw: opts.pw, ph: opts.ph, planeBytes: planeBytes, yP: yP, uP: uP, vP: vP, scratchP: scratchP, outP: outP, scratchBytes: scratchBytes, outBytes: outBytes, total: pages * PAGE });
        } catch (ex) { return null; }
    }

    return Object.freeze({
        create: create, bytesFor: bytesFor, available: function () { return compile() !== null; },
        // Where the embedded module comes from: sha256 of its bytes and the compiler line (tools/avc444-simd/build.sh --check rebuilds and compares)
        provenance: Object.freeze({ sha256: WASM_SHA256, toolchain: WASM_TOOLCHAIN, base64: WASM_BASE64 })
    });
});
