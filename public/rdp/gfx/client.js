/**
* @description RDPGFX client state of the browser worker: surfaces, cache, frames, ordered AVC420 painting, frame acknowledgements
* @license Apache-2.0
*
* Applies the PDUs of WIRE.GFX frames (rdp/WIRE.md "0x10 GFX") strictly in order. The only asynchronous work is H.264
* decoding: AVC420 submissions are pipelined inside one logical frame, every other operation (and END_FRAME) first waits
* until all earlier pictures are painted into their surface, so asynchronous decoding never reorders drawing. The
* frame acknowledgement of END_FRAME is sent after the composition of the frame reached the output. After a ResetGraphics
* that changed the desktop size the composition needs the replaced output: END_FRAME then waits for outputReady() (the
* owner's answer to resizeOutput, which does not depend on server data), so an acknowledged frame was always painted.
*
* No DOM: the output, the acknowledgement and the codecs are injected (see the constructor), so the module runs in Node.
* Management rules follow rdp/GFX-CAPS.md: ResetGraphics resizes the output and keeps surfaces, cache and decoders (a
* decoder restarts on the IDR picture the server sends, with a new SPS when the size changed); surfaces and cache
* entries end only with DeleteSurface / EvictCacheEntry. ClearCodec resets its sequence only. RemoteFX (CAVIDEO) is decoded by one RfxDecoder per session (reset with
* ResetGraphics). Progressive (WireToSurface2) keeps its tile state per surface (one ProgressiveContext, closed with the surface);
* DeleteEncodingContext only retires the id. AVC444 / AVC444v2 pictures are decoded by one Avc444Decoder per surface (public/rdp/codecs/avc444.js) through the same ordered paint chain; a browser without that decoder ends the session with CodecError('UNSUPPORTED'), never drawing them wrongly.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('../shared/constants.js'), require('../codecs/errors.js'), require('./pdu.js'), require('./surface.js'));
    } else {
        root.RdpGfx = root.RdpGfx || {};
        root.RdpGfx.client = factory(root.RdpShared.limits, root.RdpShared.constants, root.RdpCodecs.errors, root.RdpGfx.pdu, root.RdpGfx.surface);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, constants, codecErrors, pdu, surfaceLib) {
    'use strict';
    const CodecError = codecErrors.CodecError;
    const C = constants.GFX_CMD;
    const K = constants.GFX_CODEC;
    const Surface = surfaceLib.Surface;
    const inside = surfaceLib.inside;

    // Client-side work limit of one logical GFX frame (STARTFRAME to the next STARTFRAME, however many WIRE frames it spans), in pixels
    // written or copied (not in the wire contract): a few KiB of S2S points could otherwise ask for terabytes of copying
    // The limit grows with the desktop (full repaints and scrolls of an 8K or 8192 x 8192 desktop are legal work): the larger of this
    // value and WORK_DESKTOP_FACTOR desktops, so at most 4 x 8192 x 8192 = 256 Mpx per logical frame.
    const WORK_PIXELS_MAX = 64 * 1024 * 1024;
    const WORK_DESKTOP_FACTOR = 4;    const PRESENT_BAND_BYTES = 4 * 1024 * 1024; // RGBA composed and handed to the output at a time (the output may be a copy that waits for the UI thread)
    const AVC_REGION_BOX_AT = 64;       // above this many disjoint regions of one picture they are read as one bounding box (written through the mask)
    const READ_BAND_BYTES = 4 * 1024 * 1024;    // RGBA read back from a VideoFrame at a time: one reusable buffer of at most this size
    const UNION_OPS_MAX = 16 * 1024 * 1024;     // work allowed for turning the regions of one picture into disjoint rectangles
    const UNION_RECTS_MAX = 16384;
    const OUTPUT_TIMEOUT_MS = 10000;            // the owner must answer resizeOutput() within this time
    const DRAWING = new Set([C.WIRETOSURFACE_1, C.WIRETOSURFACE_2, C.SOLIDFILL, C.SURFACETOSURFACE, C.SURFACETOCACHE, C.CACHETOSURFACE]);

    // Regions of one AVC420 picture (they may overlap or repeat) → disjoint rectangles covering exactly their union,
    // sorted by y then x. Bounded work: LIMIT when the regions are too tangled.
    function unionRects(list) {
        if (list.length <= 1) { return list.map(function (r) { return { x: r.x, y: r.y, width: r.width, height: r.height }; }); }
        const ys = new Set();
        for (const r of list) { ys.add(r.y); ys.add(r.y + r.height); }
        const edges = Array.from(ys).sort(function (a, b) { return a - b; });
        if (edges.length * list.length > UNION_OPS_MAX) { throw new CodecError('LIMIT', 'AVC420 regions'); }
        const out = [];
        let open = new Map();       // "x0,x1" → rectangle of the previous slab that ends at the current edge
        for (let i = 0; i + 1 < edges.length; i++) {
            const y0 = edges[i], y1 = edges[i + 1];
            const spans = [];
            for (const r of list) { if ((r.y <= y0) && (r.y + r.height >= y1)) { spans.push([r.x, r.x + r.width]); } }
            spans.sort(function (a, b) { return a[0] - b[0]; });
            const next = new Map();
            let k = 0;
            while (k < spans.length) {
                let x0 = spans[k][0], x1 = spans[k][1];
                for (k++; (k < spans.length) && (spans[k][0] <= x1); k++) { x1 = Math.max(x1, spans[k][1]); }
                const key = x0 + ',' + x1;
                const prev = open.get(key);
                if (prev !== undefined) { prev.height += y1 - y0; next.set(key, prev); }
                else {
                    if (out.length >= UNION_RECTS_MAX) { throw new CodecError('LIMIT', 'AVC420 regions'); }
                    const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
                    out.push(rect); next.set(key, rect);
                }
            }
            open = next;
        }
        return out;
    }

    class GfxClient {
        // deps: {
        //   codecs: { planar?, alpha?, clear?, avc420?, avc444? }  decoder modules (public/rdp/codecs)
        //   budget: { reserve, release }          worker-wide decoder budget
        //   present(x, y, width, height, rgba)    output: RGBA (alpha 255), valid during the call only
        //   resizeOutput(width, height)           ResetGraphics changed the desktop size; the owner answers with outputReady()
        //   drawBlocked() / waitDraw(fn)          optional pair, for an output that draws behind the worker's back (no OffscreenCanvas): drawBlocked()
        //                                         is true while the owner has too many draws in flight; waitDraw(fn) calls fn once credit may have returned
        //   sendAck(frameId, queueDepth)          END_FRAME fully rendered
        //   queueDepth()                          received − processed bytes
        //   onError(error)                        an asynchronous failure (a picture that cannot be decoded or painted)
        //   now()                                 timestamps of the frame records (ms)
        //   record(frameRecord)                   optional, dev statistics
        //   setTimer(fn, ms) / clearTimer(h)      optional: the deadline for the replaced output (none without them)
        //   avcDeps                               optional: VideoDecoder / EncodedVideoChunk (and timers) for tests
        // }
        constructor(deps, desktop) {
            this.deps = deps;
            this.now = deps.now || function () { return Date.now(); };
            this.codecs = deps.codecs || {};
            this.surfaces = new Map();
            this.pixels = 0;
            this.cache = new surfaceLib.Cache();
            this.decoders = new Map();      // surfaceId → Avc420Decoder
            this.decoders444 = new Map();   // surfaceId → Avc444Decoder (one per surface and codec id; the YUV444 planes persist in it)
            this.rfx = null;                // RfxDecoder (CAVIDEO), created on the first RemoteFX picture
            this.progressive = new Map();   // surfaceId → { ctx: ProgressiveContext, ids: Set of live encoding context ids } (tile state is per surface)
            this.progressiveIds = 0;        // live encoding context ids over all surfaces
            this.clearDecoder = null;      // ClearCodec caches are shared across every surface in the session
            this.desktop = { width: desktop.width, height: desktop.height };
            this.frame = null;              // open logical frame { id, recvAt, … }
            this.tail = Promise.resolve();  // ordered AVC painting
            this.pendingPaints = 0;
            this.pendingFrames = 0;       // VideoFrames of the pictures in flight (AVC444 with both views: 2)
            this.error = null;
            this.closed = false;
            this.outputPending = false;     // a resize was requested; composition waits for outputReady()
            this.outputWait = null;         // END_FRAME waiting for outputReady(): { resolve, reject, timer }
            this.readBuffer = null;         // the one reusable RGBA buffer of AVC420 readback
            this.readReserved = 0;          // bytes of it charged to the budget
            this.work = 0;
            this.meta = null;
            this.scratch = null;            // one band of composed pixels (at most PRESENT_BAND_BYTES)
            this.presentJobs = [];          // dirty rectangles waiting to be composed: { s, x, y, width, height, row }
            this.presenting = null;         // Promise while the composition waits for draw credit
            this.stats = { frames: 0, pdus: 0, avcPictures: 0, codecs: {}, simd: null };   // codecs: codecId → WireToSurface PDUs seen (also the ones refused)
        }

        // ---- entry point ----------------------------------------------------------------------------
        // body: Uint8Array of PDUs (the WIRE frame without its type byte); meta: { bytes, receivedAt }
        // → null when applied synchronously, else a Promise that resolves when the whole frame is applied
        applyFrame(body, meta) {
            if (this.closed) { return null; }
            if (this.error !== null) { throw this.error; }
            if (this.presenting !== null) {
                // an earlier composition still waits for draw credit: nothing is applied before it has been handed to the output
                const self = this;
                return this.presenting.then(function () { return self.closed ? null : self.applyFrame(body, meta); });
            }
            this.meta = meta || { bytes: body.length + 1, receivedAt: this.now() };
            if (this.frame !== null) { this.frame.bytes += this.meta.bytes; }
            return this._run(body, 0);
        }

        _run(body, pos) {
            while (pos < body.length) {
                if (this.closed) { return null; }
                const parsed = pdu.parseNext(body, pos);
                pos = parsed.next;
                this.stats.pdus++;
                const wait = this._exec(parsed.cmd);
                if (wait !== null) {
                    const self = this;
                    return wait.then(function () { return self._run(body, pos); });
                }
            }
            return null;
        }

        _fail(err) {
            if (this.error !== null) { return; }
            this.error = codecErrors.toCodecError(err);
            if (this.deps.onError) { this.deps.onError(this.error); }
        }

        _seenCodec(id) { const c = this.stats.codecs; c[id] = (c[id] || 0) + 1; }

        // Waits until every submitted picture is painted; null when nothing is pending
        _drain() {
            if (this.pendingPaints === 0) {
                if (this.error !== null) { throw this.error; }
                return null;
            }
            const self = this;
            return this.tail.then(function () { if (self.error !== null) { throw self.error; } });
        }

        _addWork(pixels) {
            this.work += pixels;
            if (this.work > Math.max(WORK_PIXELS_MAX, WORK_DESKTOP_FACTOR * this.desktop.width * this.desktop.height)) { throw new CodecError('LIMIT', 'pixels per frame'); }
        }

        _surface(id) {
            const s = this.surfaces.get(id);
            if (s === undefined) { throw new CodecError('INVALID', 'unknown surface'); }
            return s;
        }

        // → null (done) or a Promise (must finish before the next PDU)
        _exec(cmd) {
            // Drawing is legal only inside a frame (rdp/GFX-CAPS.md "State legality")
            if (DRAWING.has(cmd.id) && (this.frame === null)) { throw new CodecError('INVALID', 'drawing outside a frame'); }
            switch (cmd.id) {
                case C.WIRETOSURFACE_1:
                    this._seenCodec(cmd.codecId);
                    if (cmd.codecId === K.AVC420) { return this._avc(cmd, false); }
                    if ((cmd.codecId === K.AVC444) || (cmd.codecId === K.AVC444v2)) { return this._avc(cmd, true); }
                    return this._barrier(function (self) { self._wireToSurface1(cmd); });
                case C.WIRETOSURFACE_2:
                    this._seenCodec(cmd.codecId);
                    return this._barrier(function (self) { self._wireToSurface2(cmd); });
                case C.STARTFRAME: return this._barrier(function (self) { self._startFrame(cmd); });
                case C.ENDFRAME: return this._barrier(function (self) { return self._endFrame(cmd); });
                case C.CREATESURFACE: return this._barrier(function (self) { self._createSurface(cmd); });
                case C.DELETESURFACE: return this._barrier(function (self) { self._deleteSurface(cmd); });
                case C.MAPSURFACETOOUTPUT: return this._barrier(function (self) { self._map(cmd); });
                case C.RESETGRAPHICS: return this._barrier(function (self) { self._reset(cmd); });
                case C.SOLIDFILL: return this._barrier(function (self) { self._solidFill(cmd); });
                case C.SURFACETOSURFACE: return this._barrier(function (self) { self._surfaceToSurface(cmd); });
                case C.SURFACETOCACHE: return this._barrier(function (self) { self._surfaceToCache(cmd); });
                case C.CACHETOSURFACE: return this._barrier(function (self) { self._cacheToSurface(cmd); });
                case C.EVICTCACHEENTRY: return this._barrier(function (self) { self.cache.evict(cmd.slot); });
                case C.DELETEENCODINGCONTEXT: return this._barrier(function (self) { self._deleteEncodingContext(cmd); });
                default: throw new CodecError('INVALID', 'PDU type');
            }
        }

        // Runs fn after the pending pictures are painted; fn may return a Promise the frame then waits for
        _barrier(fn) {
            const wait = this._drain();
            if (wait === null) { const r = fn(this); return (r === undefined) ? null : r; }
            const self = this;
            return wait.then(function () { if (!self.closed) { return fn(self); } return null; });
        }

        // Resolves when every picture submitted so far is painted (or failed); null when none is pending. The owner
        // counts the bytes of a frame with AVC420 pictures as processed only then.
        paintedPromise() { return (this.pendingPaints === 0) ? null : this.tail; }

        // ---- management -----------------------------------------------------------------------------
        _createSurface(cmd) {
            if (this.surfaces.has(cmd.surfaceId)) { throw new CodecError('INVALID', 'surface exists'); }
            if ((cmd.width > limits.SURFACE_MAX_DIM) || (cmd.height > limits.SURFACE_MAX_DIM) || (this.surfaces.size >= limits.SURFACE_MAX_COUNT) ||
                (this.pixels + (cmd.width * cmd.height) > limits.SURFACES_MAX_PIXELS)) { throw new CodecError('LIMIT', 'surfaces'); }
            this.surfaces.set(cmd.surfaceId, new Surface(cmd.surfaceId, cmd.width, cmd.height, cmd.pixelFormat));
            this.pixels += cmd.width * cmd.height;
        }

        _deleteSurface(cmd) {
            const s = this._surface(cmd.surfaceId);
            const d = this.decoders.get(s.id);
            if (d !== undefined) { d.close(); this.decoders.delete(s.id); }
            const d4 = this.decoders444.get(s.id);
            if (d4 !== undefined) { d4.close(); this.decoders444.delete(s.id); }
            this._dropProgressive(s.id);
            this.surfaces.delete(s.id);
            this.pixels -= s.width * s.height;
        }

        _dropProgressive(surfaceId) {
            const e = this.progressive.get(surfaceId);
            if (e === undefined) { return; }
            this.progressiveIds -= e.ids.size;
            this.progressive.delete(surfaceId);
            try { e.ctx.close(); } catch (ex) { /* closing */ }
        }

        // Encoding context ids are bookkeeping: the id must be live on a live surface (as the server checked), the tile state stays
        // with the surface (Windows continues on the next id with difference tiles; README.md "progressive.js")
        _deleteEncodingContext(cmd) {
            this._surface(cmd.surfaceId);
            const e = this.progressive.get(cmd.surfaceId);
            if ((e === undefined) || !e.ids.delete(cmd.contextId)) { throw new CodecError('INVALID', 'unknown encoding context'); }
            this.progressiveIds--;
        }

        _map(cmd) {
            const s = this._surface(cmd.surfaceId);
            if ((cmd.x >= this.desktop.width) || (cmd.y >= this.desktop.height)) { throw new CodecError('INVALID', 'surface origin outside the desktop'); }
            s.map = { x: cmd.x, y: cmd.y };
            s.markAllDirty();
            if (this.frame === null) { this._presentDetached(); }
        }

        _reset(cmd) {
            if (this.clearDecoder !== null) { this.clearDecoder.reset(); }
            const changed = (cmd.width !== this.desktop.width) || (cmd.height !== this.desktop.height);
            this.desktop = { width: cmd.width, height: cmd.height };
            if (this.rfx !== null) { this.rfx.reset(); }
            if (changed) {
                this.outputPending = true;
                for (const s of this.surfaces.values()) { if (s.map !== null) { s.markAllDirty(); } }
                this.deps.resizeOutput(cmd.width, cmd.height);
            }
        }

        // The owner replaced the output (canvas) after resizeOutput(): everything mapped is painted again
        outputReady(width, height) {
            if (this.closed || (width !== this.desktop.width) || (height !== this.desktop.height)) { return false; }
            this.outputPending = false;
            for (const s of this.surfaces.values()) { if (s.map !== null) { s.markAllDirty(); } }
            if (this.frame === null) { this._presentDetached(); }
            this._wakeOutputWait(null);
            return true;
        }

        _wakeOutputWait(err) {
            const w = this.outputWait;
            if (w === null) { return; }
            this.outputWait = null;
            if (w.timer !== null) { this.deps.clearTimer(w.timer); }
            if (err !== null) { w.reject(err); } else { w.resolve(); }
        }

        // END_FRAME after a size change: wait for the replaced output (bounded), so the frame is painted before it is acknowledged
        _waitOutput() {
            const self = this;
            return new Promise(function (resolve, reject) {
                const w = { resolve: resolve, reject: reject, timer: null };
                if (self.deps.setTimer) {
                    w.timer = self.deps.setTimer(function () {
                        w.timer = null;
                        self._wakeOutputWait(new CodecError('INTERNAL', 'the output was not replaced in time'));
                    }, OUTPUT_TIMEOUT_MS);
                }
                self.outputWait = w;
            });
        }

        // ---- frames ---------------------------------------------------------------------------------
        _startFrame(cmd) {
            if (this.frame !== null) { throw new CodecError('INVALID', 'nested frame'); }
            this.work = 0;      // the work limit is per logical frame
            this.frame = { id: cmd.frameId, recvAt: this.meta.receivedAt, startAt: this.now(), bytes: this.meta.bytes, avcBytes: 0, pictures: 0, submitAt: 0, decodedAt: 0, readAt: 0, paintedAt: 0, codecs: 0 };
        }

        _endFrame(cmd) {
            const f = this.frame;
            if ((f === null) || (f.id !== cmd.frameId)) { throw new CodecError('INVALID', 'EndFrame does not match StartFrame'); }
            if (this.outputPending) {
                const self = this;
                return this._waitOutput().then(function () { if (!self.closed) { return self._finishFrame(f); } return null; });
            }
            return this._finishFrame(f);
        }

        _finishFrame(f) {
            const wait = this._present();
            if (wait !== null) {
                const self = this;
                return wait.then(function () { if (!self.closed) { self._ackFrame(f); } });
            }
            this._ackFrame(f);
            return null;
        }

        _ackFrame(f) {
            this.frame = null;
            f.paintedAt = this.now();
            this.stats.frames++;
            let depth = this.deps.queueDepth ? this.deps.queueDepth() : 0;
            if (!(depth >= 0)) { depth = 0; }
            this.deps.sendAck(f.id, Math.min(depth, 0xFFFFFFFE));
            if (this.deps.record) { f.queueDepth = depth; this.deps.record(f); }
        }

        // Composes every dirty rectangle of the mapped surfaces onto the output (clipped to the desktop), in bands of at most
        // PRESENT_BAND_BYTES; with a draw-credit owner (deps.drawBlocked) it waits between bands instead of queueing a whole
        // desktop per rectangle. → null when everything has been handed to the output, else a Promise for the rest.
        _present() {
            if (!this.outputPending) {
                for (const s of this.surfaces.values()) {
                    if (s.dirty.length === 0) { continue; }
                    const list = s.dirty;
                    s.dirty = [];
                    if (s.map === null) { continue; }
                    for (const r of list) {
                        const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0);
                        const x1 = Math.min(r.x + r.width, this.desktop.width - s.map.x), y1 = Math.min(r.y + r.height, this.desktop.height - s.map.y);
                        if ((x1 <= x0) || (y1 <= y0)) { continue; }
                        this.presentJobs.push({ s: s, x: x0, y: y0, width: x1 - x0, height: y1 - y0, row: 0 });
                    }
                }
            }
            if (this.presenting !== null) { return this.presenting; }
            if (this._emit()) { return null; }
            const self = this;
            this.presenting = new Promise(function (resolve, reject) {
                const retry = function () {
                    if (self.closed) { self.presentJobs.length = 0; self.presenting = null; resolve(); return; }
                    let done;
                    try { done = self._emit(); } catch (ex) { self.presentJobs.length = 0; self.presenting = null; reject(ex); return; }
                    if (done) { self.presenting = null; resolve(); } else { self.deps.waitDraw(retry); }
                };
                self.deps.waitDraw(retry);
            });
            return this.presenting;
        }

        // A composition started outside a frame (MapSurfaceToOutput, a replaced output): a failure of its continuation fails the client
        _presentDetached() {
            const wait = this._present();
            if (wait !== null) { const self = this; wait.catch(function (ex) { self._fail(ex); }); }
        }

        // Hands bands to the output while it has credit. → true when no job is left, false when it has none
        _emit() {
            const jobs = this.presentJobs;
            while (jobs.length > 0) {
                if (this.closed) { jobs.length = 0; return true; }
                const j = jobs[0];
                const rowBytes = j.width * 4;
                const rowsMax = Math.max(1, Math.floor(PRESENT_BAND_BYTES / rowBytes));
                while (j.row < j.height) {
                    if (this.deps.drawBlocked && this.deps.waitDraw && this.deps.drawBlocked()) { return false; }
                    const rows = Math.min(rowsMax, j.height - j.row);
                    const bytes = rows * rowBytes;
                    this._reserveScratch(bytes);
                    const out = this.scratch.subarray(0, bytes);
                    j.s.compose({ x: j.x, y: j.y + j.row, width: j.width, height: rows }, out);
                    this.deps.present(j.s.map.x + j.x, j.s.map.y + j.y + j.row, j.width, rows, out);
                    j.row += rows;
                }
                jobs.shift();
            }
            return true;
        }

        // One band buffer per client, at most PRESENT_BAND_BYTES (a fixed cap, so there is nothing to reserve against the codec budget);
        // the copies the owner makes of it are held back by the draw credit
        _reserveScratch(bytes) {
            if ((this.scratch !== null) && (this.scratch.length >= bytes)) { return; }
            this.scratch = new Uint8ClampedArray(Math.max(bytes, 64 * 1024));
        }

        // ---- drawing --------------------------------------------------------------------------------
        _solidFill(cmd) {
            const s = this._surface(cmd.surfaceId);
            for (const r of cmd.rects) { this._addWork(r.width * r.height); s.fill(r, cmd.color); }
        }

        _surfaceToSurface(cmd) {
            const src = this._surface(cmd.srcId), dst = this._surface(cmd.dstId);
            if (!inside(cmd.src, src.width, src.height)) { throw new CodecError('INVALID', 'source rectangle'); }
            if (cmd.points.length === 0) { return; }
            this._addWork(cmd.src.width * cmd.src.height);      // the copy below is work even before the first point
            const tmp = src.extract(cmd.src);   // a copy first: source and destination may overlap
            for (const p of cmd.points) {
                this._addWork(cmd.src.width * cmd.src.height);
                dst.put(p.x, p.y, cmd.src.width, cmd.src.height, tmp);
            }
        }

        _surfaceToCache(cmd) {
            const s = this._surface(cmd.surfaceId);
            this._addWork(cmd.src.width * cmd.src.height);
            this.cache.set(cmd.slot, cmd.src.width, cmd.src.height, s.extract(cmd.src));
        }

        _cacheToSurface(cmd) {
            const s = this._surface(cmd.surfaceId);
            const e = this.cache.get(cmd.slot);
            if (e === undefined) { throw new CodecError('INVALID', 'cache slot is empty'); }
            for (const p of cmd.points) {
                this._addWork(e.width * e.height);
                s.put(p.x, p.y, e.width, e.height, e.data);
            }
        }

        _wireToSurface1(cmd) {
            const s = this._surface(cmd.surfaceId);
            const d = cmd.dest;
            if (!inside(d, s.width, s.height)) { throw new CodecError('INVALID', 'destination rectangle'); }
            this._addWork(d.width * d.height);
            if (this.frame !== null) { this.frame.codecs |= (1 << (cmd.codecId & 15)); }
            switch (cmd.codecId) {
                case K.CLEARCODEC: {
                    const mod = this.codecs.clear;
                    if (!mod || typeof mod.ClearCodec !== 'function') { throw new CodecError('UNSUPPORTED', 'ClearCodec decoder is not available'); }
                    if (this.clearDecoder === null) { this.clearDecoder = new mod.ClearCodec({ budget: this.deps.budget }); }
                    this.clearDecoder.decode(cmd.data, d, { data: s.data, stride: s.stride, width: s.width, height: s.height }, {});
                    if (s.opaque) {
                        for (let y = d.y; y < d.y + d.height; y++) {
                            for (let x = d.x; x < d.x + d.width; x++) { s.data[y * s.stride + x * 4 + 3] = 255; }
                        }
                    }
                    s.markDirty(d);
                    return;
                }
                case K.UNCOMPRESSED: {
                    // B, G, R, A/X per pixel, rows top-down
                    if (cmd.data.length !== d.width * d.height * 4) { throw new CodecError('INVALID', 'uncompressed data length'); }
                    const rgba = new Uint8ClampedArray(cmd.data.length);
                    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = cmd.data[i + 2]; rgba[i + 1] = cmd.data[i + 1]; rgba[i + 2] = cmd.data[i]; rgba[i + 3] = cmd.data[i + 3]; }
                    s.put(d.x, d.y, d.width, d.height, rgba);
                    return;
                }
                case K.ALPHA: {
                    const alpha = this.codecs.alpha;
                    if (!alpha || (typeof alpha.decode !== 'function')) { throw new CodecError('UNSUPPORTED', 'Alpha decoder is not available'); }
                    // XRGB has no alpha: decode and validate the whole stream, write nothing (the surface stays 255).
                    alpha.decode(cmd.data, d, s, { validateOnly: s.opaque });
                    s.markDirty(d);
                    return;
                }
                case K.PLANAR: {
                    const planar = this.codecs.planar;
                    if (!planar || (typeof planar.decode !== 'function')) { throw new CodecError('UNSUPPORTED', 'Planar decoder is not available'); }
                    planar.decode(cmd.data, d, { data: s.data, stride: s.stride, width: s.width, height: s.height },
                        { bitmapWidth: d.width, bitmapHeight: d.height, bottomUp: false, opaque: s.opaque });
                    s.markDirty(d);
                    return;
                }
                case K.CAVIDEO: {
                    const mod = this.codecs.rfx;
                    if (!mod || (typeof mod.RfxDecoder !== 'function')) { throw new CodecError('UNSUPPORTED', 'RemoteFX decoder is not available'); }
                    if (this.rfx === null) { this.rfx = new mod.RfxDecoder({ budget: this.deps.budget }); }
                    const out = this.rfx.decode(cmd.data, d, { data: s.data, stride: s.stride, width: s.width, height: s.height }, { clip: d });
                    for (const r of out.rects) { s.markDirty(r); }
                    return;
                }
                default:
                    throw new CodecError('UNSUPPORTED', 'GFX codec ' + cmd.codecId);
            }
        }

        _wireToSurface2(cmd) {
            const s = this._surface(cmd.surfaceId);
            if (cmd.codecId !== K.CAPROGRESSIVE) { throw new CodecError('INVALID', 'WireToSurface2 codec ' + cmd.codecId); }
            const mod = this.codecs.progressive;
            if (!mod || (typeof mod.ProgressiveContext !== 'function')) { throw new CodecError('UNSUPPORTED', 'Progressive decoder is not available'); }
            if (this.frame !== null) { this.frame.codecs |= (1 << (cmd.codecId & 15)); }
            let e = this.progressive.get(s.id);
            if (e === undefined) {
                e = { ctx: new mod.ProgressiveContext({ budget: this.deps.budget, surfaceWidth: s.width, surfaceHeight: s.height,
                    consumeWork: (pixels) => this._addWork(pixels) }), ids: new Set() };
                this.progressive.set(s.id, e);
            }
            if (!e.ids.has(cmd.contextId)) {
                if (this.progressiveIds >= limits.GFX_PROGRESSIVE_MAX_CONTEXTS) { throw new CodecError('LIMIT', 'encoding contexts'); }
                e.ids.add(cmd.contextId);
                this.progressiveIds++;
            }
            const out = e.ctx.decode(cmd.data, { data: s.data, stride: s.stride, width: s.width, height: s.height }, { frameId: this.frame.id });
            for (const r of out.rects) { s.markDirty(r); }
        }

        // ---- AVC420 and AVC444 / AVC444v2 -------------------------------------------------------------
        // → null (submitted) or a Promise (retry after earlier pictures drained)
        _avc(cmd, is444) {
            // AVC_MAX_PENDING_FRAMES counts VideoFrames: an AVC444 picture with both views (LC 0) holds two of them
            const need = (is444 && (cmd.data.length >= 4) && ((cmd.data[3] >>> 6) === 0)) ? 2 : 1;
            if ((this.pendingFrames + need > limits.AVC_MAX_PENDING_FRAMES) && (this.pendingPaints > 0)) {
                const self = this;
                return this._drain().then(function () { return self._avc(cmd, is444); });
            }
            const name = is444 ? 'avc444' : 'avc420';
            const mod = this.codecs[name];
            if (!mod || (typeof (is444 ? mod.Avc444Decoder : mod.Avc420Decoder) !== 'function')) { throw new CodecError('UNSUPPORTED', name.toUpperCase() + ' decoder is not available'); }
            const s = this._surface(cmd.surfaceId);
            const d = cmd.dest;
            if (!inside(d, s.width, s.height)) { throw new CodecError('INVALID', 'destination rectangle'); }
            if (!cmd.charged) { cmd.charged = true; this._addWork(d.width * d.height); }   // once, also when the submission is retried
            this._reserveReadBuffer();
            // One H.264 decoder per surface for AVC420, AVC444 and AVC444v2 pictures (one stream; FreeRDP keeps one context per surface); the
            // YUV444 planes of an AVC444 decoder follow the chroma layout, so a change of the codec id replaces only that object
            let shared = this.decoders.get(s.id);
            if (shared === undefined) {
                const o = Object.assign({ budget: this.deps.budget }, this.deps.avcDeps || {});
                // AVC444 reads its pictures back as YUV: software decoding. When the session confirmed an AVC444 set (deps.softwareAvc) the decoder starts in software
                // mode whatever the first picture is, so the first AVC444 picture after AVC420 pictures never restarts the stream
                if (is444 || (this.deps.softwareAvc === true)) { o.hardwareAcceleration = 'prefer-software'; }
                const Dec = this.codecs.avc420 && this.codecs.avc420.Avc420Decoder;
                if (typeof Dec !== 'function') { throw new CodecError('UNSUPPORTED', 'AVC420 decoder is not available'); }
                shared = new Dec(o);
                this.decoders.set(s.id, shared);
            }
            let dec = shared;
            if (is444) {
                dec = this.decoders444.get(s.id);
                if ((dec !== undefined) && (dec.opts.codecId !== cmd.codecId)) { dec.close(); this.decoders444.delete(s.id); dec = undefined; }
                if (dec === undefined) {
                    dec = new mod.Avc444Decoder(Object.assign({ budget: this.deps.budget, codecId: cmd.codecId, decoder: shared, simd: this.codecs.avc444simd || null }, this.deps.avcDeps || {}));
                    this.decoders444.set(s.id, dec);
                }
            }
            let promise;
            try {
                promise = dec.submit(cmd.data, { surfaceWidth: s.width, surfaceHeight: s.height, destRect: { x: d.x, y: d.y, width: d.width, height: d.height } });
            } catch (ex) {
                // The YUV budget is full of earlier pictures: wait for them to be painted and closed instead of ending the session
                if ((ex instanceof CodecError) && (ex.budget === true) && (this.pendingPaints > 0)) {
                    const self = this;
                    return this._drain().then(function () { return self._avc(cmd, is444); });
                }
                throw ex;
            }
            if (is444) { this.stats.simd = (dec.simd === true); }      // dev statistics: the WebAssembly kernels are in use
            const f = this.frame;
            if (f.submitAt === 0) { f.submitAt = this.now(); }
            f.codecs |= (1 << (cmd.codecId & 15));
            f.avcBytes += cmd.data.length;
            f.pictures++;
            this.stats.avcPictures++;
            promise.catch(function () { /* reported through the paint chain */ });
            this.pendingPaints++;
            this.pendingFrames += need;
            const self = this;
            this.tail = this.tail.then(function () { return self._paintPicture(s, d, promise, f, is444, need); });
            return null;
        }

        // The readback buffer is charged to the worker budget once, before any picture is submitted
        _reserveReadBuffer() {
            if (this.readReserved > 0) { return; }
            if (this.deps.budget) { this.deps.budget.reserve(READ_BAND_BYTES); }
            this.readReserved = READ_BAND_BYTES;
        }

        _readBuffer(bytes) {
            if ((this.readBuffer === null) || (this.readBuffer.length < bytes)) { this.readBuffer = new Uint8ClampedArray(Math.min(Math.max(bytes, 64 * 1024), READ_BAND_BYTES)); }
            return this.readBuffer;
        }

        _stale(surface) { return (this.error !== null) || this.closed || (this.surfaces.get(surface.id) !== surface); }

        // AVC420: result = { frame, regions }, read through the VideoFrame (RGBA conversion of the browser).
        // AVC444: result = { regions, combine(), toRgba(), close() }, the two views are combined first (public/rdp/codecs/avc444.js).
        async _paintPicture(surface, destRect, promise, frameRecord, is444, need) {
            let result = null;
            try {
                try { result = await promise; } catch (ex) { this._fail(ex); return; }
                if (result === null) { return; }            // reset or closed while in flight
                if (this._stale(surface)) { return; }
                frameRecord.decodedAt = this.now();
                let source;
                if (is444) {
                    await result.combine();
                    if (this._stale(surface)) { return; }
                    // zeroCopy: the WebAssembly kernel converts into its own band region and the page reads the pixels there (no buffer of ours, no copy)
                    source = { read: function (r, buf) { return result.toRgba(r, result.zeroCopy ? null : buf); } };
                } else {
                    const readRgba = this.codecs.avc420.readRgba, avcDeps = this.deps.avcDeps;
                    source = { read: function (r, buf) { return readRgba(result.frame, { x: r.x - destRect.x, y: r.y - destRect.y, width: r.width, height: r.height }, avcDeps, buf); } };
                }
                // Disjoint rectangles: overlapping or repeated regions are read and written once
                const rects = unionRects(result.regions);
                if (rects.length <= AVC_REGION_BOX_AT) {
                    for (const r of rects) { if (!(await this._readRect(source, surface, r, null))) { return; } }
                } else {
                    // Many regions: one read of the bounding box in bands, but only the regions themselves are written
                    let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
                    for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height); }
                    if (!(await this._readRect(source, surface, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, rects))) { return; }
                }
                frameRecord.readAt = this.now();
            } catch (ex) {
                this._fail(ex);
            } finally {
                if (result !== null) { try { if (is444) { result.close(); } else { result.frame.close(); } } catch (ex) { /* closed */ } }
                this.pendingPaints--;
                this.pendingFrames -= need;
            }
        }

        // Reads `box` (surface coordinates) from the frame in bands through the one reusable buffer and writes it into the
        // surface: all of it, or with a mask only the (disjoint) rectangles of the mask. → false when the session ended meanwhile
        async _readRect(source, surface, box, mask) {
            const rowBytes = box.width * 4;
            const rows = Math.max(1, Math.min(box.height, Math.floor(READ_BAND_BYTES / rowBytes)));
            const buf = this._readBuffer(rows * rowBytes);
            for (let y = 0; y < box.height; y += rows) {
                const h = Math.min(rows, box.height - y);
                const px = await source.read({ x: box.x, y: box.y + y, width: box.width, height: h }, buf);
                if (this._stale(surface)) { return false; }
                const top = box.y + y, bottom = top + h;
                if (mask === null) { surface.putStrided(box.x, top, box.width, h, px, 0, rowBytes); continue; }
                for (const r of mask) {
                    const ry0 = Math.max(r.y, top), ry1 = Math.min(r.y + r.height, bottom);
                    if (ry1 <= ry0) { continue; }
                    surface.putStrided(r.x, ry0, r.width, ry1 - ry0, px, ((ry0 - top) * rowBytes) + ((r.x - box.x) * 4), rowBytes);
                }
            }
            return true;
        }

        // ---- teardown -------------------------------------------------------------------------------
        // Closes every decoder (pending pictures resolve to null, their frames are closed) and drops all state
        close() {
            if (this.closed) { return; }
            this.closed = true;
            this._wakeOutputWait(null);
            for (const d of this.decoders.values()) { try { d.close(); } catch (ex) { /* closing */ } }
            this.decoders.clear();
            for (const d of this.decoders444.values()) { try { d.close(); } catch (ex) { /* closing */ } }
            this.decoders444.clear();
            if (this.rfx !== null) { try { this.rfx.close(); } catch (ex) { /* closing */ } this.rfx = null; }
            if (this.clearDecoder !== null) { this.clearDecoder.close(); this.clearDecoder = null; }
            for (const e of this.progressive.values()) { try { e.ctx.close(); } catch (ex) { /* closing */ } }
            this.progressive.clear();
            this.progressiveIds = 0;
            this.surfaces.clear();
            this.cache.clear();
            this.frame = null;
            this.scratch = null;
            this.presentJobs.length = 0;
            this.readBuffer = null;
            if (this.readReserved > 0) {
                const n = this.readReserved;
                this.readReserved = 0;
                if (this.deps.budget) { try { this.deps.budget.release(n); } catch (ex) { /* budget already reset */ } }
            }
        }
    }

    return Object.freeze({ GfxClient: GfxClient, WORK_PIXELS_MAX: WORK_PIXELS_MAX, WORK_DESKTOP_FACTOR: WORK_DESKTOP_FACTOR, unionRects: unionRects });
});
