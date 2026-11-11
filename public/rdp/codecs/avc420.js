/**
* @description RDPGFX AVC420 (H.264 Annex B) through WebCodecs VideoDecoder: metablock, SPS, ordered asynchronous decode, probe
* @license Apache-2.0
*
* MS-RDPEGFX 2.2.4.4 (RDPGFX_AVC420_BITMAP_STREAM, RDPGFX_AVC420_METABLOCK) and ITU-T H.264 7.3.2.1.1 (SPS).
* The decoder is the only asynchronous codec (public/rdp/codecs/README.md "AVC420"). No DOM: VideoDecoder and
* EncodedVideoChunk come from `deps` (defaults: the globals of a worker or window), so Node tests use fakes.
*
* Ownership rule: a resolved `frame` is owned by the caller, who draws and closes it exactly once. The decoder wraps
* frame.close() to return the frame's byte budget and the pending-frame slot; frames that arrive after reset()/close()
* or for an unknown submission are closed by the decoder itself.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.avc420 = factory(root.RdpShared.limits, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, codecErrors) {
    'use strict';
    const CodecError = codecErrors.CodecError;

    const REGION_BYTES = 8 + 2;            // RDPGFX_RECT16 + RDPGFX_AVC420_QUANT_QUALITY
    const MAX_REGIONS = 8192;              // region rectangles of one picture (client-side limit; real servers send tens)
    const MAX_NALS = 256;                  // NAL units in one chunk (SPS, PPS, SEI and the slices of one picture)
    const PROBE_TIMEOUT_MS = 3000;         // no output by then: the decoder does not work
    const PROBE_MAX_MS = 2000;             // decoding the 3 probe pictures (cold start included) takes longer: too slow
    const DECODE_TIMEOUT_MS = 4000;        // a submitted picture produces no output by then: the decoder holds it back or dropped it
    const MAX_SPS = 8, MAX_PPS = 16;       // parameter sets of one chunk, each validated
    const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

    // A 64x64 picture of three chunks encoded by Chrome's own H.264 encoder (baseline 1.1, Annex B): left half red,
    // right half blue, a white square that moves 4 px per picture. IDR + two P pictures, so inter prediction is exercised.
    function hex(s) { const b = new Uint8Array(s.length / 2); for (let i = 0; i < b.length; i++) { b[i] = parseInt(s.substr(i * 2, 2), 16); } return b; }
    const PROBE_CHUNKS = [
        { type: 'key', data: '000000016742c00b8c684249b80868083c2211a80000000168ce3c800000000165b8000409ffff8860a628000805f8a00020f5e100115a0908000402c00c0a0097ffc3c230800446342000100a00382cd70fffc1145001f1c00042f23800085fc98afffe01c230800446342000100a00382cd7fc03f9138ad75d74f5d75d3d78' },
        { type: 'delta', data: '0000000161e0007e409f821ff80a0e27fc64' },
        { type: 'delta', data: '0000000161e000be40ff821fecf26be2e0' }
    ];

    class BitReader {
        constructor(bytes) { this.b = bytes; this.pos = 0; }
        bit() {
            if ((this.pos >> 3) >= this.b.length) { throw new CodecError('TRUNCATED', 'SPS'); }
            const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
            this.pos++;
            return v;
        }
        bits(n) { let v = 0; for (let i = 0; i < n; i++) { v = (v * 2) + this.bit(); } return v; }
        ue() {
            let zeros = 0;
            while (this.bit() === 0) { if (++zeros > 32) { throw new CodecError('INVALID', 'SPS exp-Golomb'); } }
            return (Math.pow(2, zeros) - 1) + this.bits(zeros);
        }
        se() { const k = this.ue(); return (k & 1) ? ((k + 1) / 2) : -(k / 2); }
    }

    // NAL units of an Annex B stream → [{ type, start, end }] (start/end exclude the start code and trailing zero bytes)
    function scanNals(data) {
        const nals = [];
        const n = data.length;
        let i = 0, cur = -1;
        const close = function (end) {
            if (cur < 0) { return; }
            while ((end > cur) && (data[end - 1] === 0)) { end--; }
            if (end <= cur) { throw new CodecError('INVALID', 'empty NAL unit'); }
            if (nals.length >= MAX_NALS) { throw new CodecError('LIMIT', 'NAL units'); }
            if ((data[cur] & 0x80) !== 0) { throw new CodecError('INVALID', 'NAL forbidden bit'); }
            nals.push({ type: data[cur] & 0x1F, start: cur, end: end });
        };
        while (i + 2 < n) {
            if ((data[i] === 0) && (data[i + 1] === 0) && (data[i + 2] === 1)) {
                close(i);
                cur = i + 3;
                i += 3;
            } else { i++; }
        }
        if (cur < 0) { throw new CodecError('INVALID', 'no Annex B start code'); }
        close(n);
        return nals;
    }

    // RBSP of a NAL unit: drops the header byte and the emulation prevention bytes (00 00 03)
    function rbspOf(data, start, end) {
        const rbsp = new Uint8Array(end - start);
        let len = 0, zeros = 0;
        for (let i = start + 1; i < end; i++) {
            const v = data[i];
            if ((zeros >= 2) && (v === 3)) { zeros = 0; continue; }
            rbsp[len++] = v;
            zeros = (v === 0) ? (zeros + 1) : 0;
        }
        return rbsp.subarray(0, len);
    }

    // PPS NAL (including the header byte) → { ppsId, spsId }. Slice groups (FMO) are not supported.
    function parsePps(data, start, end) {
        const r = new BitReader(rbspOf(data, start, end));
        const ppsId = r.ue(), spsId = r.ue();
        if ((ppsId > 255) || (spsId > 31)) { throw new CodecError('INVALID', 'PPS ids'); }
        r.bit(); r.bit(); // entropy_coding_mode_flag, bottom_field_pic_order_in_frame_present_flag
        if (r.ue() !== 0) { throw new CodecError('UNSUPPORTED', 'slice groups (FMO)'); }
        return { ppsId: ppsId, spsId: spsId };
    }

    // SPS NAL (including the NAL header byte) → { id, profile, constraints, level, codedWidth, codedHeight, visible… }
    function parseSps(data, start, end) {
        const r = new BitReader(rbspOf(data, start, end));
        const profile = r.bits(8), constraints = r.bits(8), level = r.bits(8);
        const id = r.ue(); // seq_parameter_set_id
        if (id > 31) { throw new CodecError('INVALID', 'seq_parameter_set_id'); }
        let chroma = 1;
        if (HIGH_PROFILES.indexOf(profile) >= 0) {
            chroma = r.ue();
            if (chroma > 3) { throw new CodecError('INVALID', 'chroma_format_idc'); }
            if (chroma === 3) { r.bit(); }
            const bdl = r.ue(), bdc = r.ue();
            if ((bdl !== 0) || (bdc !== 0)) { throw new CodecError('UNSUPPORTED', 'bit depth above 8'); }
            r.bit(); // qpprime_y_zero_transform_bypass_flag
            if (r.bit()) {
                const lists = (chroma !== 3) ? 8 : 12;
                for (let i = 0; i < lists; i++) {
                    if (!r.bit()) { continue; }
                    let last = 8, next = 8;
                    const size = (i < 6) ? 16 : 64;
                    for (let j = 0; j < size; j++) {
                        if (next !== 0) { next = (last + r.se() + 256) % 256; }
                        if (next !== 0) { last = next; }
                    }
                }
            }
        }
        if (chroma !== 1) { throw new CodecError('UNSUPPORTED', 'chroma format is not 4:2:0'); }
        r.ue(); // log2_max_frame_num_minus4
        const pocType = r.ue();
        if (pocType > 2) { throw new CodecError('INVALID', 'pic_order_cnt_type'); }
        if (pocType === 0) { r.ue(); }
        else if (pocType === 1) {
            r.bit(); r.se(); r.se();
            const cycle = r.ue();
            if (cycle > 255) { throw new CodecError('INVALID', 'num_ref_frames_in_pic_order_cnt_cycle'); }
            for (let i = 0; i < cycle; i++) { r.se(); }
        }
        r.ue(); r.bit(); // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
        const mbsW = r.ue() + 1, mapUnitsH = r.ue() + 1;
        const frameMbsOnly = r.bit();
        if (!frameMbsOnly) { r.bit(); }
        r.bit(); // direct_8x8_inference_flag
        const mbsH = mapUnitsH * (frameMbsOnly ? 1 : 2);
        const codedWidth = mbsW * 16, codedHeight = mbsH * 16;
        if ((codedWidth > limits.SURFACE_MAX_DIM) || (codedHeight > limits.SURFACE_MAX_DIM)) { throw new CodecError('LIMIT', 'coded size'); }
        let cl = 0, cr = 0, ct = 0, cb = 0;
        if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
        const unitX = 2, unitY = 2 * (frameMbsOnly ? 1 : 2);
        const visibleWidth = codedWidth - ((cl + cr) * unitX), visibleHeight = codedHeight - ((ct + cb) * unitY);
        if ((visibleWidth < 1) || (visibleHeight < 1)) { throw new CodecError('INVALID', 'frame cropping'); }
        const h2 = function (v) { return (v < 16 ? '0' : '') + v.toString(16); };
        return {
            id: id, profile: profile, constraints: constraints, level: level,
            codec: 'avc1.' + h2(profile) + h2(constraints) + h2(level),
            codedWidth: codedWidth, codedHeight: codedHeight,
            visibleX: cl * unitX, visibleY: ct * unitY, visibleWidth: visibleWidth, visibleHeight: visibleHeight
        };
    }

    function isRect(r) {
        return (r != null) && Number.isSafeInteger(r.x) && Number.isSafeInteger(r.y) && Number.isSafeInteger(r.width) && Number.isSafeInteger(r.height) &&
            (r.x >= 0) && (r.y >= 0) && (r.width >= 1) && (r.height >= 1);
    }

    // RDPGFX_AVC420_BITMAP_STREAM: u32 numRegionRects, RECT16[n] (left, top, right, bottom; surface coordinates, right/bottom
    // exclusive), { u8 qp:6 r:1 p:1, u8 qualityVal }[n], then the Annex B bitstream.
    // ctx: { surfaceWidth, surfaceHeight, destRect }. → { regions, quality, streamOffset }
    function parseMetablock(src, ctx) {
        if (!(src instanceof Uint8Array)) { throw new CodecError('INVALID', 'source is not binary'); }
        if (!ctx || !isRect(ctx.destRect) || !Number.isSafeInteger(ctx.surfaceWidth) || !Number.isSafeInteger(ctx.surfaceHeight) ||
            (ctx.surfaceWidth < 1) || (ctx.surfaceHeight < 1)) { throw new CodecError('INVALID', 'context'); }
        const d = ctx.destRect;
        if ((d.x + d.width > ctx.surfaceWidth) || (d.y + d.height > ctx.surfaceHeight)) { throw new CodecError('LIMIT', 'destRect outside the surface'); }
        if (src.length < 4) { throw new CodecError('TRUNCATED', 'metablock'); }
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const count = dv.getUint32(0, true);
        if (count > Math.floor((src.length - 4) / REGION_BYTES)) { throw new CodecError('TRUNCATED', 'metablock regions'); }
        if (count > MAX_REGIONS) { throw new CodecError('LIMIT', 'metablock regions'); }
        const regions = new Array(count), quality = new Array(count);
        let pos = 4;
        for (let i = 0; i < count; i++, pos += 8) {
            const left = dv.getUint16(pos, true), top = dv.getUint16(pos + 2, true), right = dv.getUint16(pos + 4, true), bottom = dv.getUint16(pos + 6, true);
            if ((right <= left) || (bottom <= top)) { throw new CodecError('INVALID', 'empty region'); }
            if ((left < d.x) || (top < d.y) || (right > d.x + d.width) || (bottom > d.y + d.height)) { throw new CodecError('INVALID', 'region outside destRect'); }
            regions[i] = { x: left, y: top, width: right - left, height: bottom - top };
        }
        for (let i = 0; i < count; i++, pos += 2) {
            const b = src[pos];
            quality[i] = { qp: b & 0x3F, qualityVal: src[pos + 1], progressive: ((b & 0x80) !== 0) };
        }
        if (src.length - pos < 5) { throw new CodecError('TRUNCATED', 'bitstream'); }
        return { regions: regions, quality: quality, streamOffset: pos };
    }

    function roundUp16(v) { return (v + 15) & ~15; }

    // Reads a rectangle of a decoded frame as RGBA. rect: frame coordinates relative to the visible area.
    // VideoFrame.copyTo converts to RGBA; where it cannot, a canvas does. `out` (optional, ≥ width * height * 4 bytes)
    // is filled and returned instead of a fresh array, so the caller can bound the memory of its reads; the returned
    // array is tight (width * height * 4) in every case.
    async function readRgba(frame, rect, deps, out) {
        deps = deps || {};
        const vx = (frame.visibleRect && frame.visibleRect.x) || 0, vy = (frame.visibleRect && frame.visibleRect.y) || 0;
        const need = rect.width * rect.height * 4;
        if ((out != null) && (out.length < need)) { throw new CodecError('INTERNAL', 'read buffer'); }
        const dst = (out != null) ? out.subarray(0, need) : new Uint8ClampedArray(need);
        try {
            await frame.copyTo(dst, { rect: { x: vx + rect.x, y: vy + rect.y, width: rect.width, height: rect.height }, format: 'RGBA', layout: [{ offset: 0, stride: rect.width * 4 }] });
            return dst;
        } catch (ex) {
            const Canvas = deps.OffscreenCanvas || ((typeof OffscreenCanvas !== 'undefined') ? OffscreenCanvas : null);
            if (Canvas === null) { throw new CodecError('UNSUPPORTED', 'no way to read a VideoFrame as RGBA'); }
            const c = new Canvas(rect.width, rect.height);
            const g = c.getContext('2d');
            g.drawImage(frame, vx + rect.x, vy + rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
            return g.getImageData(0, 0, rect.width, rect.height).data;
        }
    }

    function mapDecoderError(e) {
        const name = (e && e.name) || '';
        if (name === 'NotSupportedError') { return new CodecError('UNSUPPORTED', 'H.264 decoder'); }
        if ((name === 'EncodingError') || (name === 'DataError')) { return new CodecError('INVALID', 'H.264 stream'); }
        // The browser reclaims the codec of a page in the background (Chrome: QuotaExceededError)
        if (name === 'QuotaExceededError') { return new CodecError('UNSUPPORTED', 'H.264 decoder was reclaimed by the browser'); }
        return new CodecError('INTERNAL', 'H.264 decoder');
    }

    class Avc420Decoder {
        // deps (tests): { VideoDecoder, EncodedVideoChunk, OffscreenCanvas, setTimeout, clearTimeout, decodeTimeoutMs }
        constructor(opts) {
            opts = opts || {};
            this.budget = opts.budget || null;
            this.VD = opts.VideoDecoder || ((typeof VideoDecoder !== 'undefined') ? VideoDecoder : null);
            this.Chunk = opts.EncodedVideoChunk || ((typeof EncodedVideoChunk !== 'undefined') ? EncodedVideoChunk : null);
            // Wrappers: a timer function called as a method of this object would be an illegal invocation in a browser
            const setT = opts.setTimeout || ((typeof setTimeout !== 'undefined') ? setTimeout : null);
            const clrT = opts.clearTimeout || ((typeof clearTimeout !== 'undefined') ? clearTimeout : null);
            this.setT = (setT !== null) ? function (fn, ms) { return setT(fn, ms); } : null;
            this.clrT = (clrT !== null) ? function (h) { clrT(h); } : null;
            this.decodeTimeoutMs = (opts.decodeTimeoutMs != null) ? opts.decodeTimeoutMs : DECODE_TIMEOUT_MS;
            this.hardwareAcceleration = (typeof opts.hardwareAcceleration === 'string') ? opts.hardwareAcceleration : null;   // VideoDecoderConfig.hardwareAcceleration
            this.vd = null;
            this.config = null;         // { codec, codedWidth, codedHeight, visible… } of the configured decoder
            this.pending = new Map();   // timestamp → { ctx, meta, resolve, reject, bytes, released, expect, timer }
            this.outstanding = 0;       // submissions unresolved or resolved with a frame not yet closed
            this.nextTs = 1;
            this.closed = false;
            this.failure = null;        // CodecError after a decoder error: the session is going down
            this.reclaimed = false;     // the browser took the decoder away while nothing was pending: an IDR picture restarts it
        }

        _release(entry) {
            this._disarm(entry);
            if (entry.released) { return; }
            entry.released = true;
            this.outstanding--;
            if (this.budget && entry.charged) { this.budget.release(entry.bytes); }
        }

        _disarm(entry) {
            if (entry.timer != null) { this.clrT(entry.timer); entry.timer = null; }
        }

        _newDecoder() {
            if (this.VD === null) { throw new CodecError('UNSUPPORTED', 'no VideoDecoder'); }
            const self = this;
            const vd = new this.VD({
                output: function (frame) { self._onOutput(vd, frame); },
                error: function (e) { self._onError(vd, e); }
            });
            this.vd = vd;
        }

        // Frames of an old decoder (after reset/close) or without a submission are closed here
        _onOutput(vd, frame) {
            const entry = (vd === this.vd) ? this.pending.get(frame.timestamp) : undefined;
            if (entry === undefined) { try { frame.close(); } catch (ex) { /* already closed */ } return; }
            this.pending.delete(frame.timestamp);
            this._disarm(entry);
            const self = this;
            const native = frame.close.bind(frame);
            let closed = false;
            frame.close = function () { if (!closed) { closed = true; native(); self._release(entry); } };
            const d = entry.ctx.destRect, e = entry.expect;
            const vw = frame.visibleRect ? frame.visibleRect.width : frame.codedWidth;
            const vh = frame.visibleRect ? frame.visibleRect.height : frame.codedHeight;
            if ((vw < d.width) || (vh < d.height)) {
                frame.close();
                entry.reject(new CodecError('INVALID', 'decoded picture smaller than destRect'));
                return;
            }
            // Never larger than the validated parameter sets (the memory was reserved for them)
            if ((vw > e.codedWidth) || (vh > e.codedHeight)) {
                frame.close();
                entry.reject(new CodecError('INVALID', 'decoded picture larger than the validated H.264 configuration'));
                return;
            }
            entry.resolve({ frame: frame, regions: entry.meta.regions, quality: entry.meta.quality });
        }

        // The decoder is gone (error callback or deadline): every pending submission rejects
        _fail(vd, err, nothingPendingIsFine) {
            if (vd !== this.vd) { return; }
            const entries = Array.from(this.pending.values());
            this.pending.clear();
            this.vd = null;
            if (nothingPendingIsFine && (entries.length === 0)) {
                // Reclaimed while idle: nothing was lost; the next IDR picture creates a new decoder
                this.config = null;
                this.reclaimed = true;
            } else { this.failure = err; }
            try { if (vd.state !== 'closed') { vd.close(); } } catch (ex) { /* closing a failed decoder */ }
            for (const entry of entries) { this._release(entry); entry.reject(err); }
        }

        _onError(vd, e) {
            this._fail(vd, mapDecoderError(e), (e != null) && (e.name === 'QuotaExceededError'));
        }

        // No output for a submitted picture within the deadline
        _onTimeout(vd) {
            this._fail(vd, new CodecError('UNSUPPORTED', 'H.264 decoder produced no output'), false);
        }

        // → Promise<null | { frame, regions, quality }>. Validation errors throw synchronously (CodecError).
        submit(src, ctx) {
            if (this.closed) { throw new CodecError('INTERNAL', 'decoder closed'); }
            if (this.failure !== null) { throw this.failure; }
            if (this.outstanding >= limits.AVC_MAX_PENDING_FRAMES) { throw new CodecError('LIMIT', 'pending AVC frames'); }
            if (this.Chunk === null) { throw new CodecError('UNSUPPORTED', 'no EncodedVideoChunk'); }
            const meta = parseMetablock(src, ctx);
            const stream = src.subarray(meta.streamOffset);
            const nals = scanNals(stream);
            const spss = [], ppss = [];
            let idr = false, slices = 0, nonIdrSlices = 0;
            for (const nal of nals) {
                switch (nal.type) {
                    case 7:
                        if (spss.length >= MAX_SPS) { throw new CodecError('LIMIT', 'SPS count'); }
                        spss.push(parseSps(stream, nal.start, nal.end));
                        break;
                    case 8:
                        if (ppss.length >= MAX_PPS) { throw new CodecError('LIMIT', 'PPS count'); }
                        ppss.push(parsePps(stream, nal.start, nal.end));
                        break;
                    case 5: idr = true; slices++; break;
                    case 1: nonIdrSlices++; slices++; break;
                    case 2: case 3: case 4: throw new CodecError('UNSUPPORTED', 'H.264 data partitioning');
                    case 14: case 15: case 20: throw new CodecError('UNSUPPORTED', 'H.264 SVC or MVC NAL unit');
                    default: break;
                }
            }
            // A picture without a slice produces no output, which would stall the ordered painting
            if (slices === 0) { throw new CodecError('INVALID', 'no slice NAL unit in the AVC420 stream'); }
            if (idr && (nonIdrSlices > 0)) { throw new CodecError('INVALID', 'IDR and non-IDR slices in one picture'); }
            // Every parameter set is validated; they must agree, so the one that is validated is the one the decoder uses
            let spsInfo = null;
            if (spss.length > 0) {
                spsInfo = spss[0];
                for (const o of spss) {
                    if ((o.id !== spsInfo.id) || (o.codec !== spsInfo.codec) || (o.codedWidth !== spsInfo.codedWidth) || (o.codedHeight !== spsInfo.codedHeight) ||
                        (o.visibleWidth !== spsInfo.visibleWidth) || (o.visibleHeight !== spsInfo.visibleHeight)) {
                        throw new CodecError('UNSUPPORTED', 'several different SPS in one AVC420 stream');
                    }
                }
            }
            const d = ctx.destRect;
            let next = this.config;
            if (spsInfo !== null) { next = spsInfo; }
            if (next === null) {
                if (this.reclaimed) { throw new CodecError('UNSUPPORTED', 'H.264 decoder was reclaimed; an IDR picture must restart it'); }
                throw new CodecError('INVALID', 'stream does not start with an SPS');
            }
            for (const o of ppss) {
                if (o.spsId !== next.id) { throw new CodecError('UNSUPPORTED', 'PPS refers to an SPS that is not the active one'); }
            }
            // The picture must cover destRect and not exceed it by more than macroblock padding
            if ((next.visibleWidth < d.width) || (next.visibleHeight < d.height) ||
                (next.codedWidth > roundUp16(d.width)) || (next.codedHeight > roundUp16(d.height))) {
                throw new CodecError('INVALID', 'H.264 picture size does not fit destRect');
            }
            const reconfigure = (this.vd === null) || (this.config === null) || ((spsInfo !== null) && (
                (this.config.codec !== spsInfo.codec) || (this.config.codedWidth !== spsInfo.codedWidth) || (this.config.codedHeight !== spsInfo.codedHeight) || (this.config.id !== spsInfo.id)));
            if (reconfigure && !idr) {
                throw new CodecError(this.reclaimed ? 'UNSUPPORTED' : 'INVALID', this.reclaimed ? 'H.264 decoder was reclaimed; an IDR picture must restart it' : 'the decoder must be (re)started with an IDR picture');
            }

            const bytes = Math.ceil(next.codedWidth * next.codedHeight * 1.5);
            if (this.budget) { this.budget.reserve(bytes); } // throws LIMIT
            const entry = { ctx: ctx, meta: meta, resolve: null, reject: null, bytes: bytes, charged: !!this.budget, released: false,
                expect: { codedWidth: next.codedWidth, codedHeight: next.codedHeight }, timer: null };
            this.outstanding++;
            const ts = this.nextTs++;
            const promise = new Promise(function (resolve, reject) { entry.resolve = resolve; entry.reject = reject; });
            try {
                if (reconfigure) {
                    if (this.vd === null) { this._newDecoder(); }
                    const cfg = { codec: next.codec, codedWidth: next.codedWidth, codedHeight: next.codedHeight, optimizeForLatency: true };
                    if (this.hardwareAcceleration !== null) { cfg.hardwareAcceleration = this.hardwareAcceleration; }
                    this.vd.configure(cfg);
                    this.config = next;
                    this.reclaimed = false;
                }
                this.pending.set(ts, entry);
                this.vd.decode(new this.Chunk({ type: idr ? 'key' : 'delta', timestamp: ts, data: stream }));
            } catch (ex) {
                this.pending.delete(ts);
                this._release(entry);
                throw (ex instanceof CodecError) ? ex : mapDecoderError(ex);
            }
            if ((this.setT !== null) && (this.decodeTimeoutMs > 0)) {
                const vd = this.vd, self = this;
                entry.timer = this.setT(function () { entry.timer = null; self._onTimeout(vd); }, this.decodeTimeoutMs);
            }
            return promise;
        }

        // AVC444 reads its pictures back as YUV: software decoding gives deterministic I420. A decoder that is already running with another
        // setting restarts (pending pictures resolve to null, the next picture must be an IDR picture).
        preferSoftware() {
            if (this.hardwareAcceleration === 'prefer-software') { return; }
            this.hardwareAcceleration = 'prefer-software';
            if (this.vd !== null) { this.reset(); }
        }

        // RESETGRAPHICS, DELETESURFACE: drop everything in flight; unresolved submissions resolve to null
        reset() {
            const entries = Array.from(this.pending.values());
            this.pending.clear();
            const vd = this.vd;
            this.vd = null;
            this.config = null;
            this.failure = null;
            this.reclaimed = false;
            if (vd !== null) {
                try { if (vd.state !== 'closed') { vd.close(); } } catch (ex) { /* nothing to do */ }
            }
            for (const entry of entries) { this._release(entry); entry.resolve(null); }
        }

        close() {
            this.reset();
            this.closed = true;
        }

        // { ok, decodeMs }: decodes the built-in IDR and two P pictures for real, checks the pixels and times it
        static async probe(opts) {
            opts = opts || {};
            const VD = opts.VideoDecoder || ((typeof VideoDecoder !== 'undefined') ? VideoDecoder : null);
            const Chunk = opts.EncodedVideoChunk || ((typeof EncodedVideoChunk !== 'undefined') ? EncodedVideoChunk : null);
            const now = opts.now || ((typeof performance !== 'undefined') ? function () { return performance.now(); } : function () { return Date.now(); });
            const timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : PROBE_TIMEOUT_MS;
            const maxMs = (opts.maxMs != null) ? opts.maxMs : PROBE_MAX_MS;
            const fail = { ok: false, decodeMs: 0 };
            if ((VD === null) || (Chunk === null)) { return fail; }
            let vd = null, timer = null;
            const frames = [];
            const setT = opts.setTimeout || ((typeof setTimeout !== 'undefined') ? setTimeout : null);
            const clrT = opts.clearTimeout || ((typeof clearTimeout !== 'undefined') ? clearTimeout : null);
            try {
                const first = PROBE_CHUNKS.map(function (c) { return { type: c.type, data: hex(c.data) }; });
                const spsNal = scanNals(first[0].data).filter(function (n) { return n.type === 7; })[0];
                const sps = parseSps(first[0].data, spsNal.start, spsNal.end);
                const cfg = { codec: sps.codec, codedWidth: sps.codedWidth, codedHeight: sps.codedHeight, optimizeForLatency: true };
                const support = await VD.isConfigSupported(cfg);
                if (!support || !support.supported) { return fail; }
                let failed = false, timedOut = false, wake = null;
                vd = new VD({
                    output: function (f) { frames.push(f); if (wake) { wake(); } },
                    error: function () { failed = true; if (wake) { wake(); } }
                });
                const t0 = now();
                vd.configure(cfg);
                if (setT !== null) { timer = setT(function () { timedOut = true; if (wake) { wake(); } }, timeoutMs); }
                // One picture in, one picture out, as in a session: a decoder that holds its output back (reorder window)
                // never produces the next picture and fails here
                for (let i = 0; i < first.length; i++) {
                    vd.decode(new Chunk({ type: first[i].type, timestamp: i + 1, data: first[i].data }));
                    await new Promise(function (resolve) {
                        wake = function () { if (failed || timedOut || (frames.length > i)) { resolve(); } };
                        wake();
                    });
                    if (failed || timedOut) { break; }
                }
                const decodeMs = Math.round((now() - t0) * 10) / 10;
                if (failed || timedOut || (frames.length < first.length)) { return { ok: false, decodeMs: Math.min(decodeMs, 60000) }; }
                // The last picture must show the red and blue halves (the white square is not sampled)
                const last = frames[frames.length - 1];
                const px = await readRgba(last, { x: 0, y: 40, width: 64, height: 16 }, opts);
                const red = [px[(4 * 8)], px[(4 * 8) + 1], px[(4 * 8) + 2]], blue = [px[(4 * 56)], px[(4 * 56) + 1], px[(4 * 56) + 2]];
                const pixelsOk = (red[0] > 150) && (red[2] < 100) && (blue[2] > 150) && (blue[0] < 100);
                const total = Math.round((now() - t0) * 10) / 10;
                return { ok: pixelsOk && (total <= maxMs), decodeMs: Math.min(total, 60000) };
            } catch (ex) {
                return fail;
            } finally {
                if (timer !== null) { clrT(timer); }
                for (const f of frames) { try { f.close(); } catch (ex) { /* closed */ } }
                try { if (vd !== null) { vd.close(); } } catch (ex) { /* closed */ }
            }
        }
    }

    return Object.freeze({
        Avc420Decoder: Avc420Decoder, parseMetablock: parseMetablock, parseSps: parseSps, parsePps: parsePps, scanNals: scanNals, readRgba: readRgba,
        DECODE_TIMEOUT_MS: DECODE_TIMEOUT_MS, MAX_REGIONS: MAX_REGIONS, PROBE_CHUNKS: PROBE_CHUNKS, PROBE_MAX_MS: PROBE_MAX_MS, PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS
    });
});
