/**
* @description Web-RDP session engine: entry point of the per-session process or worker thread.
* Bridges the IPC channel (rdp/IPC.md) and the RDP connection (rdp/ENGINE-API.md).
* @license Apache-2.0
*
* The engine has no network access of its own: its only I/O is the IPC channel. It must not require
* net, dgram, http, https, http2, child_process, cluster, inspector, fs or worker_threads (except
* parentPort); a unit test checks this file and everything it requires.
* Log lines are built only from constants, numbers and PHASE names.
*/
'use strict';

const { Duplex } = require('stream');
const LIMITS = require('./core/limits.js');
const errors = require('./protocol/errors.js');
const constants = require('../public/rdp/shared/constants.js');
const schema = require('./core/ipc-schema.js');

const RdpError = errors.RdpError;
const E = errors.names;
const PHASES = new Set(Object.values(errors.PHASE));
const WIRE_TYPES = new Set(Object.values(constants.WIRE));
const CTL_COST = 64;                    // rdp/IPC.md "Flow control": input, resize, visibility, ack, gfx-ack
const LOG_MAX_CHARS = 1024;
const LOG_MAX_PER_SECOND = 50;
const EXIT_FLUSH_MS = 500;              // process mode: wait at most this long for 'end' to leave
const EMPTY = new Uint8Array(0);
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function isCount(v) { return Number.isSafeInteger(v) && (v >= 0); }
function isU32(v) { return Number.isInteger(v) && (v >= 0) && (v <= 0xFFFFFFFF); }
function isDim(v) { return Number.isInteger(v) && (v >= 1) && (v <= LIMITS.DESKTOP_MAX_DIM); }

// Thread mode: a structured clone copies the whole ArrayBuffer behind a view, which may hold
// unrelated data (Buffer pool). Views that do not own their buffer are copied first.
function owned(u8) {
    if ((u8.byteOffset === 0) && (u8.byteLength === u8.buffer.byteLength)) { return u8; }
    return new Uint8Array(u8);
}

// Default IPC channels. Tests pass their own channel to run().
function processChannel() {
    if (typeof process.send != 'function') { return null; }
    return {
        thread: false,
        send: function (msg, cb) { try { process.send(msg, cb); } catch (ex) { if (cb) { cb(ex); } } },
        onMessage: function (fn) { process.on('message', fn); },
        onClose: function (fn) { process.on('disconnect', fn); },
        exit: function (code) { process.exit(code); }
    };
}

function threadChannel(port) {
    return {
        thread: true,
        send: function (msg, cb) { try { port.postMessage(msg); } catch (ex) { if (cb) { cb(ex); } return; } if (cb) { cb(null); } },
        onMessage: function (fn) { port.on('message', fn); },
        onClose: function (fn) { port.on('close', fn); },
        exit: function (code) { process.exit(code); }   // ends this worker thread only
    };
}

// Relay transport handed to the connection (tls.connect({ socket: transport })). Readable side:
// bytes from the RDP server ('net'); writable side: bytes to the RDP server (posted as 'net').
class RelayTransport extends Duplex {
    constructor(engine) {
        super({ allowHalfOpen: true });
        this._engine = engine;
        this._queue = [];
        this._wanting = false;
        this._ended = false;
        this._endPushed = false;
        this._pushed = 0;               // bytes handed to the readable side
        this._pendingWrite = null;      // { chunk, offset, cb } waiting for relay credit
    }
    // Bytes the consumer has read out of the readable buffer
    delivered() { return this._pushed - this.readableLength; }
    feed(chunk) { this._queue.push(chunk); this._pump(); }
    feedEnd() { this._ended = true; this._pump(); }
    _read() { this._wanting = true; this._pump(); this._engine.scheduleNetAck(); }
    _pump() {
        while (this._wanting && (this._queue.length > 0)) {
            const c = this._queue.shift();
            this._pushed += c.length;
            this._wanting = this.push(c);
        }
        if (this._ended && (this._queue.length === 0) && !this._endPushed) { this._endPushed = true; this.push(null); }
        this._engine.scheduleNetAck();
    }
    _write(chunk, encoding, cb) {
        if (!(chunk instanceof Uint8Array)) { chunk = Buffer.from(chunk, encoding); }
        this._pendingWrite = { chunk: chunk, offset: 0, cb: cb };
        this._flushWrite();
    }
    // Post 'net' chunks while engine → relay in flight < RELAY_OUTPUT_QUEUE_BYTES
    _flushWrite() {
        const w = this._pendingWrite;
        if (w == null) { return; }
        const eng = this._engine;
        while ((w.offset < w.chunk.length) && eng.relayOutputOpen()) {
            const n = Math.min(eng.L.IPC_CHUNK_MAX_BYTES, w.chunk.length - w.offset);
            eng.postNet(w.chunk.subarray(w.offset, w.offset + n));
            w.offset += n;
        }
        if (w.offset >= w.chunk.length) { this._pendingWrite = null; w.cb(); }
    }
    // The engine counts delivered bytes as pushed − readableLength; unshift would make that undercount
    unshift() { throw new RdpError(E.RDP_ERROR_INTERNAL); }
    _final(cb) { cb(); }
    _destroy(err, cb) { this._queue.length = 0; this._pendingWrite = null; cb(err); }
}

class Engine {
    constructor(channel, options) {
        this.ch = channel;
        this.L = Object.assign({}, LIMITS.limits, options.limits || {});
        this.createConnection = options.createConnection || null;
        this.strict = (options.strict === true);    // tests: a release larger than what is reserved is an accounting bug (INTERNAL), not clamped
        this.started = false;
        this.ended = false;             // 'end' posted
        this.exiting = false;
        this.connected = false;
        this.phase = null;
        this.config = null;
        this.credentials = null;
        this.secrets = new Set();
        this.connection = null;
        this.transport = null;
        this.timers = { heartbeat: null, connect: null, nla: null, ack: null, rate: null };
        // token bucket for posted WIRE frames (ENGINE_OUT_FRAMES_PER_SECOND): a hostile server cannot turn tiny frames into main thread load
        this.frameTokens = this.L.ENGINE_OUT_FRAME_BURST; this.frameTokensAt = null;
        // counters (cumulative, rdp/IPC.md)
        this.netIn = 0; this.netInAcked = 0; this.netEnd = false;
        this.netOut = 0; this.netOutAcked = 0;
        this.outPosted = 0; this.outAcked = 0; this.browserAck = 0;
        this.clipPosted = 0; this.clipAcked = 0; this.clipPending = null;
        this.ctlHandled = 0; this.ctlAckPosted = 0;
        this.outQueue = []; this.outQueueBytes = 0; this.outBlocked = false;
        this.ledger = []; this.framesDecoded = 0; this.gfxGeneration = 0;
        this.abort = new AbortController();     // io.signal: connection deadline and end of the session
        this.inputQueue = [];
        this.holding = false;
        this.allocated = 0;
        this.logWindow = 0; this.logCount = 0;
    }

    // ---- outgoing messages ----
    send(msg, cb) { if (!this.exiting || (msg.t === 'end')) { this.ch.send(msg, cb); } }
    data(u8) { return this.ch.thread ? owned(u8) : u8; }

    hello() {
        this.send({ t: 'hello', v: 1, node: process.version });
        const self = this;
        this.timers.heartbeat = setInterval(function () { self.send({ t: 'heartbeat', rss: self.memory() }); self.logFlow(); }, this.L.ENGINE_HEARTBEAT_MS);
    }

    // Process mode: resident set size. Thread mode: process.memoryUsage().rss is the whole server, so the worker reports the memory of
    // its own isolate (V8 heap in use plus external memory, which includes its ArrayBuffers); the main process checks it like a process RSS.
    memory() {
        if (!this.ch.thread) { return process.memoryUsage.rss(); }
        const u = process.memoryUsage();
        return u.heapUsed + Math.max(u.external, u.arrayBuffers);
    }

    // ---- incoming messages ----
    onMessage(m) {
        if (this.exiting) { return; }
        try {
            if ((m == null) || (typeof m != 'object') || (typeof m.t != 'string')) { return this.fatal(); }
            if (!this.started && (m.t !== 'start') && (m.t !== 'quit')) { return this.fatal(); }
            switch (m.t) {
                case 'start': return this.onStart(m);
                case 'net': return this.onNet(m);
                case 'net-end': if (this.netEnd) { return this.fatal(); } this.netEnd = true; this.transport.feedEnd(); return;
                case 'net-out-ack': return this.onNetOutAck(m);
                case 'clipboard-ack': return this.onClipboardAck(m);
                case 'out-ack': return this.onOutAck(m);
                // browser acknowledgements are acknowledged too (ctl-ack): receipt-based credit, also for a worker
                case 'ack': this.handled(CTL_COST); return this.onAck(m);
                case 'gfx-ack': this.handled(CTL_COST); return this.onGfxAck(m);
                case 'input': return this.onInput(m);
                case 'clipboard':
                    if ((typeof m.text != 'string') || (((m.text.length + 1) * 2) > this.L.CLIPBOARD_MAX_BYTES)) { return this.fatal(); }
                    this.handled(CTL_COST + (2 * m.text.length));
                    if (!this.ended) { this.connection.clipboard(m.text); }
                    return;
                case 'resize':
                    if (!isDim(m.width) || !isDim(m.height)) { return this.fatal(); }
                    this.handled(CTL_COST);
                    if (!this.ended) { this.connection.resize(m.width, m.height); }
                    return;
                case 'visibility':
                    if (typeof m.visible != 'boolean') { return this.fatal(); }
                    this.handled(CTL_COST);
                    if (!this.ended) { this.connection.visibility(m.visible); }
                    return;
                case 'quit': return this.quit();
                default: return this.fatal();
            }
        } catch (ex) {
            this.end(ex);
        }
    }

    onStart(m) {
        if (this.started) { return this.fatal(); }
        const c = m.credentials;
        const config = schema.config(m.config);
        if ((m.v !== 1) || (config == null) || (c == null) || (typeof c != 'object')) { return this.fatal(); }
        for (const k of ['domain', 'username', 'password']) {
            const a = c[k];
            if (!(a instanceof Uint8Array) || ((a.length & 1) !== 0) || (a.length > (2 * this.L.CREDENTIAL_FIELD_MAX_CHARS))) { return this.fatal(); }
        }
        this.started = true;
        this.config = Object.freeze(config);
        this.credentials = Object.freeze({ domain: c.domain, username: c.username, password: c.password });
        this.transport = new RelayTransport(this);
        const self = this;
        this.timers.connect = setTimeout(function () { const err = new RdpError(E.RDP_ERROR_TIMEOUT, { phase: self.phase }); self.abort.abort(err); self.end(err); }, this.L.CONNECT_TIMEOUT_MS);
        let factory = this.createConnection;
        if (factory == null) {
            try { factory = require('./protocol/connection.js').createConnection; } catch (ex) { factory = null; }
            if (typeof factory != 'function') { return this.end(new RdpError(E.RDP_ERROR_INTERNAL)); }
        }
        this.connection = factory(this.io());
        this.connection.start();
    }

    onNet(m) {
        const d = m.data;
        if (!(d instanceof Uint8Array) || (d.length === 0) || (d.length > this.L.IPC_CHUNK_MAX_BYTES) || this.netEnd) { return this.fatal(); }
        this.netIn += d.length;
        // main sends while in flight < ENGINE_INPUT_QUEUE_BYTES; one relay message may follow in chunks, and the messages the websocket
        // receiver still holds from the chunk it was parsing when the relay was paused (one socket chunk of slack)
        if ((this.netIn - this.netInAcked) > (this.L.ENGINE_INPUT_QUEUE_BYTES + this.L.RELAY_MSG_MAX_BYTES + this.L.IPC_CHUNK_MAX_BYTES)) { return this.fatal(); }
        if (this.ended) { this.netInAcked = this.netIn; return; }
        this.transport.feed(d);
    }

    onNetOutAck(m) {
        if (!isCount(m.total) || (m.total < this.netOutAcked) || (m.total > this.netOut)) { return this.fatal(); }
        this.netOutAcked = m.total;
        if (this.transport != null) { this.transport._flushWrite(); }
        this.flushInput();
        this.scheduleNetAck();
    }

    onClipboardAck(m) {
        if (!isCount(m.total) || (m.total < this.clipAcked) || (m.total > this.clipPosted)) { return this.fatal(); }
        this.clipAcked = m.total;
        if ((this.clipPending != null) && (this.clipPosted === this.clipAcked)) { const t = this.clipPending; this.clipPending = null; this.postClipboard(t); }
    }

    onOutAck(m) {
        if (!isCount(m.total) || (m.total < this.outAcked) || (m.total > this.outPosted)) { return this.fatal(); }
        this.outAcked = m.total;
        this.flushOutput();
    }

    // Browser byte ack, validated and deduplicated by the main process (rdp/IPC.md "ACK validation")
    onAck(m) {
        if (!isCount(m.total) || (m.total <= this.browserAck) || (m.total > this.outPosted)) { return this.fatal(); }
        if ((this.ledger.length > 0) && (m.total >= this.ledger[0].endOffset)) { return this.end(new RdpError(E.RDP_ERROR_CLIENT_PROTOCOL)); }
        this.browserAck = m.total;
        this.flushOutput();
    }

    onGfxAck(m) {
        if (!isU32(m.frameId) || !Number.isInteger(m.queueDepth) || (m.queueDepth < 0) || (m.queueDepth > 0xFFFFFFFE)) { return this.fatal(); }
        if ((this.ledger.length === 0) || (this.ledger[0].frameId !== m.frameId)) { return this.end(new RdpError(E.RDP_ERROR_CLIENT_PROTOCOL)); }
        const f = this.ledger.shift();
        this.perfAck(f);
        // a frame of a closed GFX channel: accepted, not forwarded, not counted
        if (f.gen === this.gfxGeneration) {
            this.framesDecoded = (this.framesDecoded + 1) >>> 0;
            if (!this.ended) { this.connection.gfxAck({ frameId: m.frameId, queueDepth: m.queueDepth, totalFramesDecoded: this.framesDecoded }); }
        }
        this.flushOutput();
    }

    onInput(m) {
        const ev = m.ev;
        if (!schema.inputEvent(ev)) { return this.fatal(); }
        this.handled(CTL_COST);
        if (this.ended) { return; }
        const q = this.inputQueue;
        if ((q.length === 0) && this.relayOutputOpen()) { this.connection.input(ev); return; }
        // relay output full: queue, coalescing consecutive pointer moves
        const last = q[q.length - 1];
        if (isPointerMove(ev) && (last != null) && isPointerMove(last)) { q[q.length - 1] = ev; return; }
        if (q.length >= this.L.ENGINE_INPUT_EVENTS_MAX) { return this.end(new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: this.phase })); }
        q.push(ev);
        this.scheduleNetAck();
    }

    flushInput() {
        while ((this.inputQueue.length > 0) && this.relayOutputOpen() && !this.ended) { this.connection.input(this.inputQueue.shift()); }
    }

    // Control credit: the cost of every handled control message is acknowledged (batched)
    handled(cost) { this.ctlHandled += cost; this.scheduleAcks(); }

    // ---- flow control ----
    relayOutputOpen() { return (this.netOut - this.netOutAcked) < this.L.RELAY_OUTPUT_QUEUE_BYTES; }
    frameCredit() {
        return ((this.outPosted - this.outAcked) < this.L.ENGINE_OUTPUT_QUEUE_BYTES) &&
            ((this.outPosted - this.browserAck) < this.L.WINDOW_BYTES) &&
            (this.ledger.length < this.L.GFX_MAX_UNACKED_FRAMES) &&
            this.frameRateOpen();
    }
    // refills the frame bucket from the clock; true while a token is left
    frameRateOpen() {
        const now = Date.now();
        if (this.frameTokensAt != null) { this.frameTokens = Math.min(this.L.ENGINE_OUT_FRAME_BURST, this.frameTokens + ((Math.max(0, now - this.frameTokensAt) * this.L.ENGINE_OUT_FRAMES_PER_SECOND) / 1000)); }
        this.frameTokensAt = now;
        return this.frameTokens >= 1;
    }
    outputBlocked() { return (this.outQueue.length > 0) || !this.frameCredit(); }
    netAckOpen() { return !this.holding && !this.outputBlocked() && (this.inputQueue.length === 0) && this.relayOutputOpen(); }

    scheduleNetAck() { this.scheduleAcks(); }
    scheduleAcks() {
        if ((this.timers.ack != null) || this.exiting) { return; }
        const self = this;
        this.timers.ack = setImmediate(function () { self.timers.ack = null; self.postAcks(); });
    }
    postAcks() {
        if (this.exiting) { return; }
        if (this.ctlHandled > this.ctlAckPosted) { this.ctlAckPosted = this.ctlHandled; this.send({ t: 'ctl-ack', total: this.ctlHandled }); }
        if ((this.transport != null) && this.netAckOpen()) {
            const d = this.ended ? this.netIn : this.transport.delivered();
            if (d > this.netInAcked) { this.netInAcked = d; this.send({ t: 'net-ack', total: d }); }
        }
    }

    postNet(u8) {
        if (this.ended) { return; }        // after 'end' the relay is closed by the main process
        this.netOut += u8.length;
        this.send({ t: 'net', data: this.data(u8) });
    }

    // Frames are posted in order while credit allows; the rest wait in outQueue (charged to the budget).
    // charged: bytes the caller already reserved for this frame and hands over (released when posted);
    // without it the engine reserves the frame itself and the caller keeps (and releases) its own charge.
    // The GFX channel generation is the one current when the frame is submitted.
    sendFrame(frame, endFrameIds, options) {
        if (this.ended) { return; }
        if (!(frame instanceof Uint8Array) || (frame.length < 1) || (frame.length > this.L.WIRE_FRAME_MAX_BYTES) || !WIRE_TYPES.has(frame[0])) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        let ids = null;
        if (endFrameIds != null) {
            if (!Array.isArray(endFrameIds) || (frame[0] !== constants.WIRE.GFX)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
            for (const id of endFrameIds) { if (!isU32(id)) { throw new RdpError(E.RDP_ERROR_INTERNAL); } }
            ids = endFrameIds.slice();
        }
        if (!this.connected) { throw new RdpError(E.RDP_ERROR_INTERNAL); }   // no frame before 'connect'
        let charge = frame.length;
        if ((options != null) && (options.charged != null)) {
            charge = options.charged;
            if (!Number.isSafeInteger(charge) || (charge < 0) || (charge > this.allocated)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        } else {
            this.reserve(charge);
        }
        this.outQueue.push({ data: frame, ids: ids, gen: this.gfxGeneration, charge: charge, sentAt: (ids !== null) ? this.perfEnd() : 0 });
        this.outQueueBytes += frame.length;
        this.flushOutput();
    }

    // Control messages that must not overtake frames still waiting for credit in the output queue
    sendOrdered(messages) {
        if (this.outQueue.length === 0) { for (const m of messages) { this.send(m); } return; }
        this.outQueue.push({ ctl: messages, data: EMPTY, ids: null, gen: this.gfxGeneration, charge: 0 });
        this.flushOutput();
    }

    flushOutput() {
        if (this.exiting) { return; }
        while ((this.outQueue.length > 0) && !this.ended) {
            const head = this.outQueue[0];
            // A control message queued behind frames goes out right after them, without credit (it carries no bytes)
            if (head.ctl != null) { this.outQueue.shift(); for (const m of head.ctl) { this.send(m); } continue; }
            if (!this.frameCredit()) { break; }
            const f = this.outQueue.shift();
            this.frameTokens -= 1;
            this.outQueueBytes -= f.data.length;
            this.release(f.charge);
            this.outPosted += f.data.length;
            this.send({ t: 'out', data: this.data(f.data) });
            if (f.ids != null) { const at = this.perfPosted(f); for (const id of f.ids) { this.ledger.push({ frameId: id, endOffset: this.outPosted, gen: f.gen, postedAt: at }); } }
        }
        // Commit the state before calling drain(): a drain() that blocks the output again sets outBlocked
        // through a nested flushOutput(), which must not be overwritten afterwards.
        const blocked = this.outputBlocked();
        // Only the frame rate may be what holds the queue (or the connection, through drain()) back: come back when a token is refilled
        if (blocked && (this.timers.rate == null) && !this.ended && !this.exiting && (this.frameTokens < 1)) {
            const self = this;
            this.timers.rate = setTimeout(function () { self.timers.rate = null; self.flushOutput(); }, Math.max(1, Math.ceil(((1 - this.frameTokens) * 1000) / this.L.ENGINE_OUT_FRAMES_PER_SECOND)));
        }
        if (blocked) { this.outBlocked = true; }
        else if (this.outBlocked) {
            this.outBlocked = false;
            if (!this.ended && (this.connection != null) && (typeof this.connection.drain == 'function')) { this.connection.drain(); }
        }
        this.scheduleNetAck();
    }

    postClipboard(text) {
        if (this.clipPosted > this.clipAcked) { this.clipPending = text; return; }   // newer text replaces a pending one
        this.clipPosted++;
        this.send({ t: 'clipboard', text: text });
    }

    reserve(n) {
        if (!Number.isSafeInteger(n) || (n < 0)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        if ((this.allocated + n) > this.L.ENGINE_ALLOC_MAX_BYTES) { throw new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: this.phase }); }
        this.allocated += n;
    }
    // Production clamps at zero (a double release must not turn into a negative budget); the tests run strict and see the bug
    release(n) {
        if (this.strict && (!Number.isSafeInteger(n) || (n < 0) || (n > this.allocated))) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        this.allocated = Math.max(0, this.allocated - n);
    }

    // ---- secrets ----
    wipeSecrets() {
        if (this.credentials != null) { for (const k of ['domain', 'username', 'password']) { this.credentials[k].fill(0); } }
        for (const s of this.secrets) { try { s.fill(0); } catch (ex) { } }
        this.secrets.clear();
    }

    // ---- lifecycle ----
    setPhase(p) {
        if (!PHASES.has(p)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        this.phase = p;
        this.send({ t: 'phase', phase: p });
        const self = this;
        if (p === errors.PHASE.NLA) {
            if (this.timers.nla == null) { this.timers.nla = setTimeout(function () { self.end(new RdpError(E.RDP_ERROR_TIMEOUT, { phase: errors.PHASE.NLA })); }, this.L.NLA_TIMEOUT_MS); }
        } else if (this.timers.nla != null) { clearTimeout(this.timers.nla); this.timers.nla = null; }
    }

    // Session over. err: null/undefined → clean, otherwise any exception (sanitized by toRdpError).
    end(err) {
        if (this.ended || this.exiting) { return; }
        this.ended = true;
        this.wipeSecrets();
        clearTimeout(this.timers.connect); clearTimeout(this.timers.nla); clearTimeout(this.timers.rate); this.timers.rate = null;
        if (!this.abort.signal.aborted) { this.abort.abort(errors.toRdpError((err == null) ? new RdpError(E.RDP_ERROR_CONNECTION_LOST) : err, this.phase)); }
        this.outQueue.length = 0; this.inputQueue.length = 0; this.clipPending = null;
        const msg = { t: 'end', clean: (err == null) };
        if (err != null) {
            const e = errors.toRdpError(err, this.phase);
            msg.error = e.toWire();
            // the certificate the server presented, only for a changed pinned certificate (rdp/IPC.md end.cert)
            if ((e.code === E.RDP_ERROR_CERT_CHANGED) && (typeof e.certFingerprint == 'string') && FINGERPRINT.test(e.certFingerprint)) { msg.cert = { fingerprint256: e.certFingerprint }; }
        }
        this.send(msg);
        this.closeConnection();
        // waits for 'quit'; the main process kills the engine after ENGINE_QUIT_KILL_MS
    }

    closeConnection() {
        const c = this.connection;
        this.connection = null;
        if ((c != null) && (typeof c.close == 'function')) { try { c.close(); } catch (ex) { } }
        if (this.transport != null) { try { this.transport.destroy(); } catch (ex) { } }
    }

    // Malformed IPC from the main process
    fatal() { this.exit(new RdpError(E.RDP_ERROR_INTERNAL)); }

    quit() {
        this.wipeSecrets();
        if (!this.abort.signal.aborted) { this.abort.abort(new RdpError(E.RDP_ERROR_CONNECTION_LOST)); }
        this.closeConnection();
        this.exit(null);
    }

    // Leave the process/thread. When 'end' has not been sent yet and err is given, it is sent first
    // and the engine exits only after it has left (process mode: send callback, at most EXIT_FLUSH_MS).
    exit(err) {
        if (this.exiting) { return; }
        this.wipeSecrets();
        let msg = null;
        if (!this.ended && (err != null)) { msg = { t: 'end', clean: false, error: errors.toRdpError(err, this.phase).toWire() }; }
        this.ended = true;
        this.exiting = true;
        if (!this.abort.signal.aborted) { this.abort.abort(new RdpError(E.RDP_ERROR_INTERNAL)); }
        for (const k of ['heartbeat', 'connect', 'nla', 'rate']) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }
        if (this.timers.ack != null) { clearImmediate(this.timers.ack); }
        this.closeConnection();
        const ch = this.ch;
        const code = (err == null) ? 0 : 1;
        if (msg == null) { ch.exit(code); return; }
        let done = false;
        const finish = function () { if (!done) { done = true; ch.exit(code); } };
        setTimeout(finish, EXIT_FLUSH_MS);
        ch.send(msg, finish);
    }

    // ---- interface for the connection (rdp/ENGINE-API.md) ----
    io() {
        const self = this;
        return Object.freeze({
            config: this.config,
            credentials: this.credentials,
            transport: this.transport,
            signal: this.abort.signal,
            limits: Object.freeze(Object.assign({}, this.L)),
            phase: function (p) { self.setPhase(p); },
            connected: function (info) { self.onConnected(info); },
            // legacy reactivation with a new size: the browser gets rdp-resize
            resized: function (width, height) {
                if (!self.connected || !isDim(width) || !isDim(height)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
                self.log('debug', 'resized ' + width + 'x' + height + ' outPosted=' + self.outPosted + ' browserAck=' + self.browserAck + ' outAcked=' + self.outAcked + ' queued=' + self.outQueue.length);
                // After the frames already queued, so the browser resets its state exactly between the old and the new picture
                if (!self.ended) { self.sendOrdered([{ t: 'desktop', width: width, height: height }, { t: 'resize', width: width, height: height }]); }
            },
            // any other desktop size change (GFX RESETGRAPHICS): only the main process input checks follow it
            desktop: function (width, height) {
                if (!self.connected || !isDim(width) || !isDim(height)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
                if (!self.ended) { self.send({ t: 'desktop', width: width, height: height }); }
            },
            sendFrame: function (frame, endFrameIds, options) { self.sendFrame(frame, endFrameIds, options); },
            outputBlocked: function () { return self.outputBlocked(); },
            sendClipboard: function (text) {
                if ((typeof text != 'string') || (((text.length + 1) * 2) > self.L.CLIPBOARD_MAX_BYTES)) { throw new RdpError(E.RDP_ERROR_PROTOCOL, { phase: self.phase }); }
                if (!self.ended) { self.postClipboard(text); }
            },
            // GFX channel opened or closed: a new generation; frames of the old one may still be acknowledged
            gfxChannel: function () { self.gfxGeneration++; self.framesDecoded = 0; self.flushOutput(); },
            holdInput: function (hold) { self.holding = (hold === true); self.scheduleNetAck(); },
            reserve: function (n) { self.reserve(n); },
            release: function (n) { self.release(n); },
            secret: function (buf) { if (buf instanceof Uint8Array) { self.secrets.add(buf); } return buf; },
            wipe: function (buf) { if (buf instanceof Uint8Array) { buf.fill(0); self.secrets.delete(buf); } },
            wipeSecrets: function () { self.wipeSecrets(); },
            log: function (level, msg) { self.log(level, msg); },
            end: function (err) { self.end(err); }
        });
    }

    onConnected(info) {
        if (this.connected || (info == null) || !isDim(info.width) || !isDim(info.height) || ((info.mode !== 'legacy') && (info.mode !== 'gfx'))) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        let gfx = null;
        if (info.gfx != null) {
            if (!isU32(info.gfx.capsVersion) || !isU32(info.gfx.flags)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
            gfx = { capsVersion: info.gfx.capsVersion, flags: info.gfx.flags };
        }
        const fp = (info.tls != null) ? info.tls.fingerprint256 : null;
        if ((typeof fp != 'string') || !FINGERPRINT.test(fp)) { throw new RdpError(E.RDP_ERROR_INTERNAL); }
        if (this.ended) { return; }
        this.connected = true;
        clearTimeout(this.timers.connect); this.timers.connect = null;
        this.send({ t: 'connect', width: info.width, height: info.height, mode: info.mode, gfx: gfx, tls: { fingerprint256: fp }, nla: info.nla === true });
    }

    // Debug only (config.debug): one 'gfxperf' log line per second that says where the frame rate of a GFX session is held. Per frame (END_FRAME):
    //   endGap       time between two END_FRAMEs from the server (the rate the server produces frames at)
    //   fdrTurn      time from forwarding a frame acknowledgement to the server until its next END_FRAME (the server's own pacing)
    //   outWait      time a frame waited in this engine for output credit before it was posted
    //   ackRtt       time from posting the frame to the main process until its gfx-ack came back (browser decode, paint and both ways)
    //   ledgerMax    most frames posted and not yet acknowledged
    // endGap ≈ ackRtt + fdrTurn when the server waits for the acknowledgement; endGap well above ackRtt means the server is the limit.
    perfEnd() {
        if ((this.config == null) || (this.config.debug !== true)) { return 0; }
        const t = Date.now(), p = this.perf || (this.perf = { second: 0, n: 0, rtt: 0, rttMax: 0, turn: 0, turnN: 0, wait: 0, gap: 0, gapN: 0, ledgerMax: 0, lastEnd: 0, lastFwd: 0 });
        if (p.lastEnd > 0) { p.gap += t - p.lastEnd; p.gapN++; }
        if (p.lastFwd > p.lastEnd) { p.turn += t - p.lastFwd; p.turnN++; }
        p.lastEnd = t;
        return t;
    }
    perfPosted(f) {
        const p = this.perf;
        if ((p == null) || (f.sentAt === 0)) { return 0; }
        const t = Date.now();
        p.wait += t - f.sentAt;
        if ((this.ledger.length + 1) > p.ledgerMax) { p.ledgerMax = this.ledger.length + 1; }
        return t;
    }
    perfAck(entry) {
        const p = this.perf;
        if ((p == null) || (entry.postedAt === 0) || (entry.postedAt === undefined)) { return; }
        const t = Date.now(), rtt = t - entry.postedAt, second = Math.floor(t / 1000);
        if ((second !== p.second) && (p.n > 0)) {
            const avg = function (sum, n) { return n > 0 ? (sum / n).toFixed(1) : '-'; };
            this.log('debug', 'gfxperf frames=' + p.n + ' endGap=' + avg(p.gap, p.gapN) + ' fdrTurn=' + avg(p.turn, p.turnN) + ' outWait=' + avg(p.wait, p.n) +
                ' ackRtt=' + avg(p.rtt, p.n) + ' ackRttMax=' + p.rttMax + ' ledgerMax=' + p.ledgerMax);
            p.n = 0; p.rtt = 0; p.rttMax = 0; p.turn = 0; p.turnN = 0; p.wait = 0; p.gap = 0; p.gapN = 0; p.ledgerMax = 0;
        }
        p.second = second; p.n++; p.rtt += rtt; if (rtt > p.rttMax) { p.rttMax = rtt; }
        p.lastFwd = t;
    }

    // Debug only: counters that explain a stalled session (numbers and PHASE names only)
    logFlow() {
        this.log('debug', 'flow phase=' + this.phase + ' netIn=' + this.netIn + ' netInAcked=' + this.netInAcked + ' netOut=' + this.netOut + ' netOutAcked=' + this.netOutAcked +
            ' outPosted=' + this.outPosted + ' outAcked=' + this.outAcked + ' browserAck=' + this.browserAck + ' queued=' + this.outQueue.length + ' blocked=' + this.outBlocked + ' holding=' + this.holding);
    }

    log(level, msg) {
        if ((this.config == null) || (this.config.debug !== true) || ((level !== 'debug') && (level !== 'warn')) || (typeof msg != 'string') || (msg.length > LOG_MAX_CHARS)) { return; }
        const now = Date.now(), w = Math.floor(now / 1000);
        if (w !== this.logWindow) { this.logWindow = w; this.logCount = 0; }
        if (++this.logCount > LOG_MAX_PER_SECOND) { return; }
        this.send({ t: 'log', level: level, msg: msg });
    }
}

function isPointerMove(ev) { return (ev.k === 'mouse') && (ev.button === 0); }

// Entry point. options (tests only): { channel, createConnection, limits }
function run(options) {
    options = options || {};
    let channel = options.channel;
    if (channel == null) {
        const port = require('worker_threads').parentPort;
        channel = (port != null) ? threadChannel(port) : processChannel();
    }
    if (channel == null) { return null; }   // not started by rdp/client.js
    const engine = new Engine(channel, options);
    if (options.channel == null) {
        // No network API reaches the connection code, also in thread mode where no CLI flag removes them
        for (const name of ['fetch', 'WebSocket', 'EventSource']) { try { delete globalThis[name]; } catch (ex) { } }
        // An exception that escapes the connection ends the session (class name only) and the engine.
        process.on('uncaughtException', function (err) { engine.exit(err); });
        process.on('unhandledRejection', function (err) { engine.exit(err); });
    }
    channel.onMessage(function (m) { engine.onMessage(m); });
    channel.onClose(function () { engine.wipeSecrets(); if (!engine.exiting) { engine.exiting = true; channel.exit(0); } });
    engine.hello();
    return engine;
}

module.exports = { run: run, RelayTransport: RelayTransport };

if (require.main === module) { run(); }
