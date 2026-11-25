/**
 * @description Enhanced Security Server Redirection (MS-RDPBCGR 2.2.13.1 / 2.2.13.3.1): bounded parser and the target policy.
 * @license Apache-2.0
 *
 * Field order and limits cross-checked with FreeRDP 3.x libfreerdp/core/redirection.c (Apache-2.0, Copyright 2011
 * Marc-Andre Moreau, 2023 Armin Novak / Thincast Technologies GmbH).
 *
 * The parser never logs and never builds errors from the received data; target names are accepted only as ASCII host
 * names or address literals. The secret material (load balance info, user name, domain, password, target certificate)
 * is returned as copies and belongs to the caller, who wipes it (wipe()). prepare() turns a parsed packet that
 * names the same device into what the second connection needs; the engine owns the rest (rdp/IPC.md "Server Redirection").
 */
'use strict';
const crypto = require('node:crypto');
const { Reader } = require('../core/stream.js');
const { RdpError } = require('./errors.js');
const limits = require('../core/limits.js');

const SEC_REDIRECTION_PKT = 0x0400;
const LB = Object.freeze({
    TARGET_NET_ADDRESS: 0x00000001, LOAD_BALANCE_INFO: 0x00000002, USERNAME: 0x00000004, DOMAIN: 0x00000008,
    PASSWORD: 0x00000010, DONTSTOREUSERNAME: 0x00000020, SMARTCARD_LOGON: 0x00000040, NOREDIRECT: 0x00000080,
    TARGET_FQDN: 0x00000100, TARGET_NETBIOS_NAME: 0x00000200, TARGET_NET_ADDRESSES: 0x00000800,
    CLIENT_TSV_URL: 0x00001000, SERVER_TSV_CAPABLE: 0x00002000, PASSWORD_IS_PK_ENCRYPTED: 0x00004000,
    REDIRECTION_GUID: 0x00008000, TARGET_CERTIFICATE: 0x00010000
});
const KNOWN_FLAGS = Object.values(LB).reduce((a, b) => a | b, 0);
// Byte limits (including the terminator) from FreeRDP; the specification gives none for most fields
const MAX = Object.freeze({ ADDRESS: 80, USERNAME: 512, DOMAIN: 52, PASSWORD: 512, FQDN: 512, NETBIOS: 32, LB_INFO: 1024, TSV_URL: 1024, GUID: 64, CERT: 16384 });
const MAX_ADDRESSES = 16;
const PACKET_MAX = 0xFFFF;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.\-_]{0,251}[A-Za-z0-9])?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;

// Detail identifiers of the RDP_ERROR_SERVER_DENIED a redirection can end in (rdp/protocol/errors.js allows any integer)
const DETAIL = Object.freeze({
    PDU: 0x0000000A,                // a Server Redirection PDU arrived (the PDU type)
    OTHER_TARGET: 0x00000A00,       // the server names a target that is not this device: refused by policy
    RECONNECT_UNSUPPORTED: 0x00000A01,  // same device, but the redirect cannot be followed (no usable credentials, encrypted password cookie, unusable routing token)
    CERT_MISMATCH: 0x00000A02,      // (RDP_ERROR_TLS_FAILED) the redirected connection presented another certificate than the one the server vouched for
    LIMIT: 0x00000A03               // more redirections in one session than REDIRECTS_MAX
});

function bad(detail = 'INVALID') { throw new RdpError('RDP_ERROR_PROTOCOL', { detail }); }

// u32 length + bytes, length bounded before the bytes are touched
function field(r, max, even) {
    const n = r.u32le();
    if (n > max || n > r.remaining) bad(n > max ? 'LIMIT' : 'TRUNCATED');
    if (even && (n & 1)) bad();
    return r.bytes(n);
}
// UTF-16LE, NUL terminated, ASCII only -> string
function ascii(r, max) {
    const b = field(r, max, true);
    if (b.length < 2 || b[b.length - 1] !== 0 || b[b.length - 2] !== 0) bad();
    let s = '';
    for (let i = 0; i < b.length - 2; i += 2) {
        if (b[i + 1] !== 0 || b[i] < 0x20 || b[i] > 0x7e) bad();
        s += String.fromCharCode(b[i]);
    }
    return s;
}
// UTF-16LE, NUL terminated -> dedicated copy without the terminator (user name, domain, text password: they stay UTF-16LE, the form the
// credentials have everywhere in the engine). Neither the terminator missing nor a NUL or control character inside is a protocol error here: the
// target decides first (a redirect to another host is reported as such), the field is then unusable and prepare() refuses to follow. A length
// outside the limits is still a protocol error (field()).
function utf16Secret(r, max, out) {
    const b = field(r, max, true);
    const v = unterminated(b);
    if (v === null) out.unusable = true;
    return v;
}
function unterminated(b) {
    if (b.length < 2 || b[b.length - 1] !== 0 || b[b.length - 2] !== 0) return null;
    for (let i = 0; i < b.length - 2; i += 2) if (b[i + 1] === 0 && b[i] < 0x20) return null;      // NUL or control character
    return new Uint8Array(b.subarray(0, b.length - 2));
}
// UTF-16LE text, optional terminator, printable ASCII only (random binary data does not pass: a code unit has a 95 in 65536 chance) -> dedicated copy, or null
function printableText(b) {
    let n = b.length;
    if (n & 1) return null;
    if (n >= 2 && b[n - 1] === 0 && b[n - 2] === 0) n -= 2;
    if (n === 0) return null;
    for (let i = 0; i < n; i += 2) { const u = b[i] | (b[i + 1] << 8); if (u < 0x20 || u > 0x7e) return null; }
    return new Uint8Array(b.subarray(0, n));
}
function host(r, max) {
    const s = ascii(r, max);
    if (!HOST.test(s) && !IPV6.test(s)) bad();
    return s;
}

// DER header check: SEQUENCE with a definite length that covers exactly the bytes given (a certificate is nothing else)
function isDerSequence(b) {
    if (b.length < 4 || b[0] !== 0x30) return false;
    let len, at;
    if (b[1] < 0x80) { len = b[1]; at = 2; }
    else {
        const n = b[1] & 0x7f;
        if (n < 1 || n > 3 || b.length < 2 + n) return false;
        len = 0;
        for (let i = 0; i < n; i++) len = (len * 256) + b[2 + i];
        at = 2 + n;
    }
    return at + len === b.length;
}

// TARGET_CERTIFICATE_CONTAINER (MS-RDPBCGR 2.2.13.1.2): elements of { ElementType u32, Encoding u32, ElementSize u32, ElementData }; the one
// that counts is the certificate (type 0x20) in DER encoding (1); other elements are skipped. The container must be consumed exactly.
const ELEMENT_CERTIFICATE = 0x20, ENCODING_DER = 1, MAX_ELEMENTS = 16;
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0; }
function fromContainer(b) {
    let found = null, at = 0;
    for (let n = 0; at < b.length; n++) {
        if (n >= MAX_ELEMENTS || b.length - at < 12) return null;
        const type = u32(b, at), enc = u32(b, at + 4), size = u32(b, at + 8);
        at += 12;
        if (size > b.length - at) return null;
        if (found === null && type === ELEMENT_CERTIFICATE && enc === ENCODING_DER && isDerSequence(b.subarray(at, at + size))) found = new Uint8Array(b.subarray(at, at + size));
        at += size;
    }
    return found;
}

// TargetCertificate (MS-RDPBCGR 2.2.13.1): the X.509 certificate of the target as the container above (GNOME Remote Desktop sends the Base64
// text of it in UTF-16LE), or as plain DER, or as the Base64 / PEM text of DER; all are accepted and the result is the DER. null when it is
// none of these: the field is then unusable (prepare() refuses to follow, a redirect to another host is still reported as such).
function certificate(b) {
    if (b.length === 0) return null;
    if (isDerSequence(b)) return new Uint8Array(b);
    let text = '';
    const wide = (b.length >= 2) && (b.length % 2 === 0) && (b[1] === 0) && (b[b.length - 1] === 0);
    const step = wide ? 2 : 1;
    let printable = true;
    for (let i = 0; i < b.length; i += step) {
        if (wide && b[i + 1] !== 0) { printable = false; break; }
        if (b[i] === 0 && i >= b.length - step) break;      // a terminator
        if (b[i] < 0x09 || b[i] > 0x7e) { printable = false; break; }
        text += String.fromCharCode(b[i]);
    }
    if (!printable) return fromContainer(b);              // binary: the container itself
    const pem = /-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----/.exec(text);
    const base64 = (pem ? pem[1] : text).replace(/[\t\r\n ]/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
    const der = new Uint8Array(Buffer.from(base64, 'base64'));
    return isDerSequence(der) ? der : fromContainer(der);
}

// body: the Share Control body after the pduSource (pad2Octets + TS_SERVER_REDIRECTION, MS-RDPBCGR 2.2.13.3.1).
// Returns a plain object; Uint8Array members are copies.
function parse(bytes) {
    const outer = new Reader(bytes);
    outer.skip(2);                                  // pad2Octets
    if (outer.remaining < 12 || outer.remaining > PACKET_MAX) bad('TRUNCATED');
    const r = outer.sub(outer.remaining);
    if (r.u16le() !== SEC_REDIRECTION_PKT) bad();
    r.u16le();                                      // length: servers disagree on what it counts; the Share Control PDU bounds the packet
    const sessionId = r.u32le();
    const flags = r.u32le();
    if (flags & ~KNOWN_FLAGS) bad('UNSUPPORTED');
    const out = {
        sessionId, flags, noRedirect: !!(flags & LB.NOREDIRECT), targetAddress: null, targetAddresses: [], fqdn: null, netbios: null,
        loadBalanceInfo: null, username: null, domain: null, passwordCookie: null, passwordText: null, passwordEncrypted: !!(flags & LB.PASSWORD_IS_PK_ENCRYPTED),
        targetCertificate: null, unusable: false      // unusable: a field the follow-up connection needs is present but cannot be used (prepare() refuses)
    };
    try {
        if (flags & LB.TARGET_NET_ADDRESS) out.targetAddress = host(r, MAX.ADDRESS);
        if (flags & LB.LOAD_BALANCE_INFO) out.loadBalanceInfo = new Uint8Array(field(r, MAX.LB_INFO));
        if (flags & LB.USERNAME) out.username = utf16Secret(r, MAX.USERNAME, out);
        if (flags & LB.DOMAIN) out.domain = utf16Secret(r, MAX.DOMAIN, out);
        if (flags & LB.PASSWORD) {
            const b = field(r, MAX.PASSWORD);
            if (!(flags & LB.PASSWORD_IS_PK_ENCRYPTED)) {
                // a text password must be UTF-16 and terminated (FreeRDP)
                out.passwordText = ((b.length & 1) === 0) ? unterminated(b) : null;
                if (out.passwordText === null) out.unusable = true;
            } else {
                // A password cookie is opaque, and a truly encrypted one cannot be used. GNOME Remote Desktop sets the flag on a one-time password that
                // is plain printable ASCII in UTF-16 (FreeRDP uses it as the password all the same): that form, and only that form, is taken as text.
                out.passwordText = printableText(b);
            }
            out.passwordCookie = new Uint8Array(b);
        }
        if (flags & LB.TARGET_FQDN) out.fqdn = host(r, MAX.FQDN);
        if (flags & LB.TARGET_NETBIOS_NAME) out.netbios = host(r, MAX.NETBIOS);
        if (flags & LB.CLIENT_TSV_URL) field(r, MAX.TSV_URL);
        if (flags & LB.REDIRECTION_GUID) field(r, MAX.GUID);
        if (flags & LB.TARGET_CERTIFICATE) {
            out.targetCertificate = certificate(field(r, MAX.CERT));
            if (out.targetCertificate === null) out.unusable = true;
        }
        if (flags & LB.TARGET_NET_ADDRESSES) {
            const total = r.u32le(), count = r.u32le();
            // TargetNetAddressesLength covers the count and the addresses (MS-RDPBCGR 2.2.13.1)
            if (count < 1 || count > MAX_ADDRESSES || total < 4 || count * 6 > total - 4 || total - 4 > r.remaining) bad(count > MAX_ADDRESSES ? 'LIMIT' : 'INVALID');
            const list = r.sub(total - 4);
            for (let i = 0; i < count; i++) out.targetAddresses.push(host(list, MAX.ADDRESS));
            list.rest();
        }
        // optional 8 bytes (and one more) of padding
        if (r.remaining >= 8) r.skip(8);
        if (r.remaining > 1) bad();
    } catch (e) { wipe(out); throw e; }
    return out;
}

function sameHost(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

// Policy. original: { host } the name the browser/agent target is known by (may be ''). The relay is bound by the agent to
// one host and port, so the only redirect that can be followed through it leads back to this device: every target the
// server names must be that device (an address literal or name equal to it, a NetBIOS name equal to its first label).
// A redirect naming anything else, or anything that cannot be compared without name resolution, is refused.
// Returns { action: 'ignore' | 'same-target' | 'refuse', reason }.
function decide(r, original) {
    if (r.noRedirect) return { action: 'ignore' };
    const own = (original && typeof original.host === 'string') ? original.host : '';
    const named = [];
    if (r.targetAddress !== null) named.push(r.targetAddress);
    for (const a of r.targetAddresses) named.push(a);
    if (r.fqdn !== null) named.push(r.fqdn);
    if (r.netbios !== null) named.push(r.netbios);
    if (!named.length) return { action: 'same-target', reason: 'no-target' };      // only load balance info: the broker wants the same endpoint again
    if (!own) return { action: 'refuse', reason: 'unknown-original' };
    // Address literals cannot supply a NetBIOS alias. Keep this pure: the engine may not import network modules.
    const firstLabel = own.includes(':') || /^\d+(?:\.\d+){3}$/.test(own) ? '' : own.split('.')[0];
    for (const n of named) {
        if (!sameHost(n, own) && !(firstLabel && r.netbios !== null && n === r.netbios && sameHost(n, firstLabel))) return { action: 'refuse', reason: 'other-target' };
    }
    return { action: 'same-target', reason: 'same-device' };
}

// SHA-256 of a DER certificate in the form of Node's getPeerCertificate().fingerprint256
function fingerprint(der) {
    const h = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
    return h.replace(/(..)(?=.)/g, '$1:');
}

// What the second connection of a followed redirect needs, from a parsed packet decide() accepted as same-target:
//   { routingToken, credentials: { domain, username, password }, certificate }
// routingToken: the load balance info without its CR LF (the X.224 Connection Request adds it), or null. credentials: UTF-16LE without
// terminator, dedicated copies the caller owns and wipes. certificate: the SHA-256 fingerprint of the certificate the server vouches for
// the target presents, or null. Returns null when the redirect cannot be followed: the server gave no user name or no password in
// text form (a public-key-encrypted password cookie is opaque to us), or the load balance info cannot be a routing token (empty after
// the terminator, longer than the Connection Request holds, with a line break inside).
function prepare(r, maxToken) {
    const max = (maxToken === undefined) ? limits.REDIRECT_TOKEN_MAX_BYTES : maxToken;
    if (r.unusable || !r.username || r.username.length === 0 || !r.passwordText || r.passwordText.length === 0) return null;
    let token = null;
    if (r.loadBalanceInfo) {
        let t = r.loadBalanceInfo;
        if (t.length >= 2 && t[t.length - 2] === 0x0D && t[t.length - 1] === 0x0A) t = t.subarray(0, t.length - 2);
        if (t.length === 0 || t.length > max) return null;
        for (let i = 0; i < t.length; i++) if (t[i] === 0x0D || t[i] === 0x0A) return null;
        token = new Uint8Array(t);
    }
    return {
        routingToken: token,
        credentials: { domain: new Uint8Array(r.domain || 0), username: new Uint8Array(r.username), password: new Uint8Array(r.passwordText) },
        certificate: r.targetCertificate ? fingerprint(r.targetCertificate) : null
    };
}

// Zero the secret members after use
function wipe(r) {
    for (const k of ['loadBalanceInfo', 'username', 'domain', 'passwordCookie', 'passwordText', 'targetCertificate']) {
        if (r[k]) r[k].fill(0);
        r[k] = null;
    }
}

module.exports = Object.freeze({ parse, decide, prepare, fingerprint, wipe, LB, DETAIL, MAX, SEC_REDIRECTION_PKT });
