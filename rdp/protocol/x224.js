/**
* @description Web-RDP X.224 (ISO 8073 class 0) connection setup and data TPDUs with RDP security negotiation
* @license Apache-2.0
*
* MS-RDPBCGR 2.2.1.1 / 2.2.1.2. Decisions:
* - requestedProtocols = PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX by default, HYBRID | HYBRID_EX
*   when NLA is required (transport security 'nla'): a server answer outside the request is refused. HYBRID_EX adds
*   the 4-byte Early User Authorization Result after CredSSP, so a user without logon rights gets a clear
*   RDP_ERROR_ACCESS_DENIED instead of a later disconnect (mstsc requests it as well);
* - no routing token and no "Cookie: mstshash=<user>" (it would send the user name before TLS);
* - a Connection Confirm without RDP_NEG_RSP (pre-RDP 5.2 server) or with PROTOCOL_RDP selected means
*   Standard RDP Security, which is never used: RDP_ERROR_STANDARD_SECURITY_UNSUPPORTED (hint enable-tls);
* - RDP_NEG_FAILURE → fromNegotiationFailure(); a protocol we did not request (RDSTLS, RDS-AAD, ...) is refused.
*/
'use strict';

const { RdpError, PHASE, fromNegotiationFailure, toRdpError, hints } = require('./errors.js');
const { Reader } = require('../core/stream.js');
const tpkt = require('./tpkt.js');
const limits = require('../core/limits.js');

const PROTOCOL = Object.freeze({ RDP: 0x00000000, SSL: 0x00000001, HYBRID: 0x00000002, RDSTLS: 0x00000004, HYBRID_EX: 0x00000008, RDSAAD: 0x00000010 });
const DEFAULT_REQUESTED_PROTOCOLS = PROTOCOL.SSL | PROTOCOL.HYBRID | PROTOCOL.HYBRID_EX;
const NLA_REQUESTED_PROTOCOLS = PROTOCOL.HYBRID | PROTOCOL.HYBRID_EX;
const SUPPORTED_PROTOCOLS = [PROTOCOL.SSL, PROTOCOL.HYBRID, PROTOCOL.HYBRID_EX];
const TPDU = Object.freeze({ CR: 0xE0, CC: 0xD0, DR: 0x80, DT: 0xF0 });
const NEG_TYPE = Object.freeze({ REQ: 0x01, RSP: 0x02, FAILURE: 0x03 });
// RDP_NEG_RSP flags (MS-RDPBCGR 2.2.1.2.1)
const NEG_RSP_FLAGS = Object.freeze({ EXTENDED_CLIENT_DATA_SUPPORTED: 0x01, DYNVC_GFX_PROTOCOL_SUPPORTED: 0x02, RESTRICTED_ADMIN_MODE_SUPPORTED: 0x08, REDIRECTED_AUTHENTICATION_MODE_SUPPORTED: 0x10 });
const DATA_HEADER = Uint8Array.of(0x02, TPDU.DT, 0x80);   // LI = 2, DT, EOT
const DATA_MAX_BYTES = limits.TPKT_MAX_BYTES - tpkt.TPKT_HEADER_BYTES - DATA_HEADER.length;   // 65528

function protocol(detail) { return new RdpError('RDP_ERROR_PROTOCOL', { detail: detail || 'INVALID', phase: PHASE.X224 }); }
function standardSecurity() { return new RdpError('RDP_ERROR_STANDARD_SECURITY_UNSUPPORTED', { phase: PHASE.X224, hint: hints.ENABLE_TLS }); }

// Any non-empty subset of SSL | HYBRID | HYBRID_EX (HYBRID_EX only together with HYBRID). Without SSL the
// server cannot select TLS only: used by security 'nla'.
function checkRequested(p) {
    if (!Number.isInteger(p) || (p <= 0) || ((p & ~DEFAULT_REQUESTED_PROTOCOLS) !== 0) || (((p & PROTOCOL.HYBRID_EX) !== 0) && ((p & PROTOCOL.HYBRID) === 0))) {
        throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID', phase: PHASE.X224 });
    }
}

// X.224 Connection Request with RDP_NEG_REQ → TPKT frame
function encodeConnectionRequest(requestedProtocols) {
    const p = (requestedProtocols === undefined) ? DEFAULT_REQUESTED_PROTOCOLS : requestedProtocols;
    checkRequested(p);
    return tpkt.encode(Uint8Array.of(
        14, TPDU.CR, 0, 0, 0, 0, 0,                                     // LI, CR CDT, DST-REF, SRC-REF, class 0
        NEG_TYPE.REQ, 0x00, 0x08, 0x00, p & 0xFF, (p >>> 8) & 0xFF, (p >>> 16) & 0xFF, p >>> 24
    ));
}

// X.224 Connection Confirm (complete TPKT frame) → { selectedProtocol, flags }; throws RdpError
function parseConnectionConfirm(frame, requestedProtocols) {
    const requested = (requestedProtocols === undefined) ? DEFAULT_REQUESTED_PROTOCOLS : requestedProtocols;
    try {
        const r = new Reader(tpkt.decode(frame));
        const li = r.u8();
        if ((li < 6) || (li !== r.remaining)) { throw protocol(); }
        if ((r.u8() & 0xF0) !== TPDU.CC) { throw protocol(); }
        r.skip(5);                                                      // DST-REF, SRC-REF, class option
        if (r.remaining === 0) { throw standardSecurity(); }           // no RDP_NEG_RSP: legacy server
        if (r.remaining !== 8) { throw protocol(); }
        const type = r.u8(), flags = r.u8(), length = r.u16le(), value = r.u32le();
        if (length !== 8) { throw protocol(); }
        if (type === NEG_TYPE.FAILURE) { throw fromNegotiationFailure(value); }
        if (type !== NEG_TYPE.RSP) { throw protocol(); }
        if (value === PROTOCOL.RDP) { throw standardSecurity(); }
        if ((SUPPORTED_PROTOCOLS.indexOf(value) < 0) || ((value & requested) === 0)) {
            throw new RdpError('RDP_ERROR_SECURITY_NEGOTIATION', { detail: 'UNSUPPORTED', phase: PHASE.X224 });
        }
        return { selectedProtocol: value, flags: flags };
    } catch (err) {
        throw toRdpError(err, PHASE.X224);
    }
}

// Data TPDU: user data → TPKT frame
function encodeData(payload) {
    if (!(payload instanceof Uint8Array)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
    // Checked before allocating: TPKT header (4) + data TPDU header (3) + payload <= TPKT_MAX_BYTES
    if (payload.length > DATA_MAX_BYTES) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
    const p = new Uint8Array(DATA_HEADER.length + payload.length);
    p.set(DATA_HEADER); p.set(payload, DATA_HEADER.length);
    // Client Info can contain credentials. Only the returned frame may outlive this call.
    try { return tpkt.encode(p); } finally { p.fill(0); }
}

// TPKT payload of a slow-path frame → user data (view). A Disconnect Request ends the session.
function decodeData(payload) {
    if (!(payload instanceof Uint8Array) || (payload.length < 2)) { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'TRUNCATED' }); }
    const li = payload[0], code = payload[1] & 0xF0;
    if (code === TPDU.DR) { throw new RdpError('RDP_ERROR_SERVER_DISCONNECTED'); }
    if ((code !== TPDU.DT) || (li !== 2) || (payload.length < 3)) { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' }); }
    if ((payload[2] & 0x80) === 0) { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'UNSUPPORTED' }); }   // segmented TPDUs are not used by RDP
    return payload.subarray(3);
}

module.exports = Object.freeze({
    PROTOCOL: PROTOCOL, DEFAULT_REQUESTED_PROTOCOLS: DEFAULT_REQUESTED_PROTOCOLS, NLA_REQUESTED_PROTOCOLS: NLA_REQUESTED_PROTOCOLS, DATA_MAX_BYTES: DATA_MAX_BYTES, TPDU: TPDU, NEG_TYPE: NEG_TYPE, NEG_RSP_FLAGS: NEG_RSP_FLAGS,
    encodeConnectionRequest: encodeConnectionRequest, parseConnectionConfirm: parseConnectionConfirm,
    encodeData: encodeData, decodeData: decodeData
});
