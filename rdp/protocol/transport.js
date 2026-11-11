/**
* @description Web-RDP secure transport: X.224 negotiation, TLS over an in-memory Duplex, CredSSP (NLA)
* @license Apache-2.0
*
* connect(duplex, options) runs Connection Initiation (MS-RDPBCGR 1.3.1.1) up to the point where MCS
* starts: X.224 Connection Request/Confirm in plaintext, TLS on the same byte stream
* (tls.connect({ socket: duplex }), the engine never opens a socket itself), then CredSSP with NTLMv2
* when the server selected PROTOCOL_HYBRID or PROTOCOL_HYBRID_EX, then the Early User Authorization
* Result for HYBRID_EX.
*
* Decisions:
* - TLS 1.2 minimum (Node's default), 1.3 allowed. Servers that only speak TLS 1.0/1.1 (unpatched
*   Windows 7 / 2008 R2) fail with RDP_ERROR_TLS_FAILED.
* - The certificate is not verified (RDP servers use self-signed certificates).
*   Its SHA-256 fingerprint is reported (connect.tls.fingerprint256) and, for NLA, its SubjectPublicKey
*   is bound into CredSSP, so a man in the middle cannot complete NLA without knowing the password.
*   With TLS only (PROTOCOL_SSL) nothing authenticates the server by itself: options.trust (trust on first use, rdp/trust.js)
*   pins the certificate. The comparison happens right after the TLS handshake, before CredSSP /
*   NTLM and before Client Info, so a changed certificate never receives a credential. options.trust.nlaSeen refuses a server
*   that selects TLS only, right after the X.224 Connection Confirm (before the TLS handshake).
* - options.security 'nla' (start.config.security, rdp/IPC.md) requests only HYBRID | HYBRID_EX and
*   refuses a server selecting TLS only before the TLS handshake, so no credential can reach an
*   unauthenticated endpoint. 'auto' (default) keeps TLS-only targets such as xrdp working.
* - SNI is off unless options.sni is true and serverName is a host name (not an IP address).
* - No TLS session resumption (MS-CSSP 3.1.5), no ALPN, no TLS 1.2 renegotiation (SSL_OP_NO_RENEGOTIATION).
* Timeouts: CredSSP is bounded by NLA_TIMEOUT_MS here (options.nlaTimeoutMs). The whole connection
* deadline (CONNECT_TIMEOUT_MS) belongs to the engine: it passes an AbortSignal (options.signal), and
* aborting rejects with RDP_ERROR_TIMEOUT in the current phase. On any failure the duplex and the TLS
* socket are destroyed and every NLA secret is wiped before the promise rejects.
*/
'use strict';

const tls = require('node:tls');
const crypto = require('node:crypto');
const { RdpError, PHASE, toRdpError } = require('./errors.js');
const { Reader } = require('../core/stream.js');
const ber = require('../core/ber.js');
const limits = require('../core/limits.js');
const tpkt = require('./tpkt.js');
const x224 = require('./x224.js');
const credssp = require('../security/credssp.js');

const TLS_MIN_VERSION = 'TLSv1.2';
// start.config.security (rdp/IPC.md): 'auto' accepts TLS only or CredSSP, 'nla' accepts only CredSSP
const SECURITY = Object.freeze({ AUTO: 'auto', NLA: 'nla' });
const EARLY_AUTH = Object.freeze({ SUCCESS: 0x00000000, ACCESS_DENIED: 0x00000005 });
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const READ_BUFFER_MAX_BYTES = limits.CREDSSP_MAX_MESSAGE_BYTES + limits.TPKT_MAX_BYTES;
const READ_BUFFER_INITIAL_BYTES = 4096;
const LENGTH_PREFIX_BYTES = 8;   // message length functions see at most this many leading bytes

function lost(phase) { return new RdpError('RDP_ERROR_CONNECTION_LOST', { phase: phase }); }

// Reads length-delimited messages from a stream during the handshake. Every failure (end, error,
// timeout, abort) goes through fail(), which rejects the pending read.
// Input is appended to one buffer that doubles when full (and is compacted first when that is enough),
// so the work is linear in the bytes received however the stream is fragmented; copiedBytes counts
// the bytes moved by growth and compaction (tests). The buffer never exceeds READ_BUFFER_MAX_BYTES.
class StreamReader {
    constructor(stream, phase) {
        this.stream = stream;
        this.phase = phase;
        this.store = new Uint8Array(READ_BUFFER_INITIAL_BYTES);
        this.start = 0;
        this.end = 0;
        this.copiedBytes = 0;
        this.waiter = null;
        this.error = null;
        this.onData = (chunk) => { this.push(chunk); };
        this.onEnd = () => { this.fail(lost(this.phase)); };
        this.onError = () => { this.fail(lost(this.phase)); };
        stream.on('data', this.onData);
        stream.on('end', this.onEnd);
        stream.on('close', this.onEnd);
        stream.on('error', this.onError);
    }
    get buffered() { return this.end - this.start; }
    push(chunk) {
        if (this.error !== null) { return; }
        const c = (chunk instanceof Uint8Array) ? chunk : new Uint8Array(0);
        const used = this.end - this.start;
        if (used + c.length > READ_BUFFER_MAX_BYTES) { this.fail(new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', phase: this.phase })); return; }
        if (this.end + c.length > this.store.length) {
            if ((used + c.length <= (this.store.length >>> 1)) || (this.store.length === READ_BUFFER_MAX_BYTES)) {
                this.store.copyWithin(0, this.start, this.end);
            } else {
                let size = this.store.length * 2;
                while (size < used + c.length) { size *= 2; }
                const next = new Uint8Array(Math.min(size, READ_BUFFER_MAX_BYTES));
                next.set(this.store.subarray(this.start, this.end));
                this.store.fill(0);
                this.store = next;
            }
            this.copiedBytes += used;
            this.start = 0; this.end = used;
        }
        this.store.set(c, this.end);
        this.end += c.length;
        this.check();
    }
    check() {
        const w = this.waiter;
        if ((w === null) || (this.error !== null)) { return; }
        let n;
        try { n = w.length(this.store.subarray(this.start, Math.min(this.end, this.start + LENGTH_PREFIX_BYTES))); } catch (err) { this.fail(toRdpError(err, this.phase)); return; }
        if ((n < 0) || (this.buffered < n)) { return; }
        const out = this.store.slice(this.start, this.start + n);
        this.start += n;
        if (this.start === this.end) { this.start = 0; this.end = 0; }
        this.waiter = null;
        w.resolve(out);
    }
    // length(prefix) → total length of the next message, or -1 when more bytes are needed.
    // prefix holds at most LENGTH_PREFIX_BYTES leading bytes, enough for a TPKT or DER header.
    next(length) {
        if (this.error !== null) { return Promise.reject(this.error); }
        if (this.waiter !== null) { return Promise.reject(new RdpError('RDP_ERROR_INTERNAL', { phase: this.phase })); }
        return new Promise((resolve, reject) => { this.waiter = { length: length, resolve: resolve, reject: reject }; this.check(); });
    }
    fail(err) {
        if (this.error !== null) { return; }
        this.error = err;
        const w = this.waiter;
        this.waiter = null;
        if (w !== null) { w.reject(err); }
    }
    // Stop reading; bytes already received are put back into the stream, which stays paused
    release() {
        const s = this.stream;
        s.removeListener('data', this.onData);
        s.removeListener('end', this.onEnd);
        s.removeListener('close', this.onEnd);
        s.removeListener('error', this.onError);
        s.pause();
        if ((this.error === null) && (this.buffered > 0)) { s.unshift(Buffer.from(this.store.subarray(this.start, this.end))); }
        this.store.fill(0);
        this.store = new Uint8Array(0);
        this.start = 0; this.end = 0;
        if (this.error === null) { this.error = new RdpError('RDP_ERROR_INTERNAL', { phase: this.phase }); }
    }
}

function tpktLength(buf) { return (buf.length < tpkt.TPKT_HEADER_BYTES) ? -1 : tpkt.frameLength(buf, 0); }

// SubjectPublicKey (contents of the BIT STRING in SubjectPublicKeyInfo, RFC 5280 4.1) of a DER certificate.
// Walked with the lenient BER reader: the bytes are only located, never interpreted.
function subjectPublicKey(certDer) {
    try {
        const r = new Reader(certDer);
        const cert = ber.expect(r, ber.TAG.SEQUENCE, false);
        const tbs = ber.expect(cert, ber.TAG.SEQUENCE, false);
        if ((tbs.remaining > 0) && (tbs.peekU8() === 0xA0)) { ber.readTlv(tbs, false); }   // version
        ber.expect(tbs, ber.TAG.INTEGER, false);       // serialNumber
        ber.expect(tbs, ber.TAG.SEQUENCE, false);      // signature
        ber.expect(tbs, ber.TAG.SEQUENCE, false);      // issuer
        ber.expect(tbs, ber.TAG.SEQUENCE, false);      // validity
        ber.expect(tbs, ber.TAG.SEQUENCE, false);      // subject
        const spki = ber.expect(tbs, ber.TAG.SEQUENCE, false);
        ber.expect(spki, ber.TAG.SEQUENCE, false);     // algorithm
        const key = ber.readBitString(spki, false);
        spki.expectEnd();
        if ((key.unused !== 0) || (key.bytes.length === 0)) { throw new RdpError('RDP_ERROR_PROTOCOL'); }
        return new Uint8Array(key.bytes);
    } catch (err) {
        throw new RdpError('RDP_ERROR_TLS_FAILED', { detail: 'INVALID', phase: PHASE.TLS });
    }
}

function isIpAddress(name) { return /^[0-9.]+$/.test(name) || (name.indexOf(':') >= 0); }

function utf16le(s) {
    const a = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { const u = s.charCodeAt(i); a[i * 2] = u & 0xFF; a[(i * 2) + 1] = u >>> 8; }
    return a;
}

// X.224 negotiation on the raw stream → { selectedProtocol, flags }
async function negotiate(duplex, requestedProtocols) {
    const reader = new StreamReader(duplex, PHASE.X224);
    try {
        duplex.write(x224.encodeConnectionRequest(requestedProtocols));
        const frame = await reader.next(tpktLength);
        const result = x224.parseConnectionConfirm(frame, requestedProtocols);
        // The server speaks next only after our TLS ClientHello
        if (reader.buffered !== 0) { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID', phase: PHASE.X224 }); }
        return result;
    } finally {
        reader.release();
    }
}

// TLS client over the duplex → { socket, fingerprint256, serverPublicKey, protocol, cipher }.
// cancel(fn) registers the function that aborts the handshake.
function startTls(duplex, options, cancel) {
    return new Promise((resolve, reject) => {
        const o = options || {};
        const servername = (o.sni && (typeof o.serverName == 'string') && (o.serverName.length > 0) && !isIpAddress(o.serverName)) ? o.serverName : undefined;
        let done = false;
        const socket = tls.connect({
            socket: duplex,
            servername: servername,
            minVersion: TLS_MIN_VERSION,
            // Server-initiated TLS 1.2 renegotiation is refused (TLS 1.3 has none)
            secureOptions: crypto.constants.SSL_OP_NO_RENEGOTIATION,
            rejectUnauthorized: false,
            checkServerIdentity: function () { return undefined; }
        });
        // Errors after the handshake are reported to the later owner; this keeps them from becoming uncaught.
        socket.on('error', function () { });
        function finish(err, value) {
            if (done) { return; }
            done = true;
            socket.removeListener('close', onClose);
            if (err) { socket.destroy(); reject(err); } else { resolve(value); }
        }
        function onClose() { finish(new RdpError('RDP_ERROR_TLS_FAILED', { phase: PHASE.TLS })); }
        socket.once('error', function () { finish(new RdpError('RDP_ERROR_TLS_FAILED', { phase: PHASE.TLS })); });
        socket.on('close', onClose);
        socket.once('secureConnect', function () {
            try {
                const cert = socket.getPeerCertificate(false);
                if ((cert == null) || !(cert.raw instanceof Uint8Array) || (typeof cert.fingerprint256 != 'string')) { throw new RdpError('RDP_ERROR_TLS_FAILED', { detail: 'INVALID', phase: PHASE.TLS }); }
                const cipher = socket.getCipher();
                finish(null, {
                    socket: socket,
                    fingerprint256: cert.fingerprint256,
                    serverPublicKey: subjectPublicKey(cert.raw),
                    protocol: socket.getProtocol(),
                    cipher: (cipher && cipher.name) || null
                });
            } catch (err) { finish(toRdpError(err, PHASE.TLS)); }
        });
        cancel(function (err) { finish(err); });
    });
}

// Early User Authorization Result PDU (MS-RDPBCGR 2.2.10.2)
function checkEarlyAuth(bytes) {
    const v = new Reader(bytes).u32le();
    if (v === EARLY_AUTH.SUCCESS) { return; }
    if (v === EARLY_AUTH.ACCESS_DENIED) { throw new RdpError('RDP_ERROR_ACCESS_DENIED', { phase: PHASE.NLA }); }
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: v, phase: PHASE.NLA });
}

// options: {
//   security             'auto' (default): TLS only or CredSSP; 'nla': only CredSSP is requested and accepted
//   requestedProtocols   default SSL | HYBRID | HYBRID_EX ('auto'), HYBRID | HYBRID_EX ('nla')
//   allowLegacyCredSSP   accept CredSSP servers older than version 5 (default false)
//   credentials          { domain, username, password } UTF-16LE Uint8Arrays (required when the server selects NLA; not wiped here)
//   serverName           target host name ('' allowed): SPN TERMSRV/<serverName>, SNI only with sni: true
//   sni                  default false
//   clientName           NTLM workstation name (string, default '')
//   trust                { fingerprint256: 'AA:..' | null, nlaSeen: bool } (start.config.trust): pinned certificate and "CredSSP worked before"
//   signal               AbortSignal of the engine's connection deadline
//   nlaTimeoutMs         default NLA_TIMEOUT_MS
//   onPhase(phase)       progress callback (PHASE values)
//   ntlmRandom           test hook
// }
// Resolves { socket, selectedProtocol, negotiationFlags, tls: { fingerprint256, protocol, cipher }, credssp: { version } | null }.
// socket is the TLS socket, paused, positioned at the first byte after the handshake.
async function connect(duplex, options) {
    const o = options || {};
    const security = (o.security === undefined) ? SECURITY.AUTO : o.security;
    if ((security !== SECURITY.AUTO) && (security !== SECURITY.NLA)) { duplex.destroy(); throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID', phase: PHASE.X224 }); }
    const nlaRequired = (security === SECURITY.NLA);
    const requested = (o.requestedProtocols !== undefined) ? o.requestedProtocols : (nlaRequired ? x224.NLA_REQUESTED_PROTOCOLS : x224.DEFAULT_REQUESTED_PROTOCOLS);
    if (nlaRequired && ((requested & x224.PROTOCOL.SSL) !== 0)) { duplex.destroy(); throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID', phase: PHASE.X224 }); }
    const trust = o.trust;
    if ((trust != null) && ((typeof trust != 'object') || ((trust.fingerprint256 != null) && !((typeof trust.fingerprint256 == 'string') && FINGERPRINT.test(trust.fingerprint256))))) {
        duplex.destroy(); throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID', phase: PHASE.X224 });
    }
    const pinned = (trust != null) ? (trust.fingerprint256 || null) : null;
    const nlaSeen = (trust != null) && (trust.nlaSeen === true);
    let phase = PHASE.X224, tlsSocket = null, reader = null, cancelTls = null, nlaTimer = null, failed = null;
    let rejectAbort;
    const aborted = new Promise(function (resolve, reject) { rejectAbort = reject; });
    aborted.catch(function () { });

    function stop(err) {
        if (failed !== null) { return; }
        failed = err;
        rejectAbort(err);
        if (reader !== null) { reader.fail(err); }
        if (cancelTls !== null) { cancelTls(err); }
    }
    function race(p) { p.catch(function () { }); return Promise.race([p, aborted]); }
    function enter(p) { phase = p; if (typeof o.onPhase == 'function') { o.onPhase(p); } }
    function onAbort() { stop(new RdpError('RDP_ERROR_TIMEOUT', { phase: phase })); }

    if (o.signal) {
        if (o.signal.aborted) { duplex.destroy(); throw new RdpError('RDP_ERROR_TIMEOUT', { phase: phase }); }
        o.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        enter(PHASE.X224);
        const neg = await race(negotiate(duplex, requested));
        const nla = (neg.selectedProtocol !== x224.PROTOCOL.SSL);
        // CredSSP worked against this device before: a server that now selects TLS only is a downgrade (or a rogue endpoint)
        if (nlaSeen && !nla) { throw new RdpError('RDP_ERROR_NLA_DOWNGRADE', { phase: PHASE.X224 }); }
        // parseConnectionConfirm already refuses a protocol we did not request; checked again here
        // because accepting TLS only under 'nla' would hand Client Info to an unauthenticated server.
        if (nlaRequired && !nla) { throw new RdpError('RDP_ERROR_SECURITY_NEGOTIATION', { detail: 'UNSUPPORTED', phase: PHASE.X224 }); }
        const c = o.credentials;
        if (nla && ((c == null) || !(c.username instanceof Uint8Array) || (c.username.length === 0))) {
            throw new RdpError('RDP_ERROR_NO_CREDENTIALS', { phase: PHASE.NLA });
        }

        enter(PHASE.TLS);
        const t = await race(startTls(duplex, { serverName: o.serverName, sni: o.sni }, function (fn) { cancelTls = fn; }));
        cancelTls = null;
        tlsSocket = t.socket;
        // Pinned certificate: compared before anything is written to the TLS socket (no NTLM message, no Client Info)
        if ((pinned !== null) && (t.fingerprint256 !== pinned)) {
            const mismatch = new RdpError('RDP_ERROR_CERT_CHANGED', { phase: PHASE.TLS });
            mismatch.certFingerprint = t.fingerprint256;
            throw mismatch;
        }

        let cssp = null;
        if (nla) {
            enter(PHASE.NLA);
            reader = new StreamReader(tlsSocket, PHASE.NLA);
            nlaTimer = setTimeout(function () { stop(new RdpError('RDP_ERROR_TIMEOUT', { phase: PHASE.NLA })); }, o.nlaTimeoutMs || limits.NLA_TIMEOUT_MS);
            const serverName = (typeof o.serverName == 'string') ? o.serverName : '';
            cssp = await race(credssp.authenticate({
                read: function () { return reader.next(credssp.frameLength); },
                write: function (b) { tlsSocket.write(b); }
            }, {
                credentials: c,
                serverPublicKey: t.serverPublicKey,
                workstation: utf16le((typeof o.clientName == 'string') ? o.clientName : ''),
                targetName: (serverName.length > 0) ? utf16le('TERMSRV/' + serverName) : null,
                allowLegacyCredSSP: o.allowLegacyCredSSP === true,
                random: o.ntlmRandom
            }));
            if (neg.selectedProtocol === x224.PROTOCOL.HYBRID_EX) {
                checkEarlyAuth(await race(reader.next(function () { return 4; })));
            }
            clearTimeout(nlaTimer); nlaTimer = null;
            reader.release(); reader = null;
        } else {
            tlsSocket.pause();
        }
        if (failed !== null) { throw failed; }
        return {
            socket: tlsSocket,
            selectedProtocol: neg.selectedProtocol,
            negotiationFlags: neg.flags,
            tls: { fingerprint256: t.fingerprint256, protocol: t.protocol, cipher: t.cipher },
            credssp: cssp
        };
    } catch (err) {
        const e = toRdpError(err, phase);
        stop(e);
        if (tlsSocket !== null) { tlsSocket.destroy(); }
        duplex.destroy();
        throw e;
    } finally {
        if (nlaTimer !== null) { clearTimeout(nlaTimer); }
        if (o.signal) { o.signal.removeEventListener('abort', onAbort); }
    }
}

module.exports = Object.freeze({
    TLS_MIN_VERSION: TLS_MIN_VERSION, EARLY_AUTH: EARLY_AUTH, SECURITY: SECURITY,
    connect: connect, negotiate: negotiate, startTls: startTls, subjectPublicKey: subjectPublicKey, StreamReader: StreamReader
});
