/**
* @description RemoteFX Progressive (MS-RDPEGFX 2.2.4.2, RFX_PROGRESSIVE_*) decoder: blocks, regions, TILE_SIMPLE / TILE_FIRST /
* TILE_UPGRADE, progressive quantization, SRL + RAW refinement passes, per-surface tile state
* @license Apache-2.0
*
* Used for GFX WireToSurface2 codecId 0x0009 (CAPROGRESSIVE). One ProgressiveContext per SURFACE (not per encoding context id):
* Windows 10 deletes an encoding context after one to three PDUs and continues with a new id without SYNC / CONTEXT, and its
* TILE_FIRST tiles carry the difference flag that adds to the tile state of the earlier contexts. FreeRDP behaves the same way
* (tile state per surface, DeleteEncodingContext is bookkeeping only). The owner (gfx/client.js) tracks the context ids.
*
* The algorithm, the order of the stages, the saturating difference add, the SRL/RAW bit layout and the DWT with the reduced
* extrapolation follow FreeRDP libfreerdp/codec/progressive.c (Copyright 2014 Marc-Andre Moreau, 2019 Armin Novak / Thincast;
* Apache-2.0), so the output is bit-identical with FreeRDP for conforming streams. RLGR1, the differential LL3, the classic inverse
* DWT 5/3 and the colour conversion are rfx-common.js.
*
* Differences from FreeRDP, all deliberate:
*  - structure is checked strictly (block lengths, counts, tile indices inside the surface, quantization 6..15, quality index);
*    FreeRDP skips a region outside FRAME_BEGIN..FRAME_END, this decoder refuses it;
*  - FreeRDP composes, at the end of a PDU, every tile updated in the current GFX frame against the rectangles of the LAST region;
*    Windows relies on it (it splits one frame's update over several PDUs: a later PDU brings only rectangles, no tiles, and
*    paints the tiles of the earlier PDU of the same frame inside them). Here every region composes its own tiles when they are
*    decoded and then the tiles updated earlier in the same frame (params.frameId) against its own rectangles; identical for
*    one region per PDU;
*  - upgrade passes use the band layout of the region's DWT mode (FreeRDP always uses the reduced-extrapolation layout);
*  - an upgrade of a position that never got a first pass, a negative bit-plane count, and coefficient overflow are CodecError('INVALID');
*  - work per call is bounded: tiles, region union/intersection work, copied area and emitted pieces; retained tile state
*    is reserved through the budget. Region rectangles are unioned before composition.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'), require('./rfx-common.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.progressive = factory(root.RdpShared.limits, root.RdpCodecs.errors, root.RdpCodecs['rfx-common']);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors, common) {
    'use strict';
    const CodecError = errors.CodecError;

    // Block types (MS-RDPEGFX 2.2.4.2.1)
    const WBT = Object.freeze({ SYNC: 0xCCC0, FRAME_BEGIN: 0xCCC1, FRAME_END: 0xCCC2, CONTEXT: 0xCCC3, REGION: 0xCCC4, TILE_SIMPLE: 0xCCC5, TILE_FIRST: 0xCCC6, TILE_UPGRADE: 0xCCC7 });
    const MAGIC = 0xCACCACCA, VERSION = 0x0100, TILE_SIZE = 64;
    const REGION_FLAG_EXTRAPOLATE = 0x01;       // RFX_DWT_REDUCE_EXTRAPOLATE
    const TILE_FLAG_DIFFERENCE = 0x01;          // RFX_TILE_DIFFERENCE
    const COEFFS = common.TILE_COEFFS;          // 4096 per component
    const BANDS = 10;                           // order of every per-band table: HL1 LH1 HH1 HL2 LH2 HH2 HL3 LH3 HH3 LL3
    const NUM_QUANT_MAX = 7, NUM_PROG_MAX = 255;
    const RECTS_MAX = 4096;                     // region rectangles
    const OPS_MAX = 16 * 1024 * 1024;           // tiles x rectangles composed in one call
    const RAW_BITS_MAX = 16;                    // bit planes of one pass; the real streams use a handful
    const BITPOS_MAX = 30;

    // Band layouts (offset, size) of the 4096 coefficients of a component
    const LAYOUT_CLASSIC = Object.freeze({ off: Object.freeze([0, 1024, 2048, 3072, 3328, 3584, 3840, 3904, 3968, 4032]), size: Object.freeze([1024, 1024, 1024, 256, 256, 256, 64, 64, 64, 64]), ll3: 4032 });
    const LAYOUT_EXTRAPOLATE = Object.freeze({ off: Object.freeze([0, 1023, 2046, 3007, 3279, 3551, 3807, 3879, 3951, 4015]), size: Object.freeze([1023, 1023, 961, 272, 272, 256, 72, 72, 64, 81]), ll3: 4015 });

    // Memory retained for one tile position: 3 x 4096 int16 coefficients, 3 x 4096 int8 signs, 30 bit positions
    const TILE_STATE_BYTES = (3 * COEFFS * 2) + (3 * COEFFS) + 32;
    const BASE_BYTES = common.WORKSPACE_BYTES + (2 * RECTS_MAX * 4 * 4) + (NUM_QUANT_MAX * BANDS) + (NUM_PROG_MAX * 3 * BANDS) + 4096;

    function fail(code, what) { throw new CodecError(code, what); }
    const isInt = (n) => Number.isSafeInteger(n);
    const u16 = (b, p) => b[p] | (b[p + 1] << 8);
    const u32 = (b, p) => ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0);

    // ---- inverse DWT with the reduced extrapolation (progressive.c progressive_rfx_idwt_x / _y) -----------------------------
    function clamp16(v) { return (v < -32768) ? -32768 : ((v > 32767) ? 32767 : v); }
    // Horizontal lifting has unit strides; vertical lifting below walks entire rows.
    // Every reconstructed even/odd sample saturates before its dependent lifting step.
    function liftRow(buf, lo, hi, tmp, d, nL, nH) {
        let h = buf[hi], even = clamp16(buf[lo] - h);
        tmp[d] = even;
        for (let x = 1; x < nH; x++) {
            const nextH = buf[hi + x], sum = h + nextH;
            const next = clamp16(buf[lo + x] - ((sum + (sum >>> 31)) >> 1));
            const pair = even + next;
            tmp[d + 2 * x - 1] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * h);
            tmp[d + 2 * x] = next;
            h = nextH; even = next;
        }
        const next = clamp16(buf[lo + nH] - (nL === nH + 1 ? h : ((h + (h >>> 31)) >> 1)));
        const pair = even + next;
        tmp[d + 2 * nH - 1] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * h);
        tmp[d + 2 * nH] = next;
        if (nL === nH + 2) {
            const tail = next + buf[lo + nH + 1];
            tmp[d + 2 * nH + 1] = (tail + (tail >>> 31)) >> 1;
        }
    }

    function idwtBlockExtrapolate(buf, base, level, tmp) {
        const nL = (64 >> level) + 1;
        const nH = (level === 1) ? 31 : ((64 + (1 << (level - 1))) >> level);
        const hl = base, lh = hl + nH * nL, hh = lh + nL * nH, ll = hh + nH * nH;
        const step = nL + nH, hOff = nL * step;
        for (let y = 0; y < nL; y++) { liftRow(buf, ll + y * nL, hl + y * nH, tmp, y * step, nL, nH); }
        for (let y = 0; y < nH; y++) { liftRow(buf, lh + y * nL, hh + y * nH, tmp, hOff + y * step, nL, nH); }
        for (let x = 0; x < step; x++) { buf[base + x] = clamp16(tmp[x] - tmp[hOff + x]); }
        for (let y = 1; y < nH; y++) {
            const l = y * step, h = hOff + l, d = base + 2 * l;
            for (let x = 0; x < step; x++) {
                const sum = tmp[h - step + x] + tmp[h + x];
                const even = clamp16(tmp[l + x] - ((sum + (sum >>> 31)) >> 1));
                const pair = buf[d - 2 * step + x] + even;
                buf[d + x] = even;
                buf[d - step + x] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * tmp[h - step + x]);
            }
        }
        const l = nH * step, h = hOff + (nH - 1) * step, d = base + 2 * l;
        for (let x = 0; x < step; x++) {
            const lastH = tmp[h + x];
            const even = clamp16(tmp[l + x] - (nL === nH + 1 ? lastH : ((lastH + (lastH >>> 31)) >> 1)));
            const pair = buf[d - 2 * step + x] + even;
            buf[d + x] = even;
            buf[d - step + x] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * lastH);
            if (nL === nH + 2) {
                const tail = even + tmp[l + step + x];
                buf[d + step + x] = (tail + (tail >>> 31)) >> 1;
            }
        }
    }

    // The 64x64 level dominates DWT work. Keep its dimensions constant and inline
    // the row lift so V8 can fold strides and the asymmetric tail, without runtime code generation.
    function idwtEx1(buf, tmp) {
        const base = 0, nL = 33, nH = 31, step = 64, hOff = 2112;
        const hl = 0, lh = 1023, hh = 2046, ll = 3007;
        for (let y = 0; y < step; y++) {
            const lo = y < nL ? ll + y * nL : lh + (y - nL) * nL;
            const hi = y < nL ? hl + y * nH : hh + (y - nL) * nH;
            const d = y * step;
            let h = buf[hi], even = clamp16(buf[lo] - h);
            tmp[d] = even;
            for (let x = 1; x < nH; x++) {
                const nextH = buf[hi + x], sum = h + nextH;
                const next = clamp16(buf[lo + x] - ((sum + (sum >>> 31)) >> 1));
                const pair = even + next;
                tmp[d + 2 * x - 1] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * h);
                tmp[d + 2 * x] = next;
                h = nextH; even = next;
            }
            const next = clamp16(buf[lo + nH] - (nL === nH + 1 ? h : ((h + (h >>> 31)) >> 1)));
            const pair = even + next;
            tmp[d + 2 * nH - 1] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * h);
            tmp[d + 2 * nH] = next;
            if (nL === nH + 2) {
                const tail = next + buf[lo + nH + 1];
                tmp[d + 2 * nH + 1] = (tail + (tail >>> 31)) >> 1;
            }
        }
        for (let x = 0; x < step; x++) { buf[base + x] = clamp16(tmp[x] - tmp[hOff + x]); }
        for (let y = 1; y < nH; y++) {
            const l = y * step, h = hOff + l, d = base + 2 * l;
            for (let x = 0; x < step; x++) {
                const sum = tmp[h - step + x] + tmp[h + x];
                const even = clamp16(tmp[l + x] - ((sum + (sum >>> 31)) >> 1));
                const pair = buf[d - 2 * step + x] + even;
                buf[d + x] = even;
                buf[d - step + x] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * tmp[h - step + x]);
            }
        }
        const l = nH * step, h = hOff + (nH - 1) * step, d = base + 2 * l;
        for (let x = 0; x < step; x++) {
            const lastH = tmp[h + x];
            const even = clamp16(tmp[l + x] - (nL === nH + 1 ? lastH : ((lastH + (lastH >>> 31)) >> 1)));
            const pair = buf[d - 2 * step + x] + even;
            buf[d + x] = even;
            buf[d - step + x] = clamp16(((pair + (pair >>> 31)) >> 1) + 2 * lastH);
            if (nL === nH + 2) {
                const tail = even + tmp[l + step + x];
                buf[d + step + x] = (tail + (tail >>> 31)) >> 1;
            }
        }
    }

    function idwt2dExtrapolate(buf, tmp) {
        idwtBlockExtrapolate(buf, 3807, 3, tmp);
        idwtBlockExtrapolate(buf, 3007, 2, tmp);
        idwtEx1(buf, tmp);
    }

    // ---- bit readers for the refinement passes -------------------------------------------------------------------------
    // MSB first. Every requested bit must be present (byte padding may remain unused).
    class Bits {
        constructor() { this.detach(); }
        attach(b, start, length) { this.b = b; this.start = start; this.pos = 0; this.total = length * 8; this.over = false; }
        detach() { this.b = null; this.start = 0; this.pos = 0; this.total = 0; this.over = false; }
        bit() {
            if (this.pos >= this.total) { this.over = true; fail('TRUNCATED', 'refinement bits'); }
            const p = this.pos++;
            return (this.b[this.start + (p >>> 3)] >>> (7 - (p & 7))) & 1;
        }
        // n <= 24. Read only the bytes covered by the requested bits.
        bits(n) {
            if (n === 1) { return this.bit(); }
            if (n > this.total - this.pos) { this.over = true; fail('TRUNCATED', 'refinement bits'); }
            const p = this.pos, at = this.start + (p >>> 3), count = (p & 7) + n;
            let word = this.b[at];
            if (count > 8) { word = (word << 8) | this.b[at + 1]; }
            if (count > 16) { word = (word << 8) | this.b[at + 2]; }
            if (count > 24) { word = (word << 8) | this.b[at + 3]; }
            this.pos = p + n;
            return (word >>> ((8 - count) & 7)) & ((1 << n) - 1);
        }
        // Unary magnitude: up to `limit` zero bits, followed by a one unless the limit is reached.
        zeros(limit) {
            let count = 0;
            while (count < limit) {
                const remaining = this.total - this.pos;
                if (remaining === 0) { this.over = true; fail('TRUNCATED', 'refinement bits'); }
                const p = this.pos, at = this.start + (p >>> 3), shift = p & 7;
                const available = Math.min(8 - shift, remaining);
                const run = Math.min(Math.clz32(this.b[at] << (24 + shift)), available, limit - count);
                this.pos += run; count += run;
                if (count === limit) { break; }
                if (run < available) { this.pos++; break; }
            }
            return count;
        }
    }

    // ---- state ------------------------------------------------------------------------------------------------------
    class Tile {
        constructor() {
            this.cur = new Int16Array(3 * COEFFS);      // coefficients before the inverse DWT, shifted
            this.sign = new Int8Array(3 * COEFFS);      // -1 / 0 / 1 per coefficient, 0 = not known yet (SRL coded in upgrades)
            this.bitPos = new Uint8Array(3 * BANDS);    // quant + progressive quant already transmitted, per component and band
            this.planes = [this.cur.subarray(0, COEFFS), this.cur.subarray(COEFFS, 2 * COEFFS), this.cur.subarray(2 * COEFFS)];
            this.extrapolate = false;                   // DWT mode of the last pass (the pixels are recomputed from `cur`)
        }
    }

    class ProgressiveContext {
        // deps: { budget: { reserve, release } (optional), surfaceWidth, surfaceHeight, consumeWork(pixels) (optional) }
        constructor(deps) {
            if (!deps || !isInt(deps.surfaceWidth) || !isInt(deps.surfaceHeight) || (deps.surfaceWidth < 1) || (deps.surfaceHeight < 1) ||
                (deps.surfaceWidth > limits.SURFACE_MAX_DIM) || (deps.surfaceHeight > limits.SURFACE_MAX_DIM)) { fail('LIMIT', 'surface size'); }
            this.budget = deps.budget || null;
            this.consumeWork = deps.consumeWork || null;
            this.width = deps.surfaceWidth;
            this.height = deps.surfaceHeight;
            this.gridW = Math.ceil(this.width / TILE_SIZE);
            this.gridH = Math.ceil(this.height / TILE_SIZE);
            this.cells = this.gridW * this.gridH;
            this.closed = false;
            this.reserved = 0;
            this.tiles = null;              // Tile or null per grid cell, allocated on the first pass of that position
            this.tileCount = 0;
            this.ws = null;
            this.rects = null;              // region rectangles x0 y0 x1 y1 (Int32)
            this.quant = null;              // numQuant x 10 values, band order
            this.sh = null; this.nb = null; this.comps = null;
            this.prog = null;               // numProg x 30 values (Y, Cb, Cr) in band order
            this.bs = new Bits();
            this.br = new Bits();
            this.subbandDiffing = false;    // CONTEXT flags, kept between PDUs (informational, like FreeRDP)
            this.frameId = -1;              // GFX frame of the tiles in `frameTiles` (-1: none)
            this.frameTiles = [];           // grid cells updated in that frame, in order, each once
            this.listedAt = null;           // Int32Array per cell: frame serial of the last listing
            this.regionAt = null;           // Int32Array per cell: serial of the region that last decoded it
            this.frameSerial = 0;
            this.regionSerial = 0;
            this.stats = { pdus: 0, recomposed: 0, tilesFirst: 0, tilesSimple: 0, tilesUpgrade: 0, differenceTiles: 0, overreads: 0 };
        }

        _reserve(bytes) {
            if (this.budget) { this.budget.reserve(bytes); }
            this.reserved += this.budget ? bytes : 0;
        }

        _ensure() {
            if (this.closed) { fail('INTERNAL', 'Progressive decoder is closed'); }
            if (this.ws !== null) { return; }
            this._reserve(BASE_BYTES + (this.cells * 8));
            this.ws = new common.TileWorkspace();
            this.comps = [this.ws.y, this.ws.cb, this.ws.cr];
            this.sh = new Int32Array(BANDS); this.nb = new Int32Array(BANDS);
            this.tiles = new Array(this.cells).fill(null);
            this.listedAt = new Int32Array(this.cells).fill(-1);
            this.regionAt = new Int32Array(this.cells).fill(-1);
            this.rects = new Int32Array(RECTS_MAX * 4);
            this.quant = new Uint8Array(NUM_QUANT_MAX * BANDS);
            this.prog = new Uint8Array(NUM_PROG_MAX * 3 * BANDS);
        }

        close() {
            this.bs.detach(); this.br.detach();
            if (this.closed) { return; }
            this.closed = true;
            this.consumeWork = null;
            this.frameTiles = []; this.listedAt = null; this.regionAt = null;
            this.tiles = null; this.ws = null; this.rects = null; this.quant = null; this.prog = null;
            this.tileCount = 0; this.sh = null; this.nb = null; this.comps = null;
            if (this.reserved > 0) {
                const n = this.reserved;
                this.reserved = 0;
                try { this.budget.release(n); } catch (ex) { /* budget already reset */ }
            }
        }

        // Decodes one WireToSurface2 payload into dst (the surface, RGBA, alpha written 255). → { rects } written, surface coordinates.
        // params.frameId: the GFX frame (StartFrame) the PDU belongs to; PDUs of one frame share their updated tiles (see above).
        decode(src, dst, params) {
            if (!(src instanceof Uint8Array)) { fail('INVALID', 'source'); }
            if (!dst || !isInt(dst.width) || !isInt(dst.height) || !isInt(dst.stride) || (dst.stride < dst.width * 4)) { fail('LIMIT', 'destination'); }
            if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID', 'destination data'); }
            if ((dst.width !== this.width) || (dst.height !== this.height)) { fail('LIMIT', 'destination size differs from the surface'); }
            if (dst.data.length < dst.stride * dst.height) { fail('LIMIT', 'destination size'); }
            if (src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength && dst.data.byteOffset < src.byteOffset + src.byteLength) {
                fail('INVALID', 'source overlaps destination');
            }
            this._ensure();
            const fid = (params && Number.isSafeInteger(params.frameId)) ? params.frameId : -1;
            if (fid === -1 || fid !== this.frameId) { this.frameId = fid; this.frameTiles.length = 0; this.frameSerial++; }
            const out = { rects: [], tiles: 0 };
            try {
                out.tiles = this._pdu(src, dst, out.rects);
            } catch (ex) {
                if (this.bs.over || this.br.over) { this.stats.overreads++; }
                throw errors.toCodecError(ex);
            } finally {
                // Never pin the received PDU (or its larger backing buffer) between calls.
                this.bs.detach(); this.br.detach();
            }
            this.stats.pdus++;
            return out;
        }

        _pdu(src, dst, rects) {
            const end = src.length;
            let pos = 0;
            const aligned = ((dst.data.byteOffset & 3) === 0) && ((dst.stride & 3) === 0) && common.LITTLE_ENDIAN;
            const st = { begun: false, ended: false, tiles: 0, ops: 0, area: 0, areaMax: 2 * this.width * this.height,
                piecesMax: 8 * this.cells + 4 * RECTS_MAX, upgrade: null,
                dst: dst, rects: rects, dst32: aligned ? new Uint32Array(dst.data.buffer, dst.data.byteOffset, dst.data.byteLength >>> 2) : null };
            if (end === 0) { fail('INVALID', 'empty'); }
            while (pos < end) {
                if (end - pos < 6) { fail('TRUNCATED', 'block header'); }
                const type = u16(src, pos), len = u32(src, pos + 2);
                if (len < 6) { fail('INVALID', 'block length'); }
                if (len > end - pos) { fail('TRUNCATED', 'block'); }
                const body = pos + 6, bodyEnd = pos + len;
                switch (type) {
                    case WBT.SYNC:
                        if (len !== 12) { fail('INVALID', 'sync length'); }
                        if (u32(src, body) !== MAGIC) { fail('INVALID', 'sync magic'); }
                        if (u16(src, body + 4) !== VERSION) { fail('INVALID', 'sync version'); }
                        break;
                    case WBT.CONTEXT:
                        if (len !== 10) { fail('INVALID', 'context length'); }
                        if (u16(src, body + 1) !== TILE_SIZE) { fail('INVALID', 'tile size'); }
                        this.subbandDiffing = (src[body + 3] & 1) !== 0;
                        break;
                    case WBT.FRAME_BEGIN:
                        if (len !== 12) { fail('INVALID', 'frame begin length'); }
                        if (st.begun || st.ended) { fail('INVALID', 'unexpected FRAME_BEGIN'); }
                        st.begun = true;
                        break;
                    case WBT.FRAME_END:
                        if (len !== 6) { fail('INVALID', 'frame end length'); }
                        if (!st.begun || st.ended) { fail('INVALID', 'unexpected FRAME_END'); }
                        st.ended = true;
                        break;
                    case WBT.REGION:
                        if (!st.begun || st.ended) { fail('INVALID', 'REGION outside the frame'); }
                        this._region(src, body, bodyEnd, st);
                        break;
                    default: fail('INVALID', 'block type');
                }
                pos = bodyEnd;
            }
            return st.tiles;
        }

        _region(src, p, end, st) {
            if (end - p < 12) { fail('TRUNCATED', 'region'); }
            if (src[p] !== TILE_SIZE) { fail('INVALID', 'region tile size'); }
            let numRects = u16(src, p + 1);
            const numQuant = src[p + 3], numProg = src[p + 4], flags = src[p + 5];
            const numTiles = u16(src, p + 6), tileData = u32(src, p + 8);
            p += 12;
            if (numRects < 1) { fail('INVALID', 'region without rectangles'); }
            if (numRects > RECTS_MAX) { fail('LIMIT', 'region rectangles'); }
            if (numQuant > NUM_QUANT_MAX) { fail('INVALID', 'quantization tables'); }
            if (end - p < (numRects * 8) + (numQuant * 5) + (numProg * 16)) { fail('TRUNCATED', 'region tables'); }
            if (end - p - ((numRects * 8) + (numQuant * 5) + (numProg * 16)) !== tileData) { fail('INVALID', 'region tile data size'); }
            const rc = this.rects;
            for (let i = 0; i < numRects; i++, p += 8) {
                const x = u16(src, p), y = u16(src, p + 2), w = u16(src, p + 4), h = u16(src, p + 6);
                if (w < 1 || h < 1 || x + w > this.width || y + h > this.height) { fail('INVALID', 'region rectangle'); }
                rc[i * 4] = x; rc[(i * 4) + 1] = y; rc[(i * 4) + 2] = x + w; rc[(i * 4) + 3] = y + h;
            }
            numRects = this._unionRegion(numRects, st);
            if (numTiles > 2 * this.cells - st.tiles) { fail('LIMIT', 'more tiles than the surface holds'); }
            if (numTiles * numRects > OPS_MAX - st.ops) { fail('LIMIT', 'tiles x union rectangles'); }
            for (let i = 0; i < numQuant; i++, p += 5) {
                this._quantRead(src, p, this.quant, i * BANDS);
                for (let b = 0; b < BANDS; b++) { const v = this.quant[(i * BANDS) + b]; if (v < 6 || v > 15) { fail('INVALID', 'quantization value'); } }
            }
            for (let i = 0; i < numProg; i++, p += 16) {
                // quality byte, then the Y, Cb, Cr tables
                this._quantRead(src, p + 1, this.prog, i * 3 * BANDS);
                this._quantRead(src, p + 6, this.prog, (i * 3 * BANDS) + BANDS);
                this._quantRead(src, p + 11, this.prog, (i * 3 * BANDS) + (2 * BANDS));
            }
            const layout = (flags & REGION_FLAG_EXTRAPOLATE) ? LAYOUT_EXTRAPOLATE : LAYOUT_CLASSIC;
            const extrapolate = (flags & REGION_FLAG_EXTRAPOLATE) !== 0;
            // The tiles
            const tilesEnd = p + tileData;
            const listStart = this.frameTiles.length;
            this.regionSerial++;
            let count = 0;
            while (p < tilesEnd) {
                if (tilesEnd - p < 6) { fail('TRUNCATED', 'tile header'); }
                const type = u16(src, p), len = u32(src, p + 2);
                if (len < 6 || len > tilesEnd - p) { fail('INVALID', 'tile length'); }
                if (++count > numTiles) { fail('INVALID', 'more tiles than announced'); }
                this._countTile(st);
                switch (type) {
                    case WBT.TILE_SIMPLE: this._tileFirst(src, p, len, false, numQuant, numProg, extrapolate, layout, numRects, st); break;
                    case WBT.TILE_FIRST: this._tileFirst(src, p, len, true, numQuant, numProg, extrapolate, layout, numRects, st); break;
                    case WBT.TILE_UPGRADE: this._tileUpgrade(src, p, len, numQuant, numProg, extrapolate, layout, numRects, st); break;
                    default: fail('INVALID', 'tile block type');
                }
                p += len;
            }
            if (count !== numTiles) { fail('INVALID', 'tile count differs from the announced one'); }
            if (listStart > 0) { this._recomposeEarlier(listStart, numRects, st); }
        }

        // Same disjoint horizontal-band union as RfxDecoder (rfx.js). Temporary arrays are bounded by RECTS_MAX;
        // pathological unions are refused before any tile is decoded or painted. Charge union work to this PDU too.
        _unionRegion(n, st) {
            if (n < 2) { return n; }
            const rc = this.rects, out = new Int32Array(RECTS_MAX * 4), band = new Int32Array(RECTS_MAX * 4);
            const order = Array.from({ length: n }, (_, i) => i * 4).sort((a, b) => rc[a] - rc[b]);
            const ys = Array.from(new Set(order.flatMap((i) => [rc[i + 1], rc[i + 3]]))).sort((a, b) => a - b);
            let count = 0, prevAt = 0, prevCount = 0;
            for (let y = 0; y + 1 < ys.length; y++) {
                const y0 = ys[y], y1 = ys[y + 1];
                let nb = 0;
                for (const i of order) {
                    if (++st.ops > OPS_MAX) { fail('LIMIT', 'region union work'); }
                    if (rc[i + 1] > y0 || rc[i + 3] < y1) { continue; }
                    if (nb && rc[i] <= band[(nb - 1) * 4 + 2]) {
                        band[(nb - 1) * 4 + 2] = Math.max(band[(nb - 1) * 4 + 2], rc[i + 2]);
                    } else {
                        const b = nb++ * 4;
                        band[b] = rc[i]; band[b + 1] = y0; band[b + 2] = rc[i + 2]; band[b + 3] = y1;
                    }
                }
                let same = nb > 0 && nb === prevCount;
                for (let i = 0; same && i < nb; i++) {
                    const a = (prevAt + i) * 4, b = i * 4;
                    same = out[a] === band[b] && out[a + 2] === band[b + 2] && out[a + 3] === y0;
                }
                if (same) {
                    for (let i = 0; i < nb; i++) { out[(prevAt + i) * 4 + 3] = y1; }
                } else {
                    if (count + nb > RECTS_MAX) { fail('LIMIT', 'union rectangles'); }
                    prevAt = count; prevCount = nb;
                    out.set(band.subarray(0, nb * 4), count * 4);
                    count += nb;
                }
            }
            rc.set(out.subarray(0, count * 4));
            return count;
        }

        // The tiles updated earlier in this frame (frameTiles[0 .. listStart), not decoded by the current region) inside the rectangles of the current region
        _recomposeEarlier(listStart, numRects, st) {
            const rc = this.rects, ws = this.ws, list = this.frameTiles;
            const comps = this.comps;
            for (let k = 0; k < listStart; k++) {
                const z = list[k];
                if (this.regionAt[z] === this.regionSerial) { continue; }
                st.ops += numRects;
                if (st.ops > OPS_MAX) { fail('LIMIT', 'tiles x rectangles'); }
                const xIdx = z % this.gridW, yIdx = (z - xIdx) / this.gridW;
                const tx = xIdx * TILE_SIZE, ty = yIdx * TILE_SIZE;
                let hit = false;
                for (let i = 0; i < numRects; i++) {
                    if (rc[i * 4] < tx + TILE_SIZE && rc[(i * 4) + 2] > tx && rc[(i * 4) + 1] < ty + TILE_SIZE && rc[(i * 4) + 3] > ty) { hit = true; break; }
                }
                if (!hit) { continue; }
                this._countTile(st);
                const t = this.tiles[z];
                for (let c = 0; c < 3; c++) {
                    comps[c].set(t.planes[c]);
                    if (t.extrapolate) { idwt2dExtrapolate(comps[c], ws.tmp); } else { common.idwt2d(comps[c], ws.tmp); }
                }
                common.ycbcrToRgba(ws);
                this.stats.recomposed++;
                this._compose(xIdx, yIdx, numRects, st);
            }
        }

        // 5 bytes -> 10 values in band order (progressive.c progressive_component_codec_quant_read: LL3 HL3 | LH3 HH3 | HL2 LH2 | HH2 HL1 | LH1 HH1)
        _quantRead(b, p, out, o) {
            out[o + 9] = b[p] & 15; out[o + 6] = b[p] >> 4;
            out[o + 7] = b[p + 1] & 15; out[o + 8] = b[p + 1] >> 4;
            out[o + 3] = b[p + 2] & 15; out[o + 4] = b[p + 2] >> 4;
            out[o + 5] = b[p + 3] & 15; out[o + 0] = b[p + 3] >> 4;
            out[o + 1] = b[p + 4] & 15; out[o + 2] = b[p + 4] >> 4;
        }

        _tile(xIdx, yIdx, create) {
            if (xIdx >= this.gridW || yIdx >= this.gridH) { fail('INVALID', 'tile index outside the surface'); }
            const z = (yIdx * this.gridW) + xIdx;
            let t = this.tiles[z];
            if (t === null && create) {
                this._reserve(TILE_STATE_BYTES);
                t = this.tiles[z] = new Tile();
                this.tileCount++;
            }
            return t;
        }

        _countTile(st) {
            if (st.tiles >= 2 * this.cells) { fail('LIMIT', 'more tiles than the surface holds'); }
            // A disjoint region writes at most COEFFS pixels per tile. Charge the client's frame budget before
            // decoding/recomposing, so multiple small PDUs cannot defer their work checks until after painting.
            if (this.consumeWork) { this.consumeWork(COEFFS); }
            st.tiles++;
        }

        // TILE_SIMPLE (flag first = false, no quality byte) and TILE_FIRST
        _tileFirst(src, p, len, first, numQuant, numProg, extrapolate, layout, numRects, st) {
            const hdr = first ? 17 : 16;
            if (len < 6 + hdr) { fail('INVALID', 'tile length'); }
            const q = p + 6;
            const qY = src[q], qCb = src[q + 1], qCr = src[q + 2];
            const xIdx = u16(src, q + 3), yIdx = u16(src, q + 5), flags = src[q + 7];
            const quality = first ? src[q + 8] : 0xFF;
            const l = q + (first ? 9 : 8);
            const yLen = u16(src, l), cbLen = u16(src, l + 2), crLen = u16(src, l + 4), tailLen = u16(src, l + 6);
            if (6 + hdr + yLen + cbLen + crLen + tailLen !== len) { fail('INVALID', 'tile component lengths'); }
            if (qY >= numQuant || qCb >= numQuant || qCr >= numQuant) { fail('INVALID', 'quantization index'); }
            if (quality !== 0xFF && quality >= numProg) { fail('INVALID', 'quality index'); }
            const t = this._tile(xIdx, yIdx, true);
            const ws = this.ws, quant = this.quant, prog = this.prog;
            const diff = (flags & TILE_FLAG_DIFFERENCE) !== 0;
            if (first) { this.stats.tilesFirst++; } else { this.stats.tilesSimple++; }
            if (diff) { this.stats.differenceTiles++; }
            const comps = this.comps, qi = [qY, qCb, qCr];
            let at = l + 8;
            const lens = [yLen, cbLen, crLen];
            for (let c = 0; c < 3; c++) {
                const buf = comps[c];
                const sh = this.sh;
                for (let b = 0; b < BANDS; b++) {
                    const pq = (quality === 0xFF) ? 0 : prog[(quality * 3 * BANDS) + (c * BANDS) + b];
                    const bp = quant[(qi[c] * BANDS) + b] + pq;
                    t.bitPos[(c * BANDS) + b] = bp;
                    sh[b] = bp - 1;
                }
                ws.load(src, at, lens[c]);
                at += lens[c];
                common.rlgrDecode(ws, buf, false);
                const sg = t.sign, so = c * COEFFS, cur = t.planes[c];
                // LL3 signs describe the coded differences, before differential reconstruction.
                for (let i = layout.ll3; i < COEFFS; i++) { const v = buf[i]; sg[so + i] = (v > 0) - (v < 0); }
                this._differential(buf, layout.ll3);
                for (let b = 0; b < BANDS; b++) {
                    const s = sh[b], o = layout.off[b], e = o + layout.size[b];
                    if (diff) {
                        for (let i = o; i < e; i++) {
                            const v = buf[i];
                            if (b !== BANDS - 1) { sg[so + i] = (v > 0) - (v < 0); }
                            const sum = clamp16(((v << s) << 16 >> 16) + cur[i]);
                            buf[i] = sum; cur[i] = sum;
                        }
                    } else {
                        for (let i = o; i < e; i++) {
                            const v = buf[i];
                            if (b !== BANDS - 1) { sg[so + i] = (v > 0) - (v < 0); }
                            buf[i] = v << s; cur[i] = v << s;
                        }
                    }
                }
                if (extrapolate) { idwt2dExtrapolate(buf, ws.tmp); } else { common.idwt2d(buf, ws.tmp); }
            }
            common.ycbcrToRgba(ws);
            t.extrapolate = extrapolate;
            this._mark(xIdx, yIdx);
            this._compose(xIdx, yIdx, numRects, st);
        }

        // The tile joins the list of the frame (once) and counts as decoded by the current region
        _mark(xIdx, yIdx) {
            const z = (yIdx * this.gridW) + xIdx;
            this.regionAt[z] = this.regionSerial;
            if (this.listedAt[z] !== this.frameSerial) { this.listedAt[z] = this.frameSerial; this.frameTiles.push(z); }
        }

        // Running sum of LL3, which is stored as differences; the sum stays inside int16 (rfx_differential_decode)
        _differential(buf, start) {
            let prev = buf[start];
            for (let i = start + 1; i < COEFFS; i++) {
                const sum = prev + buf[i];
                if (sum > 32767 || sum < -32768) { fail('INVALID', 'differential LL3'); }
                buf[i] = sum;
                prev = sum;
            }
        }

        _tileUpgrade(src, p, len, numQuant, numProg, extrapolate, layout, numRects, st) {
            if (len < 6 + 20) { fail('INVALID', 'tile length'); }
            const q = p + 6;
            const qY = src[q], qCb = src[q + 1], qCr = src[q + 2];
            const xIdx = u16(src, q + 3), yIdx = u16(src, q + 5), quality = src[q + 7];
            const l = q + 8;
            const srlLen = [u16(src, l), u16(src, l + 4), u16(src, l + 8)];
            const rawLen = [u16(src, l + 2), u16(src, l + 6), u16(src, l + 10)];
            if (6 + 20 + srlLen[0] + rawLen[0] + srlLen[1] + rawLen[1] + srlLen[2] + rawLen[2] !== len) { fail('INVALID', 'tile component lengths'); }
            if (qY >= numQuant || qCb >= numQuant || qCr >= numQuant) { fail('INVALID', 'quantization index'); }
            if (quality !== 0xFF && quality >= numProg) { fail('INVALID', 'quality index'); }
            const t = this._tile(xIdx, yIdx, false);
            if (t === null) { fail('INVALID', 'upgrade of a tile that has no first pass'); }
            this.stats.tilesUpgrade++;
            // One temporary tile per PDU: a truncated later component must not commit earlier components either.
            // It is not retained by the context and therefore needs no persistent budget reservation.
            const next = st.upgrade || (st.upgrade = new Tile());
            next.cur.set(t.cur); next.sign.set(t.sign); next.bitPos.set(t.bitPos);
            const ws = this.ws, quant = this.quant, prog = this.prog;
            const comps = this.comps, qi = [qY, qCb, qCr];
            let at = l + 12;
            for (let c = 0; c < 3; c++) {
                const sh = this.sh, nb = this.nb;
                for (let b = 0; b < BANDS; b++) {
                    const pq = (quality === 0xFF) ? 0 : prog[(quality * 3 * BANDS) + (c * BANDS) + b];
                    const bp = quant[(qi[c] * BANDS) + b] + pq;
                    const old = t.bitPos[(c * BANDS) + b];
                    if (old < bp) { fail('INVALID', 'upgrade goes to fewer bit planes'); }
                    if (old - bp > RAW_BITS_MAX) { fail('LIMIT', 'bit planes of one pass'); }
                    nb[b] = old - bp;
                    sh[b] = bp - 1;
                    next.bitPos[(c * BANDS) + b] = bp;
                }
                this.bs.attach(src, at, srlLen[c]);
                at += srlLen[c];
                this.br.attach(src, at, rawLen[c]);
                at += rawLen[c];
                this._upgradeComponent(next, c, layout, sh, nb);
                const buf = comps[c];
                buf.set(next.planes[c]);
                if (extrapolate) { idwt2dExtrapolate(buf, ws.tmp); } else { common.idwt2d(buf, ws.tmp); }
            }
            common.ycbcrToRgba(ws);
            t.cur.set(next.cur); t.sign.set(next.sign); t.bitPos.set(next.bitPos);
            t.extrapolate = extrapolate;
            this._mark(xIdx, yIdx);
            this._compose(xIdx, yIdx, numRects, st);
        }

        _upgradeComponent(t, c, layout, sh, nb) {
            const cur = t.cur, sg = t.sign, co = c * COEFFS;
            const raw = this.br, srl = this.bs;
            let kp = 8, nz = 0, mode = 0;
            for (let b = 0; b < BANDS; b++) {
                const n = nb[b];
                if (n < 1) { continue; }
                const o = co + layout.off[b], e = o + layout.size[b], shift = sh[b];
                if (b === BANDS - 1) {
                    for (let i = o; i < e; i++) {
                        const v = cur[i] + (raw.bits(n) << shift);
                        if (v > 32767 || v < -32768) { fail('INVALID', 'coefficient overflow'); }
                        cur[i] = v;
                    }
                    continue;
                }
                for (let i = o; i < e; i++) {
                    let input;
                    const sv = sg[i];
                    if (sv !== 0) { input = sv * raw.bits(n); }
                    else {
                        // SRL state stays in registers across coefficients and bands.
                        if (nz > 0) { nz--; continue; }
                        const k = kp >> 3;
                        if (mode === 0) {
                            if (srl.bit() === 0) {
                                nz = (1 << k) - 1;
                                kp = Math.min(80, kp + 4);
                                continue;
                            }
                            mode = 1;
                            nz = k > 0 ? srl.bits(k) : 0;
                            if (nz > 0) { nz--; continue; }
                        }
                        mode = 0;
                        const sign = srl.bit();
                        kp = Math.max(0, kp - 6);
                        let mag = 1;
                        if (n > 1) {
                            const max = (1 << n) - 1;
                            if (n >= 4) { mag += srl.zeros(max - 1); }
                            else { while (mag < max && srl.bit() === 0) { mag++; } }
                            if (mag > 32767) { mag = 32767; }
                        }
                        input = sign ? -mag : mag;
                        sg[i] = sign ? -1 : 1;
                    }
                    if (input === 0) { continue; }
                    const v = cur[i] + (input << shift);
                    if (v > 32767 || v < -32768) { fail('INVALID', 'coefficient overflow'); }
                    cur[i] = v;
                }
            }
        }

        // Writes the decoded tile (ws pixels) into the surface inside the region rectangles
        _compose(xIdx, yIdx, numRects, st) {
            const rc = this.rects, dst = st.dst, rects = st.rects;
            const tx = xIdx * TILE_SIZE, ty = yIdx * TILE_SIZE;
            const tx1 = Math.min(tx + TILE_SIZE, this.width), ty1 = Math.min(ty + TILE_SIZE, this.height);
            st.ops += numRects;
            if (st.ops > OPS_MAX) { fail('LIMIT', 'tiles x rectangles'); }
            const data = dst.data, stride = dst.stride, ws = this.ws, dst32 = st.dst32;
            for (let i = 0; i < numRects; i++) {
                const x0 = Math.max(rc[i * 4], tx), y0 = Math.max(rc[(i * 4) + 1], ty), x1 = Math.min(rc[(i * 4) + 2], tx1), y1 = Math.min(rc[(i * 4) + 3], ty1);
                if (x1 <= x0 || y1 <= y0) { continue; }
                const pw = x1 - x0, ph = y1 - y0;
                // Both normal decoding and frame-split recomposition pass here. Refuse BEFORE copying or appending,
                // counting every write even when later tiles/regions overwrite it.
                const area = pw * ph;
                if (area > st.areaMax - st.area || rects.length >= st.piecesMax) { fail('LIMIT', 'message pieces or copied area'); }
                st.area += area;
                if (dst32 !== null) {
                    const p32 = ws.pixels32, sw = stride >>> 2;
                    for (let j = 0; j < ph; j++) {
                        const d = ((y0 + j) * sw) + x0, s = ((y0 - ty + j) << 6) + (x0 - tx);
                        for (let k = 0; k < pw; k++) { dst32[d + k] = p32[s + k]; }
                    }
                } else {
                    const p8 = ws.pixels8;
                    for (let j = 0; j < ph; j++) {
                        const d = ((y0 + j) * stride) + (x0 * 4), s = (((y0 - ty + j) << 6) + (x0 - tx)) * 4;
                        for (let k = 0; k < pw * 4; k++) { data[d + k] = p8[s + k]; }
                    }
                }
                rects.push({ x: x0, y: y0, width: pw, height: ph });
            }
        }
    }

    return Object.freeze({
        ProgressiveContext: ProgressiveContext, WBT: WBT, TILE_STATE_BYTES: TILE_STATE_BYTES, BASE_BYTES: BASE_BYTES, RECTS_MAX: RECTS_MAX,
        idwt2dExtrapolate: idwt2dExtrapolate, LAYOUT_CLASSIC: LAYOUT_CLASSIC, LAYOUT_EXTRAPOLATE: LAYOUT_EXTRAPOLATE
    });
});
