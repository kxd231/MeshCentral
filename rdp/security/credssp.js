/**
* @description Web-RDP CredSSP client (MS-CSSP) with NTLMv2: TSRequest v6, public key binding, TSCredentials
* @license Apache-2.0
*
* Written from MS-CSSP 2.2 and 3.1.5. Decisions:
* - the client always announces version 6; the server version decides the binding method:
*   5 and higher: clientNonce + SHA-256 "CredSSP Client-To-Server Binding Hash\0" / "Server-To-Client";
*   versions above 6 are treated as 6 (MS-CSSP 2.2.1);
* - minimum server version 5 by default (Microsoft's "Mitigated" policy refuses insecure
*   fallback). Versions 2 to 4 (SubjectPublicKey itself, the server answers with its first byte + 1) only
*   with options.allowLegacyCredSSP; a refused version ends before any NTLM response is computed;
* - raw NTLM tokens in negoTokens (no SPNEGO wrapper, as FreeRDP does; Kerberos is out of scope);
* - the server's pubKeyAuth must verify (NTLM signature, sequence number and the expected value) before
*   any credential is sent; a mismatch ends the session with RDP_ERROR_SECURITY_NEGOTIATION;
* - errorCode (NTSTATUS) → fromNtStatus(); a connection closed by the server right after the
*   AUTHENTICATE message is reported as RDP_ERROR_AUTHENTICATION_FAILED (servers with version < 3 do that);
* - TSRequest decoding accepts definite BER lengths (also non-minimal) but no indefinite lengths,
*   no trailing bytes and no reordered or repeated fields; one message is at most CREDSSP_MAX_MESSAGE_BYTES.
* Secrets: the NTLM context, the client nonce and the encoded TSCredentials are wiped on success,
* failure and abort. The caller's credential arrays are NOT wiped here: they are still needed for
* Client Info (rdp/IPC.md "Credentials", the engine's wipe function owns them).
*/
'use strict';

const crypto = require('node:crypto');
const { RdpError, PHASE, fromNtStatus, hints } = require('../protocol/errors.js');
const { Reader, wipe } = require('../core/stream.js');
const ber = require('../core/ber.js');
const der = require('../core/der.js');
const limits = require('../core/limits.js');
const { NtlmClient } = require('./ntlm.js');

const CLIENT_VERSION = 6;
const MIN_SERVER_VERSION = 5;
const MIN_LEGACY_SERVER_VERSION = 2;
const NONCE_BYTES = 32;
const CRED_TYPE_PASSWORD = 1;
const MAX_MESSAGE_BYTES = limits.CREDSSP_MAX_MESSAGE_BYTES;

function ascii(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { a[i] = s.charCodeAt(i); } return a; }
const MAGIC_C2S = ascii('CredSSP Client-To-Server Binding Hash\0');
const MAGIC_S2C = ascii('CredSSP Server-To-Client Binding Hash\0');

function protocol(detail) { return new RdpError('RDP_ERROR_PROTOCOL', { detail: detail || 'INVALID', phase: PHASE.NLA }); }

function sha256() {
    const h = crypto.createHash('sha256');
    for (const p of arguments) { h.update(p); }
    const d = h.digest();
    const out = new Uint8Array(d);
    d.fill(0);
    return out;
}

// TSRequest (MS-CSSP 2.2.1) → DER. Fields: version, negoToken, authInfo, pubKeyAuth, errorCode, clientNonce
function encodeTSRequest(m) {
    const errorCode = (m.errorCode != null) ? ((m.errorCode >>> 0) | 0) : null;   // NTSTATUS as a signed 32-bit INTEGER
    return der.encode(der.seq(
        der.ctx(0, der.int(m.version)),
        m.negoToken ? der.ctx(1, der.seq(der.seq(der.ctx(0, der.octets(m.negoToken))))) : null,
        m.authInfo ? der.ctx(2, der.octets(m.authInfo)) : null,
        m.pubKeyAuth ? der.ctx(3, der.octets(m.pubKeyAuth)) : null,
        (errorCode !== null) ? der.ctx(4, der.int(errorCode)) : null,
        m.clientNonce ? der.ctx(5, der.octets(m.clientNonce)) : null
    ), MAX_MESSAGE_BYTES);
}

function explicitOctets(v) { const s = ber.readOctetString(v, false); v.expectEnd(); return s; }

// DER/BER TSRequest → { version, negoToken, authInfo, pubKeyAuth, errorCode, clientNonce } (views into bytes)
function decodeTSRequest(bytes) {
    if (!(bytes instanceof Uint8Array)) { throw protocol(); }
    if (bytes.length > MAX_MESSAGE_BYTES) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', phase: PHASE.NLA }); }
    const r = new Reader(bytes);
    const body = ber.expect(r, ber.TAG.SEQUENCE, false);
    r.expectEnd();
    const v0 = ber.expect(body, 0xA0, false);
    const out = { version: ber.readInteger(v0, false), negoToken: null, authInfo: null, pubKeyAuth: null, errorCode: null, clientNonce: null };
    v0.expectEnd();
    let last = 0;
    while (body.remaining > 0) {
        const t = ber.readTlv(body, false);
        if ((t.cls !== ber.CLASS.CONTEXT) || !t.constructed || (t.number <= last)) { throw protocol(); }
        last = t.number;
        const v = t.value;
        switch (t.number) {
            case 1: {
                // NegoData ::= SEQUENCE OF SEQUENCE { negoToken [0] OCTET STRING }: exactly one entry
                const list = ber.expect(v, ber.TAG.SEQUENCE, false); v.expectEnd();
                const item = ber.expect(list, ber.TAG.SEQUENCE, false); list.expectEnd();
                const tok = ber.expect(item, 0xA0, false); item.expectEnd();
                out.negoToken = explicitOctets(tok);
                break;
            }
            case 2: out.authInfo = explicitOctets(v); break;
            case 3: out.pubKeyAuth = explicitOctets(v); break;
            case 4: out.errorCode = ber.readInteger(v, false) >>> 0; v.expectEnd(); break;
            case 5: out.clientNonce = explicitOctets(v); break;
            default: break;   // fields of later versions are ignored (MS-CSSP 2.2.1: newer peers stay compatible)
        }
    }
    return out;
}

// Total size of the TSRequest at the start of buf, or -1 when more bytes are needed
function frameLength(buf) {
    if (buf.length < 2) { return -1; }
    if (buf[0] !== ber.TAG.SEQUENCE) { throw protocol(); }
    let header = 2, len = buf[1];
    if (len >= 0x80) {
        const n = len & 0x7F;
        if ((n === 0) || (n > 4)) { throw protocol(); }
        if (buf.length < 2 + n) { return -1; }
        len = 0;
        for (let i = 0; i < n; i++) { len = (len * 256) + buf[2 + i]; }
        header += n;
    }
    if (header + len > MAX_MESSAGE_BYTES) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', phase: PHASE.NLA }); }
    return header + len;
}

// TSCredentials with TSPasswordCreds (MS-CSSP 2.2.1.2). The result holds the password: wipe it after use.
function encodeTSCredentials(c) {
    const inner = der.encode(der.seq(der.ctx(0, der.octets(c.domain)), der.ctx(1, der.octets(c.username)), der.ctx(2, der.octets(c.password))));
    try { return der.encode(der.seq(der.ctx(0, der.int(CRED_TYPE_PASSWORD)), der.ctx(1, der.octets(inner)))); }
    finally { wipe(inner); }
}

function serverVersion(v, allowLegacy) {
    if (!Number.isInteger(v) || (v < (allowLegacy ? MIN_LEGACY_SERVER_VERSION : MIN_SERVER_VERSION))) { throw new RdpError('RDP_ERROR_SECURITY_NEGOTIATION', { detail: 'UNSUPPORTED', phase: PHASE.NLA }); }
    return Math.min(v, CLIENT_VERSION);
}

function checkErrorCode(m) { if ((m.errorCode !== null) && (m.errorCode !== 0)) { throw fromNtStatus(m.errorCode); } }

// Runs the client side of CredSSP.
// io: { read(): Promise<Uint8Array> (one complete TSRequest), write(Uint8Array) }
// options: { credentials: { domain, username, password } (UTF-16LE Uint8Array), serverPublicKey (SubjectPublicKey bytes),
//            workstation, targetName (UTF-16LE Uint8Array or null), random(n), allowLegacyCredSSP }
// Resolves { version } after TSCredentials was written. Every secret it derived is wiped when it returns or throws.
async function authenticate(io, options) {
    const spk = options.serverPublicKey;
    if (!(spk instanceof Uint8Array) || (spk.length === 0)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID', phase: PHASE.NLA }); }
    const random = options.random || function (n) { const a = new Uint8Array(n); crypto.randomFillSync(a); return a; };
    const ntlm = new NtlmClient({ credentials: options.credentials, workstation: options.workstation, targetName: options.targetName, random: options.random });
    let nonce = null, credentials = null, plain = null, expected = null, authSent = false;
    try {
        io.write(encodeTSRequest({ version: CLIENT_VERSION, negoToken: ntlm.negotiate() }));
        let m = decodeTSRequest(await io.read());
        checkErrorCode(m);
        const version = serverVersion(m.version, options.allowLegacyCredSSP === true);
        if (m.negoToken === null) { throw protocol(); }
        const auth = ntlm.authenticate(m.negoToken);
        let pubKeyAuth;
        if (version >= 5) {
            nonce = random(NONCE_BYTES);
            const h = sha256(MAGIC_C2S, nonce, spk);
            pubKeyAuth = ntlm.wrap(h);
            wipe(h);
            expected = sha256(MAGIC_S2C, nonce, spk);
        } else {
            pubKeyAuth = ntlm.wrap(spk);
            expected = new Uint8Array(spk);
            expected[0] = (expected[0] + 1) & 0xFF;
        }
        io.write(encodeTSRequest({ version: CLIENT_VERSION, negoToken: auth, pubKeyAuth: pubKeyAuth, clientNonce: nonce }));
        authSent = true;
        m = decodeTSRequest(await io.read());
        authSent = false;
        checkErrorCode(m);
        if (m.pubKeyAuth === null) { throw protocol(); }
        plain = ntlm.unwrap(m.pubKeyAuth);
        if ((plain.length !== expected.length) || !crypto.timingSafeEqual(plain, expected)) {
            throw new RdpError('RDP_ERROR_SECURITY_NEGOTIATION', { detail: 'INVALID', phase: PHASE.NLA });
        }
        credentials = encodeTSCredentials(options.credentials);
        io.write(encodeTSRequest({ version: CLIENT_VERSION, authInfo: ntlm.wrap(credentials) }));
        return { version: version };
    } catch (err) {
        // The server dropped the connection instead of answering the AUTHENTICATE message
        if (authSent && (err instanceof RdpError) && (err.code === 'RDP_ERROR_CONNECTION_LOST')) {
            throw new RdpError('RDP_ERROR_AUTHENTICATION_FAILED', { phase: PHASE.NLA, hint: hints.CHECK_CREDENTIALS });
        }
        throw err;
    } finally {
        ntlm.wipe();
        wipe(nonce, credentials, plain, expected);
    }
}

module.exports = Object.freeze({
    CLIENT_VERSION: CLIENT_VERSION, MIN_SERVER_VERSION: MIN_SERVER_VERSION, MAGIC_C2S: MAGIC_C2S, MAGIC_S2C: MAGIC_S2C,
    encodeTSRequest: encodeTSRequest, decodeTSRequest: decodeTSRequest, frameLength: frameLength,
    encodeTSCredentials: encodeTSCredentials, authenticate: authenticate
});
