/**
* @description Web-RDP NTLMv2 client (MS-NLMP) for CredSSP: messages, NTOWFv2, MIC, session keys, sign and seal
* @license Apache-2.0
*
* Written from MS-NLMP (sections 2.2, 3.1.5.1, 3.3.2, 3.4); checked against the examples of 4.2.4.
* Scope and decisions:
* - NTLMv2 only, connection-oriented, with extended session security, 128-bit keys, sign and seal;
*   a CHALLENGE without those flags is refused (no NTLMv1, no LM, no 40/56-bit keys, no anonymous).
* - NTLMSSP_NEGOTIATE_KEY_EXCH is requested; when the server grants it a random exported session key is used.
* - MIC: always sent, with MsvAvFlags bit 0x2 OR-ed into the server's flags (kept), and the
*   LmChallengeResponse is Z(24). A CHALLENGE without MsvAvTimestamp is refused: without it MS-NLMP
*   lets the client drop the MIC, which would leave the negotiated flags unprotected.
*   Windows and FreeRDP always send the timestamp. Duplicate MsvAvFlags or MsvAvTimestamp are refused.
* - Version: present in AUTHENTICATE only when NTLMSSP_NEGOTIATE_VERSION was negotiated; the MIC and
*   payload offsets follow the actual layout (MIC at 72 with Version, at 64 without).
* - Channel bindings: MsvAvChannelBindings is Z(16) ("no bindings"). CredSSP binds the NTLM session to
*   the TLS server key itself (pubKeyAuth), so a tls-server-end-point hash adds nothing here.
* - MsvAvTargetName: "TERMSRV/<serverName>" when a server name is configured, otherwise empty.
* - The client copies only the server name pairs (1-5), MsvAvTimestamp and MsvAvFlags from the CHALLENGE.
* Secrets (NT hash, NTOWFv2, session base key, exported session key, signing and sealing keys, RC4
* state) live in dedicated Uint8Arrays and are wiped by wipe(); temporaries are wiped on every path.
* Buffers handed to node:crypto (HMAC keys) are copied inside OpenSSL; we cannot wipe those copies.
*/
'use strict';

const crypto = require('node:crypto');
const { RdpError, PHASE } = require('../protocol/errors.js');
const { Reader, Writer, concat, wipe } = require('../core/stream.js');
const limits = require('../core/limits.js');
const md4 = require('./md4.js');
const { Rc4, rc4k } = require('./rc4.js');

const FLAGS = Object.freeze({
    UNICODE: 0x00000001,
    OEM: 0x00000002,
    REQUEST_TARGET: 0x00000004,
    SIGN: 0x00000010,
    SEAL: 0x00000020,
    DATAGRAM: 0x00000040,
    LM_KEY: 0x00000080,
    NTLM: 0x00000200,
    ANONYMOUS: 0x00000800,
    OEM_DOMAIN_SUPPLIED: 0x00001000,
    OEM_WORKSTATION_SUPPLIED: 0x00002000,
    ALWAYS_SIGN: 0x00008000,
    TARGET_TYPE_DOMAIN: 0x00010000,
    TARGET_TYPE_SERVER: 0x00020000,
    EXTENDED_SESSIONSECURITY: 0x00080000,
    IDENTIFY: 0x00100000,
    REQUEST_NON_NT_SESSION_KEY: 0x00400000,
    TARGET_INFO: 0x00800000,
    VERSION: 0x02000000,
    NEGOTIATE_128: 0x20000000,
    KEY_EXCH: 0x40000000,
    NEGOTIATE_56: 0x80000000
});

const CLIENT_FLAGS = (FLAGS.UNICODE | FLAGS.REQUEST_TARGET | FLAGS.SIGN | FLAGS.SEAL | FLAGS.NTLM | FLAGS.ALWAYS_SIGN |
    FLAGS.EXTENDED_SESSIONSECURITY | FLAGS.VERSION | FLAGS.NEGOTIATE_128 | FLAGS.KEY_EXCH | FLAGS.NEGOTIATE_56) >>> 0;
// The CHALLENGE must grant all of these
const REQUIRED_FLAGS = (FLAGS.UNICODE | FLAGS.SIGN | FLAGS.SEAL | FLAGS.EXTENDED_SESSIONSECURITY | FLAGS.NEGOTIATE_128) >>> 0;
// Flags that may be echoed in the AUTHENTICATE (intersection with the CHALLENGE)
const AUTH_FLAGS_MASK = (CLIENT_FLAGS | FLAGS.TARGET_INFO) >>> 0;

const AV = Object.freeze({
    EOL: 0, NB_COMPUTER_NAME: 1, NB_DOMAIN_NAME: 2, DNS_COMPUTER_NAME: 3, DNS_DOMAIN_NAME: 4, DNS_TREE_NAME: 5,
    FLAGS: 6, TIMESTAMP: 7, SINGLE_HOST: 8, TARGET_NAME: 9, CHANNEL_BINDINGS: 10
});
const AV_FLAG_MIC = 0x00000002;
const AV_COPIED = new Set([AV.NB_COMPUTER_NAME, AV.NB_DOMAIN_NAME, AV.DNS_COMPUTER_NAME, AV.DNS_DOMAIN_NAME, AV.DNS_TREE_NAME, AV.TIMESTAMP]);
const AV_UNIQUE = new Set([AV.FLAGS, AV.TIMESTAMP]);

const SIGNATURE = Uint8Array.of(0x4E, 0x54, 0x4C, 0x4D, 0x53, 0x53, 0x50, 0x00);   // "NTLMSSP\0"
// Version structure (MS-NLMP 2.2.2.10): 10.0 build 19041, NTLMSSP_REVISION_W2K3 (15)
const CLIENT_VERSION = Uint8Array.of(0x0A, 0x00, 0x61, 0x4A, 0x00, 0x00, 0x00, 0x0F);
const MAX_MESSAGE_BYTES = limits.CREDSSP_MAX_MESSAGE_BYTES;
const AUTH_FIXED_BYTES = 64;    // AUTHENTICATE fields before the optional Version

const MAGIC = Object.freeze({
    CLIENT_SIGN: ascii('session key to client-to-server signing key magic constant\0'),
    SERVER_SIGN: ascii('session key to server-to-client signing key magic constant\0'),
    CLIENT_SEAL: ascii('session key to client-to-server sealing key magic constant\0'),
    SERVER_SEAL: ascii('session key to server-to-client sealing key magic constant\0')
});

function ascii(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { a[i] = s.charCodeAt(i); } return a; }
function protocol(detail) { return new RdpError('RDP_ERROR_PROTOCOL', { detail: detail || 'INVALID', phase: PHASE.NLA }); }
function negotiation(detail) { return new RdpError('RDP_ERROR_SECURITY_NEGOTIATION', { detail: detail, phase: PHASE.NLA }); }
function internal() { return new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID', phase: PHASE.NLA }); }

function digestTo(hash, parts) {
    for (const p of parts) { hash.update(p); }
    const d = hash.digest();
    const out = new Uint8Array(d);
    d.fill(0);
    return out;
}
function hmacMd5(key) { return digestTo(crypto.createHmac('md5', key), Array.prototype.slice.call(arguments, 1)); }
function md5() { return digestTo(crypto.createHash('md5'), Array.prototype.slice.call(arguments)); }

function isUtf16(a, allowEmpty) { return (a instanceof Uint8Array) && ((a.length & 1) === 0) && (allowEmpty || (a.length > 0)) && (a.length <= (limits.CREDENTIAL_FIELD_MAX_CHARS * 2)); }

// Uppercase of a UTF-16LE string, one code unit at a time (length preserving, like RtlUpcaseUnicodeString)
function upperUtf16le(a) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i + 1 < a.length; i += 2) {
        let u = a[i] | (a[i + 1] << 8);
        if ((u < 0xD800) || (u > 0xDFFF)) {
            const up = String.fromCharCode(u).toUpperCase();
            if (up.length === 1) { u = up.charCodeAt(0); }
        }
        out[i] = u & 0xFF; out[i + 1] = u >>> 8;
    }
    return out;
}

// NTOWFv2(Passwd, User, UserDom) = HMAC_MD5(MD4(UNICODE(Passwd)), UNICODE(Uppercase(User) + UserDom))
function ntowfv2(password, username, domain) {
    const nt = md4(password);
    const user = upperUtf16le(username);
    try { return hmacMd5(nt, user, domain); } finally { wipe(nt, user); }
}

// FILETIME (100 ns since 1601-01-01) as 8 bytes little endian
function fileTime(ms) {
    let t = (BigInt(Math.floor(ms)) + 11644473600000n) * 10000n;
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) { out[i] = Number(t & 0xFFn); t >>= 8n; }
    return out;
}

// MS-NLMP 3.3.2 ComputeResponse for NTLMv2. avPairs: the AV_PAIR list the client sends (ends with MsvAvEOL).
// Returns { nt, lm, sessionBaseKey }; sessionBaseKey is secret.
function computeResponse(responseKey, serverChallenge, clientChallenge, time, avPairs, sendLm) {
    const temp = concat([Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0), time, clientChallenge, new Uint8Array(4), avPairs, new Uint8Array(4)]);
    const proof = hmacMd5(responseKey, serverChallenge, temp);
    const nt = concat([proof, temp]);
    let lm;
    if (sendLm) { const h = hmacMd5(responseKey, serverChallenge, clientChallenge); lm = concat([h, clientChallenge]); }
    else { lm = new Uint8Array(24); }
    const sessionBaseKey = hmacMd5(responseKey, proof);
    return { nt: nt, lm: lm, sessionBaseKey: sessionBaseKey };
}

function readFields(r) { return { len: r.u16le(), maxLen: r.u16le(), offset: r.u32le() }; }

function parseAvPairs(bytes) {
    const r = new Reader(bytes);
    const pairs = [];
    for (; ;) {
        const id = r.u16le(), len = r.u16le();
        const value = r.bytes(len);
        if (id === AV.EOL) { if (len !== 0) { throw protocol(); } break; }
        if ((id === AV.FLAGS) && (len !== 4)) { throw protocol(); }
        if ((id === AV.TIMESTAMP) && (len !== 8)) { throw protocol(); }
        pairs.push({ id: id, value: value });
    }
    return pairs;
}

// CHALLENGE_MESSAGE (MS-NLMP 2.2.1.2) → { flags, serverChallenge, avPairs, timestamp }
function parseChallenge(bytes) {
    if (!(bytes instanceof Uint8Array)) { throw internal(); }
    if (bytes.length > MAX_MESSAGE_BYTES) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', phase: PHASE.NLA }); }
    const r = new Reader(bytes);
    const sig = r.bytes(8);
    for (let i = 0; i < 8; i++) { if (sig[i] !== SIGNATURE[i]) { throw protocol(); } }
    if (r.u32le() !== 2) { throw protocol(); }
    const targetName = readFields(r);
    const flags = r.u32le();
    const serverChallenge = r.copy(8);
    r.skip(8);
    const targetInfo = readFields(r);
    r.at(targetName.offset, targetName.len);   // bounds check only
    if ((flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS) { throw negotiation('UNSUPPORTED'); }
    if (targetInfo.len === 0) { throw protocol(); }
    const info = r.at(targetInfo.offset, targetInfo.len).rest();
    const pairs = parseAvPairs(info);
    let timestamp = null, computer = false, domain = false;
    const unique = new Set();
    for (const p of pairs) {
        if (AV_UNIQUE.has(p.id)) { if (unique.has(p.id)) { throw protocol(); } unique.add(p.id); }
        if (p.id === AV.TIMESTAMP) { timestamp = p.value; }
        else if (p.id === AV.NB_COMPUTER_NAME) { computer = true; }
        else if (p.id === AV.NB_DOMAIN_NAME) { domain = true; }
    }
    // MS-NLMP 3.1.5.1.2: both NetBIOS names are required with integrity or confidentiality
    if (!computer || !domain) { throw protocol(); }
    // Without a timestamp the MIC would be optional (MS-NLMP 3.1.5.1.2); we always require transcript integrity
    if (timestamp === null) { throw negotiation('UNSUPPORTED'); }
    return { flags: flags >>> 0, serverChallenge: serverChallenge, avPairs: pairs, timestamp: timestamp };
}

// AV pairs sent by the client inside the NTLMv2 response. mic: OR the MIC bit into MsvAvFlags (kept in
// place when the server sent it, appended otherwise).
function clientAvPairs(serverPairs, mic, targetName) {
    const w = new Writer(256, MAX_MESSAGE_BYTES);
    let flagsWritten = false;
    for (const p of serverPairs) {
        if (p.id === AV.FLAGS) {
            const v = new Reader(p.value).u32le();
            w.u16le(AV.FLAGS).u16le(4).u32le((mic ? (v | AV_FLAG_MIC) : v) >>> 0);
            flagsWritten = true;
            continue;
        }
        if (!AV_COPIED.has(p.id)) { continue; }
        w.u16le(p.id).u16le(p.value.length).bytes(p.value);
    }
    if (mic && !flagsWritten) { w.u16le(AV.FLAGS).u16le(4).u32le(AV_FLAG_MIC); }
    w.u16le(AV.CHANNEL_BINDINGS).u16le(16).zeros(16);
    const name = targetName || new Uint8Array(0);
    w.u16le(AV.TARGET_NAME).u16le(name.length).bytes(name);
    w.u16le(AV.EOL).u16le(0);
    return w.toBytes();
}

// NEGOTIATE_MESSAGE (MS-NLMP 2.2.1.1), no domain or workstation supplied
function buildNegotiate(flags) {
    const w = new Writer(40, 40);
    w.bytes(SIGNATURE).u32le(1).u32le(flags >>> 0);
    w.u16le(0).u16le(0).u32le(40);   // DomainNameFields
    w.u16le(0).u16le(0).u32le(40);   // WorkstationFields
    w.bytes(CLIENT_VERSION);
    return w.toBytes();
}

// Offset of the MIC field in an AUTHENTICATE_MESSAGE with these flags
function micOffset(flags) { return AUTH_FIXED_BYTES + ((flags & FLAGS.VERSION) ? 8 : 0); }

// AUTHENTICATE_MESSAGE (MS-NLMP 2.2.1.3). Payload order: domain, user, workstation, LM, NT, session key.
// The Version field is present only when f.flags has NTLMSSP_NEGOTIATE_VERSION (f.version, or zeros).
// With mic the 16-byte MIC field (zero) follows; the payload starts right after the header.
function buildAuthenticate(f) {
    const payloads = [f.domain, f.user, f.workstation, f.lm, f.nt, f.encryptedKey || new Uint8Array(0)];
    let offset = micOffset(f.flags) + (f.mic ? 16 : 0);
    let size = offset;
    for (const p of payloads) { if (!(p instanceof Uint8Array) || (p.length > 0xFFFF)) { throw internal(); } size += p.length; }
    if (size > MAX_MESSAGE_BYTES) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', phase: PHASE.NLA }); }
    const w = new Writer(size, size);
    w.bytes(SIGNATURE).u32le(3);
    const order = [3, 4, 0, 1, 2, 5];   // field order in the header: LM, NT, domain, user, workstation, key
    const offsets = [];
    for (const p of payloads) { offsets.push(offset); offset += p.length; }
    for (const i of order) { w.u16le(payloads[i].length).u16le(payloads[i].length).u32le(offsets[i]); }
    w.u32le(f.flags >>> 0);
    if (f.flags & FLAGS.VERSION) { w.bytes(f.version || new Uint8Array(8)); }
    if (f.mic) { w.zeros(16); }
    for (const p of payloads) { w.bytes(p); }
    return w.toBytes();
}

function u32le(v) { return Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, v >>> 24); }

class NtlmClient {
    // options: { credentials: { domain, username, password } (UTF-16LE Uint8Array, not wiped here),
    //            workstation, targetName (UTF-16LE Uint8Array or null), random(n) (tests) }
    constructor(options) {
        const c = options && options.credentials;
        if ((c == null) || !isUtf16(c.username, false) || !isUtf16(c.domain, true) || !isUtf16(c.password, true)) {
            throw new RdpError('RDP_ERROR_NO_CREDENTIALS', { phase: PHASE.NLA });
        }
        this.credentials = c;
        this.workstation = options.workstation || new Uint8Array(0);
        this.targetName = options.targetName || null;
        this.random = options.random || function (n) { const a = new Uint8Array(n); crypto.randomFillSync(a); return a; };
        this.negotiateMessage = null;
        this.state = 'initial';
        this.keyExch = false;
        this.clientSigningKey = null; this.serverSigningKey = null;
        this.clientSeal = null; this.serverSeal = null;
        this.clientSeq = 0; this.serverSeq = 0;
    }

    negotiate() {
        if (this.state !== 'initial') { throw internal(); }
        this.negotiateMessage = buildNegotiate(CLIENT_FLAGS);
        this.state = 'negotiated';
        return this.negotiateMessage;
    }

    // CHALLENGE → AUTHENTICATE; derives the session keys
    authenticate(challengeBytes) {
        if (this.state !== 'negotiated') { throw internal(); }
        this.state = 'failed';
        const ch = parseChallenge(challengeBytes);
        const c = this.credentials;
        const mic = true;   // parseChallenge() guarantees a timestamp
        const flags = (ch.flags & AUTH_FLAGS_MASK) >>> 0;
        let responseKey = null, resp = null, exported = null, encryptedKey = null, clientChallenge = null;
        try {
            responseKey = ntowfv2(c.password, c.username, c.domain);
            clientChallenge = this.random(8);
            const pairs = clientAvPairs(ch.avPairs, mic, this.targetName);
            resp = computeResponse(responseKey, ch.serverChallenge, clientChallenge, ch.timestamp, pairs, false);
            // NTLMv2: KeyExchangeKey = SessionBaseKey
            this.keyExch = (ch.flags & FLAGS.KEY_EXCH) !== 0;
            if (this.keyExch) {
                exported = this.random(16);
                encryptedKey = rc4k(resp.sessionBaseKey, exported);
            } else {
                exported = new Uint8Array(resp.sessionBaseKey);
            }
            const msg = buildAuthenticate({
                flags: flags, domain: c.domain, user: c.username, workstation: this.workstation,
                lm: resp.lm, nt: resp.nt, encryptedKey: encryptedKey, version: CLIENT_VERSION, mic: mic
            });
            if (mic) { const m = hmacMd5(exported, this.negotiateMessage, challengeBytes, msg); msg.set(m, micOffset(flags)); }
            this.clientSigningKey = md5(exported, MAGIC.CLIENT_SIGN);
            this.serverSigningKey = md5(exported, MAGIC.SERVER_SIGN);
            const cs = md5(exported, MAGIC.CLIENT_SEAL), ss = md5(exported, MAGIC.SERVER_SEAL);
            this.clientSeal = new Rc4(cs); this.serverSeal = new Rc4(ss);
            wipe(cs, ss);
            this.state = 'authenticated';
            return msg;
        } finally {
            wipe(responseKey, exported, clientChallenge);
            if (resp !== null) { wipe(resp.sessionBaseKey); }
            this.negotiateMessage = null;
        }
    }

    // GSS_WrapEx (MS-NLMP 3.4.6 / 3.4.3 SEAL): signature (16 bytes) followed by the sealed message
    wrap(plain) {
        if (this.state !== 'authenticated') { throw internal(); }
        const seq = u32le(this.clientSeq);
        this.clientSeq = (this.clientSeq + 1) >>> 0;
        const sealed = this.clientSeal.update(plain);
        const mac = hmacMd5(this.clientSigningKey, seq, plain);
        let checksum = mac.subarray(0, 8);
        if (this.keyExch) { checksum = this.clientSeal.update(checksum); }
        const out = concat([u32le(1), checksum, seq, sealed]);
        wipe(mac);
        return out;
    }

    // GSS_UnwrapEx: verifies the signature with the expected sequence number; returns the plaintext
    unwrap(data) {
        if (this.state !== 'authenticated') { throw internal(); }
        if (!(data instanceof Uint8Array) || (data.length < 16)) { throw negotiation('INVALID'); }
        const seq = u32le(this.serverSeq);
        this.serverSeq = (this.serverSeq + 1) >>> 0;
        const plain = this.serverSeal.update(data.subarray(16));
        const mac = hmacMd5(this.serverSigningKey, seq, plain);
        let checksum = mac.subarray(0, 8);
        if (this.keyExch) { checksum = this.serverSeal.update(checksum); }
        const expected = concat([u32le(1), checksum, seq]);
        const ok = crypto.timingSafeEqual(expected, data.subarray(0, 16));
        wipe(mac);
        if (!ok) { wipe(plain); throw negotiation('INVALID'); }
        return plain;
    }

    wipe() {
        wipe(this.clientSigningKey, this.serverSigningKey);
        this.clientSigningKey = null; this.serverSigningKey = null;
        if (this.clientSeal) { this.clientSeal.wipe(); }
        if (this.serverSeal) { this.serverSeal.wipe(); }
        this.clientSeal = null; this.serverSeal = null;
        this.credentials = null;
        this.negotiateMessage = null;
        this.state = 'wiped';
    }
}

module.exports = Object.freeze({
    FLAGS: FLAGS, CLIENT_FLAGS: CLIENT_FLAGS, REQUIRED_FLAGS: REQUIRED_FLAGS, AV: AV, CLIENT_VERSION: CLIENT_VERSION,
    NtlmClient: NtlmClient,
    // building blocks, exported for the MS-NLMP vectors and tests
    ntowfv2: ntowfv2, computeResponse: computeResponse, parseChallenge: parseChallenge, parseAvPairs: parseAvPairs,
    clientAvPairs: clientAvPairs, buildNegotiate: buildNegotiate, buildAuthenticate: buildAuthenticate, micOffset: micOffset,
    upperUtf16le: upperUtf16le, fileTime: fileTime, hmacMd5: hmacMd5, md5: md5, MAGIC: MAGIC
});
