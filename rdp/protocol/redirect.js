/**
 * @description Enhanced Security Server Redirection (MS-RDPBCGR 2.2.13.1 / 2.2.13.3.1): bounded parser and the target policy.
 * @license Apache-2.0
 *
 * Field order and limits cross-checked with FreeRDP 3.x libfreerdp/core/redirection.c (Apache-2.0, Copyright 2011
 * Marc-Andre Moreau, 2023 Armin Novak / Thincast Technologies GmbH).
 *
 * The parser never logs and never builds errors from the received data; strings are accepted only as ASCII host names
 * or address literals. The cookie material (load balance info, password cookie) is returned as copies and belongs to
 * the caller, who wipes it.
 */
'use strict';
const { Reader } = require('../core/stream.js');
const { RdpError } = require('./errors.js');

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
    RECONNECT_UNSUPPORTED: 0x00000A01   // same device, the redirect would be followed, but session reconnect is not implemented
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
function host(r, max) {
    const s = ascii(r, max);
    if (!HOST.test(s) && !IPV6.test(s)) bad();
    return s;
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
        loadBalanceInfo: null, username: null, domain: null, passwordCookie: null
    };
    if (flags & LB.TARGET_NET_ADDRESS) out.targetAddress = host(r, MAX.ADDRESS);
    if (flags & LB.LOAD_BALANCE_INFO) out.loadBalanceInfo = new Uint8Array(field(r, MAX.LB_INFO));
    if (flags & LB.USERNAME) field(r, MAX.USERNAME, true);
    if (flags & LB.DOMAIN) field(r, MAX.DOMAIN, true);
    if (flags & LB.PASSWORD) {
        const b = field(r, MAX.PASSWORD);
        // A password cookie is opaque; a text password must be UTF-16 and terminated (FreeRDP)
        if (!(flags & LB.PASSWORD_IS_PK_ENCRYPTED)) {
            if (b.length & 1 || b.length < 2 || b[b.length - 1] !== 0 || b[b.length - 2] !== 0) bad();
        }
        out.passwordCookie = new Uint8Array(b);
    }
    if (flags & LB.TARGET_FQDN) out.fqdn = host(r, MAX.FQDN);
    if (flags & LB.TARGET_NETBIOS_NAME) out.netbios = host(r, MAX.NETBIOS);
    if (flags & LB.CLIENT_TSV_URL) field(r, MAX.TSV_URL);
    if (flags & LB.REDIRECTION_GUID) field(r, MAX.GUID);
    if (flags & LB.TARGET_CERTIFICATE) field(r, MAX.CERT);
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

// Zero the secret members after use
function wipe(r) {
    if (r.loadBalanceInfo) r.loadBalanceInfo.fill(0);
    if (r.passwordCookie) r.passwordCookie.fill(0);
    r.loadBalanceInfo = r.passwordCookie = null;
}

module.exports = Object.freeze({ parse, decide, wipe, LB, DETAIL, MAX, SEC_REDIRECTION_PKT });
