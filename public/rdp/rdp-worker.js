/**
* @description Web-RDP browser worker (legacy mode): validates and decodes WIRE frames, draws, acknowledges
* @license Apache-2.0
*
* Loaded as a Web Worker (new Worker('rdp/rdp-worker.js')). The engine class has no DOM or global
* dependency, so it also runs under Node with stub codecs and a fake canvas.
*
* Messages from the UI thread:
*   { t: 'probe', avc444? }                 measure the H.264 decoder (Avc420Decoder.probe); with avc444 also the AVC444 pair (Avc444Decoder.probe); answered with 'probe-result'
*   { t: 'caps' }                           is the RemoteFX decoder usable (RfxDecoder.probe); answered with 'caps-result'
*   { t: 'init', canvas?, width, height, epoch, mode?, dev?, rfx? }   first message ('legacy' or 'gfx'; dev: report frame timings; rfx: the
*                                           session advertised legacy Surface Commands, SURFACE_BITS frames are accepted); `canvas` is a transferred OffscreenCanvas, without
*                                           it the worker posts decoded pixels back ({ t: 'draw' })
*   { t: 'reset', canvas?, width, height, epoch }  rdp-resize: new desktop size (and a new OffscreenCanvas, because the
*                                           placeholder size of a transferred canvas cannot follow), pointer cache and
*                                           decoder state reset; applied in order after the frames before it
*   { t: 'output', canvas?, width, height, epoch }  GFX only: the answer to 'desktop', the new output canvas of the new
*                                           desktop size; everything mapped is painted again. Handled at once, not queued: the
*                                           END_FRAME that follows the ResetGraphics waits for it
*   { t: 'drawn', bytes, epoch }            fallback only: the UI drew `bytes` of a { t: 'draw' } message
*   { t: 'frame', buffer, received }        one binary WIRE frame (ArrayBuffer), `received` = UI cumulative bytes
*   { t: 'close' }
* Messages to the UI thread:
*   { t: 'ready', codecs }                  worker loaded
*   { t: 'ack', total }                     cumulative processed bytes, forwarded as ['ack', total]
*   { t: 'client-error', code, message? }   CodecError code; the worker applies nothing after it (message: dev mode only)
*   { t: 'probe-result', ok, decodeMs, avc444? } the H.264 probe (infos.options.browser.h264); avc444: { ok, decodeMs } when asked for (infos.options.browser.avc444)
*   { t: 'caps-result', rfx }               the RemoteFX probe (infos.options.browser.rfx)
*   { t: 'gfx-ack', frameId, queueDepth }   END_FRAME fully rendered, forwarded as ['gfx-ack', ...] before the ack that covers it
*   { t: 'desktop', width, height }         GFX only: ResetGraphics changed the desktop size; the UI replaces the canvas and
*                                           answers with 'output'
*   { t: 'stats', frames: [...] }           dev only: per-frame timing records (rdp/WIRE.md is not involved)
*   { t: 'closed', decoders }               dev only: answer to 'close', VideoDecoder instances created and closed
*   { t: 'pointer', kind, ..., epoch }      'hidden' | 'default' | 'set' (RGBA) | 'cached'
*   { t: 'draw', x, y, width, height, buffer, epoch }  fallback drawing without OffscreenCanvas; the worker stops taking
*                                           frames while un-confirmed draw bytes exceed about one desktop
*   Every draw and pointer message carries the `epoch` of the init/reset it belongs to; the UI drops older ones.
*
* Frames are applied strictly in order and counted as processed only after every operation has been
* drawn (rdp/WIRE.md "Byte window"), in order: the bytes of a frame whose H.264 pictures are still in the decoder are credited
* when they are painted, and the credit of later frames waits behind them. BITMAP, POINTER and, in a GFX session, GFX frames are handled (a GFX frame may
* wait for the asynchronous H.264 decoder; later frames wait behind it). SURFACE_BITS (RemoteFX) is handled when init said `rfx`: tiles are
* painted straight from the decoder's 64x64 tile buffer with putImageData(dirty rectangle), no desktop-sized scratch.
*/
if ((typeof importScripts === 'function') && (typeof module === 'undefined')) {
    // Worker scope: the shared files and the codecs register themselves on `self`. The decoders are
    // optional here, a missing one makes frames of that codec fail with UNSUPPORTED.
    importScripts('shared/limits.js', 'shared/constants.js', 'shared/errors.js', 'codecs/errors.js', 'wire-parser.js', 'flow.js');
    ['codecs/interleaved.js', 'codecs/planar.js', 'codecs/alpha.js', 'codecs/nsc.js', 'codecs/clear.js', 'codecs/avc420.js', 'codecs/avc444-simd.js', 'codecs/avc444.js', 'codecs/rfx-common.js', 'codecs/rfx.js', 'codecs/progressive.js', 'gfx/budget.js', 'gfx/pdu.js', 'gfx/surface.js', 'gfx/client.js'].forEach(function (file) { try { importScripts(file); } catch (ex) { /* decoder not deployed */ } });
}
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('./shared/limits.js'), require('./shared/constants.js'), require('./codecs/errors.js'), require('./wire-parser.js'), require('./flow.js'),
            { budget: require('./gfx/budget.js'), client: require('./gfx/client.js') });
    } else {
        root.RdpClient = root.RdpClient || {};
        const g = root.RdpGfx || {};
        root.RdpClient.worker = factory(root.RdpShared.limits, root.RdpShared.constants, root.RdpCodecs.errors, root.RdpClient.wireParser, root.RdpClient.flow,
            (g.budget && g.client) ? { budget: g.budget, client: g.client } : null);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, constants, codecErrors, wireParser, flow, gfxLib) {
    'use strict';
    const CodecError = codecErrors.CodecError;
    const CODEC = constants.WIRE_BITMAP_CODEC;
    const POINTER = constants.WIRE_POINTER;
    const SCRATCH_RETAIN_BYTES = 16 * 1024 * 1024; // a larger decode buffer is used once and dropped
    const DRAW_BACKLOG_MIN_BYTES = 4 * 1024 * 1024;

    class RdpWorkerEngine {
        // deps: { post(message, transfer), codecs: { interleaved?, planar?, avc420? }, setTimer, clearTimer, ImageData?, now?, avcDeps?, gfx? }
        constructor(deps) {
            this.post = deps.post;
            this.now = deps.now || function () { return Date.now(); };
            this.gfxLib = (deps.gfx !== undefined) ? deps.gfx : gfxLib;
            this.avcDeps = deps.avcDeps || {};       // VideoDecoder / EncodedVideoChunk of the page, for tests and the dev counters
            this.setTimer = deps.setTimer;
            this.clearTimer = deps.clearTimer;
            this.mode = 'legacy';
            this.dev = false;
            this.gfx = null;            // GfxClient of a GFX session
            this.codecsBase = {};       // codec counts of GfxClients replaced by a pipeline restart
            this.busy = false;          // a GFX frame waits for the asynchronous decoder
            this.credits = [];          // frames in arrival order: { bytes, done }; their bytes are credited as processed in this order
            this.applied = 0;           // cumulative bytes of the frames whose application has started (the queue depth is what is behind them)
            this.statsBuffer = [];
            this.statsTimer = null;
            this.statsDropped = 0;
            this.codecs = deps.codecs || {};
            this.surfaceBits = false;   // legacy Surface Commands (RemoteFX) were advertised in this session
            this.rfx = null;            // RfxDecoder of the legacy Surface Bits
            this.budget = null;
            this.tileImage = null;      // ImageData over the RemoteFX decoder's tile buffer
            this.tileSource = null;
            this.surfaceStats = { frames: 0, bytes: 0, pieces: 0 };   // dev: legacy Surface Bits seen; reported in the 'stats' message
            this.surfaceDirty = false;
            this._sink = (tx, ty, px, py, pw, ph, pix) => { this._tile(tx, ty, px, py, pw, ph, pix); };
            this.ImageDataCtor = deps.ImageData || ((typeof ImageData !== 'undefined') ? ImageData : null);
            this.ack = new flow.AckState({
                send: (total) => { this.post({ t: 'ack', total: total }); },
                setTimer: deps.setTimer,
                clearTimer: deps.clearTimer
            });
            this.size = null;           // { width, height } of the desktop, null before 'init'
            this.canvas = null;         // OffscreenCanvas, or null in the posting fallback
            this.ctx = null;
            this.pointerCache = new Set();
            this.scratch = null;        // retained decode buffer (Uint8ClampedArray)
            this.failed = false;
            this.closed = false;
            this.epoch = 0;
            this.queue = [];            // frames and resets in arrival order, applied by _pump
            this.pumping = false;
            this.drawInFlight = 0;      // fallback: bytes posted as 'draw' and not yet confirmed by the UI (all epochs)
            this.drawByEpoch = new Map(); // the same bytes per epoch: a reset must not forget draws of the old epoch
            this.drawWaiters = [];        // GFX compositions waiting for draw credit (without OffscreenCanvas)
            this.drawBacklogMax = deps.drawBacklogMax;   // test hook; default: one desktop, at least DRAW_BACKLOG_MIN_BYTES
        }

        handle(msg) {
            if (this.closed || (msg == null) || (typeof msg !== 'object')) { return; }
            try {
                switch (msg.t) {
                    case 'init': this._init(msg); break;
                    case 'reset':
                        // rdp-resize: legacy reactivation, or (GFX) the server restarted the graphics pipeline: all GFX state is dropped
                        this.queue.push({ reset: msg }); this._pump(); break;
                    case 'output': this._output(msg); break;
                    case 'probe': this._probe(msg.avc444 === true); break;
                    case 'caps': this._caps(); break;
                    case 'frame': this._frame(msg); break;
                    case 'drawn':
                        if (Number.isSafeInteger(msg.bytes) && (msg.bytes > 0)) { this._drawConfirmed(msg.epoch, msg.bytes); this._pump(); }
                        break;
                    case 'close': this.close(); break;
                    default: break;
                }
            } catch (ex) {
                this._fail(codecErrors.toCodecError(ex).code, ex);
            }
        }

        close() {
            const wasOpen = !this.closed;
            this.closed = true;
            if (this.rfx !== null) { try { this.rfx.close(); } catch (ex) { /* closing */ } this.rfx = null; }
            this.tileImage = null;
            if (wasOpen) { this._flushStats(true); }
            this._closeGfx();
            if (wasOpen && this.dev) { this.post({ t: 'closed', decoders: this._decoderCounts(), codecs: this._codecsSeen() }); }
            this.ack.reset();
            this.credits.length = 0;
            this.scratch = null;
            this.queue.length = 0;
            this.ctx = null;
            this.canvas = null;
        }

        _checkSize(width, height) {
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width < 1) || (height < 1) ||
                (width > limits.DESKTOP_MAX_DIM) || (height > limits.DESKTOP_MAX_DIM) || ((width * height) > limits.SURFACES_MAX_PIXELS)) {
                throw new CodecError('LIMIT', 'desktop size');
            }
        }

        _decoderCounts() { return this.counters ? { created: this.counters.created, closed: this.counters.closed } : { created: 0, closed: 0 }; }

        _closeGfx() {
            if (this.gfx !== null) { try { this.gfx.close(); } catch (ex) { /* closing */ } }
        }

        _probe(withAvc444) {
            const mod = this.codecs.avc420, mod444 = this.codecs.avc444;
            const none = { ok: false, decodeMs: 0 };
            const clean = function (r) { return { ok: (r.ok === true), decodeMs: Number.isFinite(r.decodeMs) ? r.decodeMs : 0 }; };
            const self = this;
            const done = function (r, r444) {
                const m = { t: 'probe-result', ok: r.ok, decodeMs: r.decodeMs };
                if (withAvc444) { m.avc444 = r444; }
                self.post(m);
            };
            if (!mod || !mod.Avc420Decoder) { done(none, none); return; }
            mod.Avc420Decoder.probe(this.avcDeps).then(function (r) {
                const h264 = clean(r);
                // AVC444 needs a working H.264 decoder and its own measurement (two decoders, the combine step, pixels)
                if (!withAvc444 || !h264.ok || !mod444 || !mod444.Avc444Decoder) { done(h264, none); return; }
                mod444.Avc444Decoder.probe(self.avcDeps).then(function (r444) { done(h264, clean(r444)); }, function () { done(h264, none); });
            }, function () { done(none, none); });
        }

        // RemoteFX is usable when the decoder module is loaded and decodes its built-in message correctly
        _caps() {
            const mod = this.codecs.rfx;
            let ok = false;
            try { ok = !!mod && (typeof mod.RfxDecoder === 'function') && (typeof mod.probe === 'function') && (mod.probe() === true); } catch (ex) { ok = false; }
            this.post({ t: 'caps-result', rfx: ok });
        }

        // ---- dev statistics (rdp/WIRE.md is not involved): per-frame timing records, batched ---------
        _record(rec) {
            if (!this.dev) { return; }
            if (this.statsBuffer.length >= 4096) { this.statsDropped++; return; }
            this.statsBuffer.push({
                frameId: rec.id, recvAt: rec.recvAt, startAt: rec.startAt, submitAt: rec.submitAt, decodedAt: rec.decodedAt, readAt: rec.readAt,
                paintedAt: rec.paintedAt, bytes: rec.bytes, avcBytes: rec.avcBytes, pictures: rec.pictures, codecs: rec.codecs, queueDepth: rec.queueDepth
            });
            if (this.statsBuffer.length >= 64) { this._flushStats(); }
            else if (this.statsTimer === null) {
                const self = this;
                this.statsTimer = this.setTimer(function () { self.statsTimer = null; self._flushStats(); }, 250);
            }
        }

        // force: also without new frame records (the codecs seen so far reach the page when the session ends)
        _flushStats(force) {
            if (this.statsTimer !== null) { this.clearTimer(this.statsTimer); this.statsTimer = null; }
            if ((this.statsBuffer.length === 0) && !this.surfaceDirty && !(force && this.dev && (this.gfx !== null))) { return; }
            const frames = this.statsBuffer;
            this.statsBuffer = [];
            const m = { t: 'stats', frames: frames, dropped: this.statsDropped, decoders: this._decoderCounts(), codecs: this._codecsSeen() };
            if ((this.gfx !== null) && (this.gfx.stats.simd !== null)) { m.simd = this.gfx.stats.simd; }
            if (this.surfaceDirty) { m.surface = Object.assign({}, this.surfaceStats); this.surfaceDirty = false; }
            this.post(m);
        }

        _codecsSeen() {
            const out = Object.assign({}, this.codecsBase);
            if (this.gfx !== null) { for (const [k, v] of Object.entries(this.gfx.stats.codecs)) { out[k] = (out[k] || 0) + v; } }
            return out;
        }

        _init(msg) {
            // One init per worker: a second one would leave frames of the old session in flight against the new counters
            if (this.size !== null) { throw new CodecError('INVALID', 'init twice'); }
            this._checkSize(msg.width, msg.height);
            this.mode = (msg.mode === 'gfx') ? 'gfx' : 'legacy';
            this.dev = (msg.dev === true);
            this.surfaceBits = ((msg.rfx === true) && (this.mode === 'legacy'));
            this.softwareAvc = (msg.avc444 === true);        // the session confirmed a 10.x set that may carry AVC444: H.264 decoding in software from the start
            this._closeGfx();
            this.gfx = null;
            if (this.mode === 'gfx') {
                if (this.gfxLib === null) { throw new CodecError('UNSUPPORTED', 'GFX modules are not available'); }
                this.budget = new this.gfxLib.budget.Budget();
                this.gfx = this._newGfx(msg.width, msg.height);
            }
            this.canvas = msg.canvas || null;
            if (this.canvas !== null) {
                this.canvas.width = msg.width;
                this.canvas.height = msg.height;
                this.ctx = this.canvas.getContext('2d', { alpha: false });
                if (this.ctx == null) { throw new CodecError('INTERNAL', 'no 2d context'); }
            }
            this.size = { width: msg.width, height: msg.height };
            this.epoch = Number.isSafeInteger(msg.epoch) ? msg.epoch : 0;
            this.drawInFlight = 0; this.drawByEpoch.clear();
            this.pointerCache.clear();
            this.post({ t: 'ready', offscreen: (this.canvas !== null), mode: this.mode, codecs: { interleaved: !!this.codecs.interleaved, planar: !!this.codecs.planar, avc420: !!this.codecs.avc420, rfx: !!this.codecs.rfx } });
        }

        _newGfx(width, height) {
            const self = this;
            return new this.gfxLib.client.GfxClient({
                codecs: this.codecs, budget: this.budget, avcDeps: this.avcDeps, softwareAvc: (this.softwareAvc === true), now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
                present: function (x, y, w, h, data) { self._draw(x, y, w, h, data); },
                // without OffscreenCanvas the UI thread draws: the composition waits for draw credit between bands
                drawBlocked: function () { return self._drawBlocked(); },
                waitDraw: function (fn) { self.drawWaiters.push(fn); },
                resizeOutput: function (w, h) { self.post({ t: 'desktop', width: w, height: h }); },
                sendAck: function (frameId, depth) { self.post({ t: 'gfx-ack', frameId: frameId, queueDepth: depth }); },
                queueDepth: function () { return Math.max(0, self.ack.received - self.applied); },
                onError: function (err) { self._fail(codecErrors.toCodecError(err).code, err); },
                record: this.dev ? function (rec) { self._record(rec); } : null
            }, { width: width, height: height });
        }

        // GFX: the UI replaced the output canvas after a 'desktop' message. A stale answer (the desktop changed again) is ignored.
        _output(msg) {
            if ((this.gfx === null) || (this.size === null)) { throw new CodecError('INVALID', 'output without a GFX session'); }
            this._checkSize(msg.width, msg.height);
            if ((msg.width !== this.gfx.desktop.width) || (msg.height !== this.gfx.desktop.height)) { return; }
            if (msg.canvas) {
                this.canvas = msg.canvas;
                this.canvas.width = msg.width; this.canvas.height = msg.height;
                this.ctx = this.canvas.getContext('2d', { alpha: false });
                if (this.ctx == null) { throw new CodecError('INTERNAL', 'no 2d context'); }
            } else if (this.canvas !== null) { this.canvas.width = msg.width; this.canvas.height = msg.height; }
            this.size = { width: msg.width, height: msg.height };
            this.epoch = Number.isSafeInteger(msg.epoch) ? msg.epoch : this.epoch;
            this.gfx.outputReady(msg.width, msg.height);
        }

        _reset(msg) {
            if (this.size === null) { throw new CodecError('INVALID', 'reset before init'); }
            this._checkSize(msg.width, msg.height);
            if (msg.canvas) {
                this.canvas = msg.canvas;
                this.canvas.width = msg.width; this.canvas.height = msg.height;
                this.ctx = this.canvas.getContext('2d', { alpha: false });
                if (this.ctx == null) { throw new CodecError('INTERNAL', 'no 2d context'); }
            } else if (this.canvas !== null) { this.canvas.width = msg.width; this.canvas.height = msg.height; }
            this.size = { width: msg.width, height: msg.height };
            this.epoch = Number.isSafeInteger(msg.epoch) ? msg.epoch : this.epoch; // drawInFlight is kept: draws of the old epoch are still on their way
            // the pointer cache is kept (WIRE.md): servers refer to shapes set before a reactivation
            this.scratch = null;
            if (this.mode === 'gfx') {
                // The server started a new graphics pipeline: surfaces, caches, contexts and decoders of the old one are gone with it
                // (their frames were applied and acknowledged before this item, the queue is ordered). Statistics of the old client are kept.
                if (this.gfx !== null) {
                    for (const [k, v] of Object.entries(this.gfx.stats.codecs)) { this.codecsBase[k] = (this.codecsBase[k] || 0) + v; }
                    this._closeGfx();
                }
                this.gfx = this._newGfx(msg.width, msg.height);
            }
            if (this.rfx !== null) { this.rfx.reset(); }
            for (const name of Object.keys(this.codecs)) {
                const c = this.codecs[name];
                if ((c != null) && (typeof c.reset === 'function')) { c.reset(); }
            }
        }

        // Counts the frame as received (hard pending limit) and queues it
        _frame(msg) {
            if (this.failed) { return; }
            const buffer = msg.buffer;
            if (!(buffer instanceof ArrayBuffer) && !(buffer instanceof Uint8Array)) { throw new CodecError('INVALID', 'frame is not binary'); }
            const bytes = buffer.byteLength;
            const total = Number.isSafeInteger(msg.received) ? msg.received : undefined;
            if (!this.ack.receive(bytes, total)) { throw new CodecError('LIMIT', 'pending bytes'); }
            this.queue.push({ frame: buffer, bytes: bytes, receivedAt: this.now() });
            this._pump();
        }

        // The UI confirms every draw (also a dropped one) with the epoch it carried; only bytes that were posted can be released
        _drawConfirmed(epoch, bytes) {
            const have = this.drawByEpoch.get(epoch) || 0;
            const take = Math.min(bytes, have);
            if (take === 0) { return; }
            if (have - take > 0) { this.drawByEpoch.set(epoch, have - take); } else { this.drawByEpoch.delete(epoch); }
            this.drawInFlight -= take;
            this._wakeDraw();
        }

        // Credit may have returned: the compositions that waited for it try again (each re-registers when still blocked)
        _wakeDraw() {
            if (this.drawWaiters.length === 0) { return; }
            const list = this.drawWaiters;
            this.drawWaiters = [];
            for (const fn of list) { try { fn(); } catch (ex) { /* the waiter reports its own failure */ } }
        }

        // In fallback mode the UI thread draws; do not run ahead of it by more than about one desktop
        _drawBlocked() {
            if ((this.canvas !== null) || (this.size === null)) { return false; }
            const max = (this.drawBacklogMax != null) ? this.drawBacklogMax : Math.max(DRAW_BACKLOG_MIN_BYTES, this.size.width * this.size.height * 4);
            return this.drawInFlight >= max;
        }

        // Applies queued items strictly in order; a frame waits while the UI has not confirmed earlier draws, and a GFX
        // frame while the H.264 decoder has not finished (nothing behind it is applied meanwhile)
        _pump() {
            if (this.pumping || this.busy) { return; }
            this.pumping = true;
            try {
                while ((this.queue.length > 0) && !this.failed && !this.closed && !this.busy) {
                    const item = this.queue[0];
                    if (item.frame && this._drawBlocked()) { break; }
                    this.queue.shift();
                    try {
                        if (item.frame) {
                            const wait = this._apply(item);
                            if (wait) { this._wait(wait, item); }
                        } else { this._reset(item.reset); }
                    } catch (ex) {
                        this._fail(codecErrors.toCodecError(ex).code, ex);
                    }
                }
            } finally { this.pumping = false; }
        }

        // The credit of finished frames, strictly in arrival order: a frame behind an unfinished one waits
        _credit() {
            try {
                while ((this.credits.length > 0) && this.credits[0].done) { this.ack.processedBytes(this.credits.shift().bytes); }
            } catch (ex) { this._fail('INTERNAL'); }
        }

        _complete(entry) {
            entry.done = true;
            if (!this.closed && !this.failed) { this._credit(); }
        }

        _wait(promise, item) {
            this.busy = true;
            const self = this;
            promise.then(function () {
                self.busy = false;
                if (self.closed || self.failed) { return; }
                // Asynchronous application (queue-full picture, budget retry): its picture may still be in the decoder
                const painted = (self.gfx !== null) ? self.gfx.paintedPromise() : null;
                if (painted !== null) {
                    const entry = item.entry;
                    painted.then(function () { self._complete(entry); });
                } else { self._complete(item.entry); }
                self._pump();
            }, function (ex) {
                self.busy = false;
                self._fail(codecErrors.toCodecError(ex).code, ex);
            });
        }

        // → a Promise when the frame waits for the asynchronous decoder
        _apply(item) {
            const frame = wireParser.parseFrame(item.frame, this.size, { gfx: (this.mode === 'gfx'), surfaceBits: this.surfaceBits });
            item.entry = { bytes: item.bytes, done: false };
            this.credits.push(item.entry);
            this.applied += item.bytes;
            if (frame.type === 'gfx') {
                const wait = this.gfx.applyFrame(frame.body, { bytes: item.bytes, receivedAt: item.receivedAt });
                if (wait !== null) { return wait; }
                // Pictures still in the decoder: the frame is processed when they are painted (rdp/WIRE.md "Byte window")
                const painted = this.gfx.paintedPromise();
                if (painted !== null) {
                    const self = this, entry = item.entry;
                    painted.then(function () { self._complete(entry); });
                    return null;
                }
            } else if (frame.type === 'bitmap') { this._bitmap(frame); } else if (frame.type === 'surface') { this._surface(frame); } else { this._pointer(frame); }
            this._complete(item.entry);
            return null;
        }

        // ex (optional): a CodecError whose message (never image data) goes to the page in the dev mode
        _fail(code, ex) {
            if (this.failed) { return; }
            this.failed = true;
            this.queue.length = 0;
            this.credits.length = 0;
            this._flushStats(true);
            this._closeGfx();
            this.ack.reset();
            const m = { t: 'client-error', code: code };
            if (this.dev && (ex instanceof CodecError)) { m.message = ex.message; }
            this.post(m);
        }

        _getScratch(bytes) {
            if (bytes > SCRATCH_RETAIN_BYTES) { return new Uint8ClampedArray(bytes); }
            if ((this.scratch === null) || (this.scratch.length < bytes)) { this.scratch = new Uint8ClampedArray(Math.max(bytes, 64 * 1024)); }
            return new Uint8ClampedArray(this.scratch.buffer, 0, bytes);
        }

        _bitmap(frame) {
            for (const r of frame.rects) {
                const data = this._getScratch(r.width * r.height * 4);
                const dst = { data: data, stride: r.width * 4, width: r.width, height: r.height };
                const rect = { x: 0, y: 0, width: r.width, height: r.height };
                this._decode(r, rect, dst);
                this._draw(r.destLeft, r.destTop, r.width, r.height, data);
            }
        }

        // Legacy Surface Bits: RemoteFX tiles go to the canvas as they are decoded
        _surface(frame) {
            if (frame.codec !== constants.WIRE_SURFACE_CODEC.REMOTEFX) { throw new CodecError('UNSUPPORTED', 'surface codec'); }
            const mod = this.codecs.rfx;
            if (!mod || (typeof mod.RfxDecoder !== 'function')) { throw new CodecError('UNSUPPORTED', 'decoder not available'); }
            if (this.rfx === null) {
                if ((this.budget === null) && (this.gfxLib !== null)) { this.budget = new this.gfxLib.budget.Budget(); }
                this.rfx = new mod.RfxDecoder({ budget: this.budget });
            }
            const area = { x: frame.left, y: frame.top, width: frame.right - frame.left, height: frame.bottom - frame.top };
            try { this.rfx.decodeToSink(frame.payload, area, { clip: area }, this.size, this._sink); } catch (ex) { throw codecErrors.toCodecError(ex); }
            if (this.dev) {
                this.surfaceStats.frames++;
                this.surfaceStats.bytes += frame.payload.length;
                this.surfaceDirty = true;
                if (this.statsTimer === null) { const self = this; this.statsTimer = this.setTimer(function () { self.statsTimer = null; self._flushStats(); }, 250); }
            }
        }

        // One visible piece of a decoded tile: `pix` is the decoder's 64x64 RGBA tile (valid during the call)
        _tile(tx, ty, px, py, pw, ph, pix) {
            if (this.dev) { this.surfaceStats.pieces++; }
            if (this.ctx !== null) {
                if (this.ImageDataCtor === null) { throw new CodecError('INTERNAL', 'no ImageData'); }
                if ((this.tileImage === null) || (this.tileSource !== pix)) { this.tileImage = new this.ImageDataCtor(pix, 64, 64); this.tileSource = pix; }
                this.ctx.putImageData(this.tileImage, tx, ty, px, py, pw, ph);
                return;
            }
            const tight = new Uint8ClampedArray(pw * ph * 4);
            for (let j = 0; j < ph; j++) {
                const s = (((py + j) * 64) + px) * 4;
                tight.set(pix.subarray(s, s + (pw * 4)), j * pw * 4);
            }
            this._draw(tx + px, ty + py, pw, ph, tight);
        }

        _decode(r, rect, dst) {
            const params = { bpp: r.bpp, bitmapWidth: r.bitmapWidth, bitmapHeight: r.bitmapHeight };
            let decoder;
            try {
                switch (r.codec) {
                    case CODEC.RAW:
                        decoder = this.codecs.interleaved;
                        if (!decoder || (typeof decoder.decodeRaw !== 'function')) { break; }
                        params.bottomUp = r.bottomUp;
                        decoder.decodeRaw(r.payload, rect, dst, params);
                        return;
                    case CODEC.INTERLEAVED:
                        decoder = this.codecs.interleaved;
                        if (!decoder || (typeof decoder.decode !== 'function')) { break; }
                        decoder.decode(r.payload, rect, dst, params);
                        return;
                    case CODEC.PLANAR:
                        decoder = this.codecs.planar;
                        if (!decoder || (typeof decoder.decode !== 'function')) { break; }
                        decoder.decode(r.payload, rect, dst, { bitmapWidth: r.bitmapWidth, bitmapHeight: r.bitmapHeight, bottomUp: true, opaque: true });
                        this._opaque(dst);
                        return;
                    default: throw new CodecError('INVALID', 'bitmap codec');
                }
            } catch (ex) {
                throw codecErrors.toCodecError(ex);
            }
            throw new CodecError('UNSUPPORTED', 'decoder not available');
        }

        // The desktop is opaque: planar data may carry an alpha plane, ignore it
        _opaque(dst) {
            const d = dst.data, end = dst.width * dst.height * 4;
            for (let i = 3; i < end; i += 4) { d[i] = 255; }
        }

        _draw(x, y, width, height, data) {
            if (this.ctx !== null) {
                if (this.ImageDataCtor === null) { throw new CodecError('INTERNAL', 'no ImageData'); }
                this.ctx.putImageData(new this.ImageDataCtor(data, width, height), x, y);
            } else {
                const copy = new Uint8ClampedArray(data); // the scratch buffer is reused, the copy is transferred
                this.drawInFlight += copy.byteLength;
                this.drawByEpoch.set(this.epoch, (this.drawByEpoch.get(this.epoch) || 0) + copy.byteLength);
                this.post({ t: 'draw', x: x, y: y, width: width, height: height, buffer: copy.buffer, epoch: this.epoch }, [copy.buffer]);
            }
        }

        _pointer(p) {
            switch (p.kind) {
                case POINTER.HIDDEN: this.post({ t: 'pointer', kind: 'hidden', epoch: this.epoch }); break;
                case POINTER.SYSTEM_DEFAULT: this.post({ t: 'pointer', kind: 'default', epoch: this.epoch }); break;
                case POINTER.SET: {
                    if (p.cacheIndex !== constants.WIRE_POINTER_NO_CACHE) { this.pointerCache.add(p.cacheIndex); }
                    const copy = new Uint8Array(p.rgba); // own copy, the frame buffer is not transferred
                    this.post({
                        t: 'pointer', kind: 'set', cacheIndex: p.cacheIndex, hotX: p.hotX, hotY: p.hotY,
                        width: p.width, height: p.height, rgba: copy.buffer, epoch: this.epoch
                    }, [copy.buffer]);
                    break;
                }
                case POINTER.CACHED:
                    if (!this.pointerCache.has(p.cacheIndex)) { throw new CodecError('INVALID', 'pointer not in the cache'); }
                    this.post({ t: 'pointer', kind: 'cached', cacheIndex: p.cacheIndex, epoch: this.epoch });
                    break;
                case POINTER.POSITION: break; // a browser cannot move the system pointer; the frame is validated only
                default: throw new CodecError('INVALID', 'pointer kind');
            }
        }
    }

    // VideoDecoder instances created and closed, counted by state: a decoder that failed or was reclaimed is closed
    // by the browser without a close() call, and still counts as closed
    function countDecoders(Base) {
        const live = new Set();
        const counters = { created: 0, closedBase: 0 };
        const cls = class extends Base {
            constructor(init) { super(init); counters.created++; live.add(this); }
        };
        Object.defineProperty(counters, 'closed', {
            enumerable: true,
            get() {
                for (const d of Array.from(live)) { if (d.state === 'closed') { live.delete(d); counters.closedBase++; } }
                return counters.closedBase;
            }
        });
        return { cls: cls, counters: counters };
    }

    // Worker bootstrap: only when loaded as a dedicated worker script
    if ((typeof WorkerGlobalScope !== 'undefined') && (typeof self !== 'undefined') && (self instanceof WorkerGlobalScope)) {
        let counters = { created: 0, closed: 0 };
        // Counts the VideoDecoder instances (dev report: none stays open after the session)
        const avcDeps = {};
        if (typeof VideoDecoder === 'function') {
            const counted = countDecoders(VideoDecoder);
            counters = counted.counters;
            avcDeps.VideoDecoder = counted.cls;
            avcDeps.EncodedVideoChunk = (typeof EncodedVideoChunk === 'function') ? EncodedVideoChunk : undefined;
        }
        const engine = new RdpWorkerEngine({
            post: function (m, transfer) { self.postMessage(m, transfer || []); },
            codecs: self.RdpCodecs || {},
            avcDeps: avcDeps,
            now: function () { return self.performance.timeOrigin + self.performance.now(); },
            setTimer: function (fn, ms) { return self.setTimeout(fn, ms); },
            clearTimer: function (h) { self.clearTimeout(h); }
        });
        engine.counters = counters;
        self.onmessage = function (e) { engine.handle(e.data); };
    }

    return Object.freeze({ RdpWorkerEngine: RdpWorkerEngine, countDecoders: countDecoders });
});
