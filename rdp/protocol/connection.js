/**
 * @description RDP connection sequence and engine adapter (MS-RDPBCGR 1.3.1.1)
 * @license Apache-2.0
 * Engine I/O is exclusively rdp/ENGINE-API.md. No socket creation, logs of peer data or credentials.
 */
'use strict';
const { Reader, Writer, concat } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError, toRdpError, fromErrorInfo } = require('./errors.js');
const transport = require('./transport.js'),
    tpkt = require('./tpkt.js'),
    x224 = require('./x224.js');
const mcs = require('./mcs.js'),
    gcc = require('./gcc.js'),
    caps = require('./caps.js'),
    info = require('./info.js'),
    redirect = require('./redirect.js');
const licensing = require('./licensing.js'),
    sessionInfo = require('./session-info.js');
const slow = require('./slowpath.js'),
    fast = require('./fastpath.js');
const { DynamicChannels } = require('../channels/drdynvc.js');
const { DisplayControl } = require('../channels/disp.js');
const { Graphics } = require('../gfx/rdpgfx.js');
const { useLegacy } = require('../gfx/errors.js');
const svc = require('../channels/svc.js'),
    clip = require('../channels/cliprdr.js');
// FreeRDP 3.10.3 core/rdp.c (Apache-2.0) skips these in its default Data-PDU branch.
// Input, RefreshRect, SuppressOutput, ShutdownRequest, FontList, PersistentCacheList,
// BitmapCacheError, OffscreenCacheError, DrawNineGridError, DrawGdiPlusError, FrameAck.
// Client-initiated desktop size changes (MS-RDPEDISP): the server answers each with a reactivation (legacy) or
// ResetGraphics (GFX), so they are paced below the 10-per-minute reactivation limit of demand().
const REFRESH_MIN_INTERVAL_MS = 1000;       // Refresh Rect (visibility true) pace
const DISP_MIN_INTERVAL_MS = 500;
const DISP_MAX_PER_MINUTE = 6;
const DISP_SETTLE_MS = 3000;            // wait this long for the server to apply a request before the next one
const BENIGN_DATA = new Set([0x1c, 0x21, 0x23, 0x24, 0x27, 0x2b, 0x2c, 0x2e, 0x30, 0x31, 0x38]);
function bad(detail = 'INVALID') {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail });
}
function createConnection(io) {
    return new Connection(io);
}
class Connection {
    constructor(io) {
        this.io = io;
        this.config = io.config;
        this.closed = false;
        this.started = false;
        this.socket = null;
        this.abort = new AbortController();
        this.state = 'transport';
        this.phase = 'x224';
        this.user = 0;
        this.global = 1003;
        this.channels = new Map();
        this.joinPending = [];
        this.everActive = false;
        this.active = false;
        this.final = null;
        this.reactivations = [];
        this.demandSeen = false;
        this.lastUnknownLog = -Infinity;
        this.reason = null;
        this.arcCookie = null;
        this.activationTimer = null;
        this.gfxConfirmTimer = null;
        this.output = new slow.Output(io, { width: this.config.width, height: this.config.height });
        this.reassembly = 0;
        const budget = {
            reserve: (n) => {
                if (this.reassembly + n > L.REASSEMBLY_MAX_BYTES)
                    throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
                io.reserve(n);
                this.reassembly += n;
            },
            release: (n) => {
                this.reassembly -= n;
                io.release(n);
            },
        };
        this.fast = new fast.Output(budget, this.output);
        this.channelBudget = budget;
        this.graphics = null;
        this.reportedConnect = false;
        this.earlyFrames = [];
        this.earlyFrameBytes = 0;
        // drdynvc is joined in both modes: Display Control (resize) needs it, the graphics pipeline only in GFX mode.
        this.display = null;
        this.layoutTimes = [];
        this.layoutTimer = null;
        this.layoutAt = -Infinity;
        this.now = () => Date.now();      // replaced by tests
        this.pendingSize = null;
        this.requested = null;
        this.gfxRestarted = false;
        this.restartUsed = false;
        this.displayDisabled = false;
        this.visible = true;
        this.visibilityPending = false;
        this.lastRefreshAt = 0; this.refreshTimer = null;
        this.failed = false;
        this.dynamic = new DynamicChannels(
            budget, b => this.sendSvc('drdynvc', b),
            this.config.mode === 'gfx' ? send => {
                // After a server-side pipeline restart (xrdp around a resize) the browser is told to drop its GFX state once
                // the new pipeline is confirmed, before any of its frames.
                const restarted = this.gfxRestarted;
                this.gfxRestarted = false;
                try {
                    this.graphics = new Graphics(io, send, () => {
                        clearTimeout(this.gfxConfirmTimer); this.gfxConfirmTimer = null;
                        this.reportConnected();
                        if (restarted) io.resized(this.desktop.width, this.desktop.height);
                        this.settled();
                    }, (width, height) => {
                        this.desktop = { width, height };
                        io.desktop(width, height);
                        this.settled();
                    }, () => this.canRestartGraphics(), restarted);
                } catch (e) { throw useLegacy(e); }
                return this.graphics;
            } : null,
            this.config.displayControl !== false ? send => {
                if (this.displayDisabled) return { receive() {}, close() {} };
                this.display = new DisplayControl(send, () => {
                    this.io.log('debug', 'Display Control caps received');
                    this.flushResize();
                }, () => {
                    this.displayDisabled = true;
                    this.io.log('debug', 'Display Control disabled: unsupported capabilities or invalid framing');
                }, this.config.displayControlEvenHeight === true);
                return this.display;
            } : null, () => this.gfxRestarted, msg => this.io.log('debug', msg));
        this.clipboardChannel = new clip.Clipboard(
            (b) => this.sendSvc('cliprdr', b),
            (t) => io.sendClipboard(t),
            (n) => io.reserve(n),
            (n) => io.release(n),
        );
        this.header = [];
        this.packetLength = 0;
        this.packetType = null;
        this.iterator = null;
        this.pumping = false;
        this.jobs = [];
        this.jobBytes = 0;
        this.txBlocked = false;
    }
    enter(phase) {
        this.phase = phase;
        this.io.phase(phase);
    }
    fail(err) {
        if (!this.failed) {
            // defense in depth: once the session has failed nothing more is read or written, whatever io.end() does
            this.failed = true;
        }
        if (!this.closed) {
            // debug only: where in our own code the error was raised (file:line of the first rdp/ frames; no message, no data)
            if (err instanceof Error && typeof err.stack === 'string') {
                const frames = [];
                for (const m of err.stack.matchAll(/\/(rdp\/[\w\/.-]+\.js:\d+):\d+/g)) if (frames.length < 3) frames.push(m[1]);
                this.io.log('debug', 'failure at ' + (frames.join(' < ') || 'unknown'));
            }
            if (
                this.reason &&
                err instanceof RdpError &&
                (err.code === 'RDP_ERROR_SERVER_DISCONNECTED' || err.code === 'RDP_ERROR_CONNECTION_LOST')
            ) {
                this.io.end(this.reason.clean ? null : toRdpError(this.reason.error, this.phase));
            } else {
                this.io.end(toRdpError(err, this.phase));
            }
        }
    }
    start() {
        if (this.started) bad();
        this.started = true;
        transport
            .connect(this.io.transport, {
                ...this.config,
                credentials: this.io.credentials,
                signal: this.abort.signal,
                onPhase: (p) => this.enter(p),
            })
            .then((result) => {
                if (this.closed) {
                    result.socket.destroy();
                    return;
                }
                this.tls = result.tls;
                this.nla = result.credssp != null;
                this.socket = result.socket;
                this.state = 'connect';
                this.enter('mcs');
                this.socket.on('readable', () => this.pump());
                this.socket.on('drain', () => {
                    this.txBlocked = false;
                    this.flush();
                    this.pump();
                });
                this.socket.on('error', () => this.fail(new RdpError('RDP_ERROR_CONNECTION_LOST')));
                this.socket.on('end', () => this.peerEnd());
                this.socket.on('close', () => this.peerEnd());
                this.sendX(mcs.connectInitial(this.config, result.selectedProtocol));
                this.pump();
            })
            .catch((e) => this.fail(e));
    }
    peerEnd() {
        if (this.closed) return;
        if (this.reason) {
            this.io.end(this.reason.clean ? null : this.reason.error);
        } else {
            this.fail(new RdpError('RDP_ERROR_CONNECTION_LOST'));
        }
    }
    // Writers are generators: a 4 MiB clipboard does not become thousands of queued TLS writes.
    enqueue(iterator, size = 0, done = null) {
        if (this.closed) return;
        if (
            this.jobs.length >= L.ENGINE_TLS_WRITE_JOBS_MAX ||
            this.jobBytes + size > L.SVC_MAX_MESSAGE_BYTES + L.RELAY_OUTPUT_QUEUE_BYTES
        )
            throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
        this.io.reserve(size);
        this.jobBytes += size;
        this.jobs.push({ iterator, size, done });
        this.flush();
    }
    flush() {
        if (this.closed || !this.socket || this.txBlocked) return;
        while (this.jobs.length && !this.txBlocked) {
            const job = this.jobs[0],
                next = job.iterator.next();
            if (next.done) {
                this.jobs.shift();
                this.jobBytes -= job.size;
                this.io.release(job.size);
                continue;
            }
            const bytes = next.value;
            const last = job.done;
            job.done = null;
            const ok = this.socket.write(bytes, (err) => {
                if (last) last();
                if (err) this.fail(new RdpError('RDP_ERROR_CONNECTION_LOST'));
            });
            if (!ok) this.txBlocked = true;
        }
    }
    send(bytes, done) {
        this.enqueue([bytes][Symbol.iterator](), bytes.length, done);
    }
    sendX(bytes, done) {
        this.send(x224.encodeData(bytes), done);
    }
    sendChannel(id, bytes) {
        this.sendX(mcs.sendData(this.user, id, bytes));
    }
    sendData(type, bytes) {
        this.sendChannel(this.global, slow.data(this.shareId, this.user, type, bytes));
    }
    sendSvc(name, bytes) {
        if (!this.channels.has(name)) return;
        const id = this.channels.get(name).id,
            user = this.user;
        function* packets() {
            // CHANNEL_FLAG_SHOW_PROTOCOL stays on for cliprdr (the flag it always had; Windows clipboard breaks without it) and is
            // off for drdynvc: with it the Windows DVC server ignores our messages and never answers the CapsAdvertise
            // (found against Windows servers; FreeRDP does not set it on drdynvc).
            for (const b of svc.chunks(bytes, 1600, name === 'cliprdr' ? 0x10 : 0)) yield x224.encodeData(mcs.sendData(user, id, b));
        }
        this.enqueue(packets(), bytes.length);
    }
    blocked() {
        return this.txBlocked || this.io.outputBlocked();
    }
    pump() {
        if (this.closed || this.failed || this.pumping || !this.socket) return;
        this.pumping = true;
        try {
            while (!this.closed && !this.blocked()) {
                if (this.reportedConnect && this.earlyFrames.length) {
                    const frame = this.earlyFrames.shift();
                    this.earlyFrameBytes -= frame.length;
                    this.io.sendFrame(frame, null, { charged: frame.length });
                    continue;
                }
                if (this.graphics && this.graphics.pending) {
                    this.graphics.drain(this.reportedConnect);
                    if (this.blocked()) break;
                    // CapsConfirm may just have enabled connected. Flush older pointer/bitmap
                    // frames before forwarding any graphics that followed it in this message.
                    if (this.reportedConnect && (this.earlyFrames.length || this.graphics.pending)) continue;
                }
                if (this.iterator) {
                    const next = this.iterator.next();
                    if (next.done) {
                        this.iterator = null;
                    } else {
                        if (!this.active) bad();
                        if (this.reportedConnect) this.io.sendFrame(next.value, null);
                        else {
                            const frame = next.value;
                            if (this.earlyFrames.length >= L.ENGINE_EARLY_FRAMES_MAX || this.earlyFrameBytes + frame.length > L.REASSEMBLY_MAX_BYTES)
                                throw this.missingGfx();
                            this.io.reserve(frame.length);
                            this.earlyFrames.push(frame);
                            this.earlyFrameBytes += frame.length;
                        }
                    }
                    continue;
                }
                const packet = this.readPacket();
                if (!packet) break;
                this.iterator = this.receive(packet.type, packet.bytes);
            }
        } catch (e) {
            this.fail(e);
        } finally {
            this.pumping = false;
        }
    }
    readPacket() {
        // Read only the requested frame. TLS/readable highWaterMark and a single <=64 KiB packet
        // bound upstream buffering even if the peer concatenates arbitrarily many PDUs.
        while (!this.packetLength) {
            const b = this.socket.read(1);
            if (b === null) return null;
            this.header.push(b[0]);
            const h = this.header;
            if (h.length === 1) {
                if (h[0] === 3) this.packetType = 'tpkt';
                else if ((h[0] & 3) === 0) this.packetType = 'fast';
                else bad();
            }
            if (this.packetType === 'tpkt' && h.length === 4) {
                this.packetLength = (h[2] << 8) | h[3];
                if (this.packetLength < 7) bad();
            }
            if (this.packetType === 'fast' && h.length >= 2) {
                if (!(h[1] & 128)) this.packetLength = h[1];
                else if (h.length === 3) this.packetLength = ((h[1] & 127) << 8) | h[2];
                if (this.packetLength && this.packetLength < h.length) bad();
            }
            if (h.length >= 4 && !this.packetLength) bad();
        }
        const rest = this.packetLength - this.header.length,
            b = rest ? this.socket.read(rest) : new Uint8Array();
        if (b === null) return null;
        let packet;
        try {
            packet = {
                type: this.packetType,
                bytes: concat([Uint8Array.from(this.header), b], L.TPKT_MAX_BYTES),
            };
        } finally {
            // read() consumed this TLS chunk; retain only the owned packet (ARC is wiped after parsing).
            b.fill(0);
        }
        this.header = [];
        this.packetLength = 0;
        return packet;
    }
    *receive(type, bytes) {
        if (type === 'fast') {
            if (!this.active) bad();
            yield* this.fast.parse(bytes);
            return;
        }
        const data = x224.decodeData(tpkt.decode(bytes));
        if (this.state === 'connect') {
            const names = gcc.channels(this.config),
                response = mcs.parseConnectResponse(data, names.length);
            this.global = response.globalChannel;
            response.channels.forEach((id, i) => {
                const name = names[i];
                this.channels.set(name, {
                    id,
                    svc: new svc.Channel(
                        this.channelBudget,
                        (b) => {
                            if (name === 'cliprdr') this.clipboardChannel.receiveMessage(b);
                            else if (name === 'drdynvc' && this.dynamic) this.dynamic.receive(b);
                            else bad();
                        },
                        name === 'cliprdr' ? () => this.clipboardChannel.discardMessage() : null,
                    ),
                });
            });
            this.state = 'attach';
            this.sendX(mcs.erectDomain());
            this.sendX(mcs.attachUser());
            return;
        }
        if (this.state === 'attach') {
            this.user = mcs.parseAttach(data);
            this.joinPending = [this.user, this.global, ...Array.from(this.channels.values(), (c) => c.id)];
            if (new Set(this.joinPending).size !== this.joinPending.length) bad();
            this.state = 'join';
            this.sendX(mcs.join(this.user, this.joinPending[0]));
            return;
        }
        if (this.state === 'join') {
            mcs.parseJoin(data, this.user, this.joinPending.shift());
            if (this.joinPending.length) {
                this.sendX(mcs.join(this.user, this.joinPending[0]));
                return;
            }
            this.state = 'session';
            this.enter('secure-settings');
            const client = this.io.secret(info.clientInfo(this.config, this.io.credentials));
            const message = this.io.secret(mcs.sendData(this.user, this.global, client));
            const frame = this.io.secret(x224.encodeData(message));
            this.send(frame, () => this.io.wipeSecrets());
            this.enter('licensing');
            return;
        }
        const pdu = mcs.parseData(data);
        if (pdu.channelId !== this.global) {
            const channel = Array.from(this.channels.values()).find((c) => c.id === pdu.channelId);
            if (!channel) bad();
            channel.svc.receive(pdu.data);
            return;
        }
        const payload = pdu.data;
        // Enhanced Security has a Basic Security Header only during licensing.
        if (this.phase === 'licensing') {
            const sec = new Reader(payload),
                flags = sec.u16le();
            // Enhanced Security Server Redirection PDU in place of the license (MS-RDPBCGR 2.2.13.2.1): Basic Security Header
            // with SEC_REDIRECTION_PKT, the 2 bytes after it play the part of pad2Octets. Only valid in this phase.
            if (flags === redirect.SEC_REDIRECTION_PKT) {
                this.redirect(sec.rest());
                return;
            }
            if (flags === 0x80 || flags === 0x280) {
                sec.skip(2);
                licensing.accept(sec.rest());
                this.licensed = true;
                this.enter('capabilities');
                return;
            }
            // Servers may report a failure (Set Error Info) before licensing completes. Nothing else
            // may skip licensing: exactly one Share Data PDU of type Set Error Info is accepted.
            if (flags & 0x80) bad();
            const early = slow.parseShare(payload);
            if (early.length !== 1 || early[0].type !== 7 || early[0].dataType !== 0x2f) bad();
        }
        for (const p of slow.parseShare(payload)) {
            if (p.type === 1) {
                this.demand(p.body);
                continue;
            }
            if (p.type === 6) {
                const r = new Reader(p.body);
                // xrdp sends an empty body (found against xrdp); the specification has shareId and a source descriptor
                // (FreeRDP also accepts both). Anything in between is malformed.
                if (r.remaining) {
                    r.u32le();
                    r.skip(r.u16le());
                    r.expectEnd();
                }
                this.io.log('debug', 'Deactivate All received (active=' + this.active + ')');
                this.active = false;
                this.final = null;
                this.fast.close();
                this.output.reset(this.output.desktop);
                this.state = 'session';
                this.armActivation();
                continue;
            }
            if (p.type === 10) {
                this.redirect(p.body);      // Enhanced Security Server Redirection PDU (Share Control type 0xA)
                continue;
            }
            if (p.type !== 7) bad('UNSUPPORTED');
            if (this.shareId !== undefined && p.shareId !== this.shareId) bad();
            const r = new Reader(p.body);
            switch (p.dataType) {
                case 2: {
                    if (!this.active) bad();
                    yield* this.output.update(p.body);
                    break;
                }
                case 27: {
                    if (!this.active) bad();
                    yield this.output.slowPointer(p.body);
                    break;
                }
                case 31:
                    if (!this.final) bad();
                    if (r.u16le() !== 1) bad();
                    r.u16le();
                    r.expectEnd();
                    this.final.sync = true;
                    this.activate();
                    break;
                case 20: {
                    if (!this.final) bad();
                    const action = r.u16le();
                    r.u16le();
                    r.u32le();
                    r.expectEnd();
                    if (action === 2) this.final.granted = true;
                    else if (action !== 4) bad();
                    this.activate();
                    break;
                }
                case 40:
                    if (!this.final) bad();
                    r.u16le();
                    r.u16le();
                    r.u16le();
                    r.u16le();
                    r.expectEnd();
                    this.final.font = true;
                    this.activate();
                    break;
                case 47: {
                    const e = fromErrorInfo(r.u32le());
                    r.expectEnd();
                    if (!e.ignore) this.reason = e;
                    break;
                }
                case 38: {
                    const cookie = sessionInfo.parse(p.body);
                    if (cookie) {
                        if (this.arcCookie) this.arcCookie.fill(0);
                        this.arcCookie = cookie;
                    }
                    break;
                }
                case 37:
                    r.expectEnd();
                    break; // Shutdown Request Denied: retain the active session.
                case 34:
                    r.u16le();
                    r.u16le();
                    r.expectEnd();
                    break; // Server Play Sound, sound capability is disabled.
                case 0x29: // Keyboard indicators: browser lock sync is input-only.
                case 0x2d: // IME status: no browser IME UI.
                case 0x32: // ARC status: automatic reconnect is not implemented.
                case 0x36: // Status info: no UI callback.
                case 0x37: // Monitor layout: single desktop from Demand Active.
                    break;
                default: {
                    const now = Date.now();
                    if (!BENIGN_DATA.has(p.dataType) && now - this.lastUnknownLog >= 1000) {
                        this.lastUnknownLog = now;
                        this.io.log('debug', 'Ignored unknown Share Data PDU');
                    }
                    break;
                }
            }
        }
    }
    // Server Redirection: parsed safely (bounded, ASCII hosts only), checked against the target policy of rdp/protocol/redirect.js
    // and ended with a clear RDP_ERROR_SERVER_DENIED. Following a redirect (a new relay and a new connection to the same
    // device with the load balance info) is not implemented. LB_NOREDIRECT is informational.
    redirect(body) {
        let r = null;
        try {
            r = redirect.parse(body);
            const d = redirect.decide(r, { host: this.config.serverName || '' });
            this.io.log('debug', 'Server Redirection: ' + d.action + (d.reason ? ' (' + d.reason + ')' : ''));
            if (d.action === 'ignore') return;
            throw new RdpError('RDP_ERROR_SERVER_DENIED', {
                detail: d.action === 'refuse' ? redirect.DETAIL.OTHER_TARGET : redirect.DETAIL.RECONNECT_UNSUPPORTED,
                phase: this.phase,
            });
        } finally {
            if (r) redirect.wipe(r);
            body.fill(0);       // load balance info and password cookies
        }
    }
    armActivation() {
        clearTimeout(this.activationTimer);
        this.activationTimer = setTimeout(
            () => this.fail(new RdpError('RDP_ERROR_TIMEOUT', { phase: 'finalization' })),
            L.CONNECT_TIMEOUT_MS,
        );
    }
    demand(bytes) {
        if (this.active || this.final) bad();
        if (this.demandSeen) {
            const now = Date.now();
            this.reactivations = this.reactivations.filter((t) => now - t < 60000);
            if (this.reactivations.length >= 10) bad('LIMIT');
            this.reactivations.push(now);
        }
        this.enter('capabilities');
        const d = caps.parseDemand(bytes);
        this.io.log('debug', 'Demand Active ' + d.width + 'x' + d.height + ' (reactivation=' + this.demandSeen + ')');
        this.demandSeen = true;
        this.shareId = d.shareId;
        this.desktop = { width: d.width, height: d.height };
        this.server = d;
        this.output.reset(this.desktop);
        this.output.surface = caps.surfaceOffered({ ...this.config, colorDepth: d.bpp });
        this.final = { sync: false, granted: false, font: false };
        this.armActivation();
        this.sendChannel(
            this.global,
            slow.share(
                3,
                this.user,
                caps.confirm(this.shareId, this.user, { ...this.config, ...this.desktop, colorDepth: d.bpp }),
            ),
        );
        this.enter('finalization');
        this.sendData(31, new Writer().u16le(1).u16le(this.user).toBytes());
        this.sendData(20, new Writer().u16le(4).u16le(0).u32le(0).toBytes());
        this.sendData(20, new Writer().u16le(1).u16le(0).u32le(0).toBytes());
        this.sendData(39, new Writer().u16le(0).u16le(0).u16le(3).u16le(50).toBytes());
    }
    activate() {
        if (!this.final || !this.final.sync || !this.final.granted || !this.final.font || this.active) return;
        clearTimeout(this.activationTimer);
        this.active = true;
        this.io.log('debug', 'Activated ' + this.desktop.width + 'x' + this.desktop.height);
        this.enter('active');
        if (!this.everActive) {
            this.everActive = true;
            // A legacy-only peer may activate successfully without opening/confirming GFX.
            // Bound this wait independently of reactivation and give an actionable fallback.
            if (this.config.mode === 'gfx' && (!this.graphics || !this.graphics.caps)) {
                this.gfxConfirmTimer = setTimeout(() => this.fail(this.missingGfx()), L.GFX_CONFIRM_TIMEOUT_MS);
            }
            this.reportConnected();
        } else if (
            this.reportedConnect && (this.lastDesktop.width !== this.desktop.width ||
            this.lastDesktop.height !== this.desktop.height)
        ) {
            if (this.config.mode === 'gfx') this.io.desktop(this.desktop.width, this.desktop.height);
            else this.io.resized(this.desktop.width, this.desktop.height);
        }
        this.reportConnected();
        this.lastDesktop = { ...this.desktop };
        // GFX applies the request only on CapsConfirm of the new pipeline or ResetGraphics, never on activation.
        if (this.config.mode !== 'gfx') this.settled();
        if (!this.visible || this.visibilityPending) this.visibility(this.visible);
        if (this.config.mode === 'gfx') this.flushResize();
    }
    missingGfx() {
        return new RdpError('RDP_ERROR_CAPABILITIES_REJECTED', { detail: 'UNSUPPORTED', phase: 'capabilities', hint: 'use-legacy' });
    }
    reportConnected() {
        if (this.reportedConnect || !this.active) return;
        const gfxMode = this.config.mode === 'gfx';
        if (gfxMode && (!this.graphics || !this.graphics.caps)) return;
        this.reportedConnect = true;
        this.io.connected({ ...this.desktop, mode: gfxMode ? 'gfx' : 'legacy', gfx: gfxMode ? this.graphics.caps : null, tls: this.tls, nla: this.nla === true });
    }
    input(ev) {
        if (!this.active || this.closed) return;
        const input = this.server.sets.get(13);
        const flags = input && input.length >= 2 ? input[0] | (input[1] << 8) : 0;
        if (ev.k === 'unicode' && !(flags & 0x10)) return;
        if (ev.k === 'mouse' && ev.button >= 4 && !(flags & 0x04)) return;
        if (ev.k === 'wheel' && ev.horizontal && !(flags & 0x100)) return;
        if (ev.k === 'mouse' || ev.k === 'wheel')
            ev = {
                ...ev,
                x: Math.max(0, Math.min(ev.x, this.desktop.width - 1)),
                y: Math.max(0, Math.min(ev.y, this.desktop.height - 1)),
            };
        if (this.server.fastInput) this.send(fast.input(ev));
        else this.sendData(28, fast.slowInput(ev));
    }
    clipboard(text) {
        if (!this.closed) this.clipboardChannel.localText(text);
    }
    // Browser window size (rdp/WIRE.md "resize"): latest wins. Sent through Display Control when the server offers it,
    // otherwise ignored (the browser scales the image).
    resize(width, height) {
        if (this.closed || this.config.displayControl === false || this.displayDisabled) return;
        this.pendingSize = { width, height };
        this.flushResize();
    }
    flushResize() {
        const d = this.display;
        if (this.closed || !this.pendingSize || !d || !d.ready || !this.active || !this.desktop) return;
        // A timeout can release a layout request, but cannot make an unconfirmed GFX pipeline ready.
        if (this.config.mode === 'gfx' && (!this.graphics || !this.graphics.caps || this.gfxRestarted)) return;
        const now = this.now();
        this.expireResize(now);
        const want = d.fit(this.pendingSize.width, this.pendingSize.height);
        const target = this.requested || this.desktop;
        if (!want || (want.width === target.width && want.height === target.height)) {
            this.pendingSize = null;
            return;
        }
        this.layoutTimes = this.layoutTimes.filter((t) => now - t < 60000);
        const busy = this.requested ? this.layoutAt + DISP_SETTLE_MS : 0;
        const budget = this.layoutTimes.length >= DISP_MAX_PER_MINUTE ? this.layoutTimes[0] + 60000 : 0;
        const due = Math.max(this.layoutAt + DISP_MIN_INTERVAL_MS, busy, budget);
        if (due > now) {
            if (!this.layoutTimer) {
                this.layoutTimer = setTimeout(() => {
                    this.layoutTimer = null;
                    try { this.flushResize(); } catch (e) { this.fail(e); }
                }, Math.max(1, due - now));
            }
            return;
        }
        this.pendingSize = null;
        this.layoutAt = now;
        this.layoutTimes.push(now);
        this.requested = want;
        this.restartUsed = false;
        this.io.log('debug', 'Display Control layout ' + want.width + 'x' + want.height);
        d.layout(want.width, want.height);
    }
    expireResize(now = this.now()) {
        if (this.requested && now - this.layoutAt >= DISP_SETTLE_MS) this.requested = null;
    }
    // One restart per outstanding DISP request, within 3 s of sending it and only after the session connected.
    // Deactivate/Reactivate alone never grants or extends this permission.
    canRestartGraphics() {
        this.expireResize();
        if (this.closed || !this.everActive || !this.reportedConnect || !this.requested || this.restartUsed) return false;
        this.restartUsed = true;
        this.gfxRestarted = true;
        this.graphics = null;
        clearTimeout(this.gfxConfirmTimer);
        this.gfxConfirmTimer = setTimeout(() => this.fail(this.missingGfx()), L.GFX_CONFIRM_TIMEOUT_MS);
        this.io.log('debug', 'Graphics pipeline closed by the server, waiting for a new one');
        return true;
    }
    // The server applied a size (legacy activation, GFX CapsConfirm or ResetGraphics): the outstanding request is over, the next one may go.
    settled() {
        this.requested = null;
        if (this.pendingSize) this.flushResize();
    }
    visibility(visible) {
        if (this.closed) return;
        this.visible = visible;
        this.visibilityPending = !this.active;
        if (!this.active) return;
        if (this.server.suppress) {
            const w = new Writer().u8(visible ? 1 : 0).zeros(3);
            if (visible)
                w.u16le(0)
                    .u16le(0)
                    .u16le(this.desktop.width - 1)
                    .u16le(this.desktop.height - 1);
            this.sendData(35, w.toBytes());
        }
        if (visible) this.refreshRect();
    }
    // Refresh Rect makes the RDP server re-encode and send the whole screen: at most one per REFRESH_MIN_INTERVAL_MS, the latest wish is kept
    refreshRect() {
        if (this.closed || !this.active || !this.visible || !this.server.refresh) return;
        const wait = this.lastRefreshAt + REFRESH_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) {
            if (this.refreshTimer == null) this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refreshRect(); }, wait);
            return;
        }
        this.lastRefreshAt = Date.now();
        this.sendData(
            33,
            new Writer()
                .u8(1)
                .zeros(3)
                .u16le(0)
                .u16le(0)
                .u16le(this.desktop.width - 1)
                .u16le(this.desktop.height - 1)
                .toBytes(),
        );
    }
    gfxAck(ack) {
        if (this.graphics && !this.closed) {
            try { this.graphics.gfxAck(ack); } catch (e) { throw useLegacy(e); }
            this.io.log('debug', 'GFX ACK ' + ack.frameId + ' total ' + ack.totalFramesDecoded);
        }
    }
    drain() {
        this.flush();
        this.pump();
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.activationTimer);
        clearTimeout(this.gfxConfirmTimer); this.gfxConfirmTimer = null;
        clearTimeout(this.layoutTimer); this.layoutTimer = null;
        clearTimeout(this.refreshTimer); this.refreshTimer = null;
        this.abort.abort();
        this.fast.close();
        this.clipboardChannel.close();
        if (this.dynamic) this.dynamic.close();
        for (const frame of this.earlyFrames) this.io.release(frame.length);
        this.earlyFrames = []; this.earlyFrameBytes = 0;
        for (const c of this.channels.values()) c.svc.close();
        for (const job of this.jobs) {
            this.io.release(job.size);
            if (job.iterator.return) job.iterator.return();
        }
        this.jobs = [];
        this.jobBytes = 0;
        if (this.iterator && this.iterator.return) this.iterator.return();
        this.iterator = null;
        if (this.arcCookie) this.arcCookie.fill(0);
        this.arcCookie = null;
        if (this.socket) this.socket.destroy();
        this.io.transport.destroy();
    }
}
module.exports = Object.freeze({ createConnection });
