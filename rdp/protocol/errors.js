/**
* @description Web-RDP errors (server side): RdpError and mappings from protocol codes to RDP_ERROR_* names
* @license Apache-2.0
*
* Contract file: the error codes are part of the interface documented in rdp/WIRE.md; change code and documentation together.
* Names and hints are defined in public/rdp/shared/errors.js. Numeric values come from MS-RDPBCGR
* (2.2.1.2.2 RDP_NEG_FAILURE, 2.2.5.1.1 Set Error Info) and MS-ERREF (NTSTATUS, carried in
* TSRequest.errorCode, MS-CSSP 2.2.1) and are checked by the unit tests.
*
* Sanitization boundary: every field of an RdpError is validated here (fixed names, hex numbers,
* fixed hint ids). Nothing received from the RDP server, the agent or the browser, no exception
* message and no credential can reach an error, a log line or the browser through this module.
* The main process validates errors coming from the engine again with fromWire().
*/
'use strict';

const shared = require('../../public/rdp/shared/errors.js');
const E = shared.names;

// Connection phases, used in RdpError.phase, timeouts and debug logs
const PHASE = Object.freeze({
    RELAY: 'relay', X224: 'x224', TLS: 'tls', NLA: 'nla', MCS: 'mcs', SECURE_SETTINGS: 'secure-settings',
    LICENSING: 'licensing', CAPABILITIES: 'capabilities', FINALIZATION: 'finalization', ACTIVE: 'active', SESSION: 'session'
});
const PHASES = new Set(Object.values(PHASE));
const HINTS = new Set(Object.values(shared.hints));

// detail: an integer (stored as 0xXXXXXXXX) or a trusted symbolic name. Trusted names are the keys of
// the protocol tables below, the decoder error codes and the standard JavaScript error classes;
// DETAIL_NAMES is completed after the tables are defined. Any other string is dropped.
const DETAIL_HEX = /^0x[0-9A-F]{8}$/;
const DETAIL_NAMES = new Set(['TRUNCATED', 'INVALID', 'LIMIT', 'UNSUPPORTED', 'INTERNAL']);
const ERROR_CLASSES = ['Error', 'RangeError', 'TypeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError'];
for (const c of ERROR_CLASSES) { DETAIL_NAMES.add(c.toUpperCase()); }
function cleanDetail(d) {
    if ((typeof d == 'number') && Number.isInteger(d)) { return hex(d); }
    if ((typeof d == 'string') && (DETAIL_NAMES.has(d) || DETAIL_HEX.test(d))) { return d; }
    return null;
}

class RdpError extends Error {
    // code: RDP_ERROR_* name; options.detail: integer or symbolic name; options.phase: PHASE value;
    // options.hint: shared.hints value. Invalid values are dropped, an unknown code becomes RDP_ERROR_INTERNAL.
    constructor(code, options) {
        if (!shared.isKnown(code)) { code = E.RDP_ERROR_INTERNAL; }
        const o = options || {};
        const detail = cleanDetail(o.detail);
        super(code + ((detail != null) ? (' (' + detail + ')') : ''));
        this.name = 'RdpError';
        this.code = code;
        if (detail != null) { this.detail = detail; }
        if (PHASES.has(o.phase)) { this.phase = o.phase; }
        if (HINTS.has(o.hint)) { this.hint = o.hint; }
    }
    // Object sent over IPC and to the browser in ['rdp-error', ...] (rdp/WIRE.md)
    toWire() {
        const w = { code: this.code };
        if (this.detail != null) { w.detail = this.detail; }
        if (this.phase != null) { w.phase = this.phase; }
        if (this.hint != null) { w.hint = this.hint; }
        return w;
    }
    // Re-validate an error object received over IPC
    static fromWire(o) {
        if ((o == null) || (typeof o != 'object')) { return new RdpError(E.RDP_ERROR_INTERNAL); }
        return new RdpError(o.code, { detail: o.detail, phase: o.phase, hint: o.hint });
    }
}

// Any exception → RdpError. A foreign exception becomes RDP_ERROR_INTERNAL; only its class name
// (e.g. RangeError) is kept as detail, never its message or stack, because those may quote data.
function toRdpError(err, phase) {
    if (err instanceof RdpError) {
        if ((err.phase == null) && PHASES.has(phase)) { err.phase = phase; }
        return err;
    }
    let cls = null;
    if ((err != null) && (ERROR_CLASSES.indexOf(err.name) >= 0)) { cls = err.name.toUpperCase(); }
    return new RdpError(E.RDP_ERROR_INTERNAL, { phase: phase, detail: cls });
}

// RDP_NEG_FAILURE.failureCode (MS-RDPBCGR 2.2.1.2.2)
const NEG_FAILURE = Object.freeze({
    SSL_REQUIRED_BY_SERVER: 0x00000001,
    SSL_NOT_ALLOWED_BY_SERVER: 0x00000002,
    SSL_CERT_NOT_ON_SERVER: 0x00000003,
    INCONSISTENT_FLAGS: 0x00000004,
    HYBRID_REQUIRED_BY_SERVER: 0x00000005,
    SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER: 0x00000006,
    ENTRA_AUTH_REQUIRED_BY_SERVER: 0x00000007
});

function fromNegotiationFailure(failureCode) {
    failureCode = failureCode >>> 0;
    const name = nameOf(NEG_FAILURE, failureCode);
    // SSL_NOT_ALLOWED_BY_SERVER: the server only allows Standard RDP Security, which we never do.
    if (failureCode === NEG_FAILURE.SSL_NOT_ALLOWED_BY_SERVER) {
        return new RdpError(E.RDP_ERROR_STANDARD_SECURITY_UNSUPPORTED, { detail: name, phase: PHASE.X224, hint: shared.hints.ENABLE_TLS });
    }
    return new RdpError(E.RDP_ERROR_SECURITY_NEGOTIATION, { detail: name || failureCode, phase: PHASE.X224 });
}

// NTSTATUS values seen in TSRequest.errorCode (CredSSP v3+) and NTLM failures (MS-ERREF 2.3.1)
const NTSTATUS = Object.freeze({
    STATUS_ACCESS_DENIED: 0xC0000022,
    STATUS_NO_SUCH_USER: 0xC0000064,
    STATUS_WRONG_PASSWORD: 0xC000006A,
    STATUS_LOGON_FAILURE: 0xC000006D,
    STATUS_ACCOUNT_RESTRICTION: 0xC000006E,
    STATUS_INVALID_LOGON_HOURS: 0xC000006F,
    STATUS_INVALID_WORKSTATION: 0xC0000070,
    STATUS_PASSWORD_EXPIRED: 0xC0000071,
    STATUS_ACCOUNT_DISABLED: 0xC0000072,
    STATUS_LOGON_TYPE_NOT_GRANTED: 0xC000015B,
    STATUS_ACCOUNT_EXPIRED: 0xC0000193,
    STATUS_PASSWORD_MUST_CHANGE: 0xC0000224,
    STATUS_ACCOUNT_LOCKED_OUT: 0xC0000234
});

const NTSTATUS_TO_ERROR = Object.freeze({
    STATUS_ACCESS_DENIED: E.RDP_ERROR_ACCESS_DENIED,
    STATUS_NO_SUCH_USER: E.RDP_ERROR_AUTHENTICATION_FAILED,
    STATUS_WRONG_PASSWORD: E.RDP_ERROR_AUTHENTICATION_FAILED,
    STATUS_LOGON_FAILURE: E.RDP_ERROR_AUTHENTICATION_FAILED,
    STATUS_ACCOUNT_RESTRICTION: E.RDP_ERROR_ACCOUNT_RESTRICTION,
    STATUS_INVALID_LOGON_HOURS: E.RDP_ERROR_ACCOUNT_RESTRICTION,
    STATUS_INVALID_WORKSTATION: E.RDP_ERROR_ACCOUNT_RESTRICTION,
    STATUS_PASSWORD_EXPIRED: E.RDP_ERROR_PASSWORD_EXPIRED,
    STATUS_ACCOUNT_DISABLED: E.RDP_ERROR_ACCOUNT_DISABLED,
    STATUS_LOGON_TYPE_NOT_GRANTED: E.RDP_ERROR_LOGON_TYPE_NOT_GRANTED,
    STATUS_ACCOUNT_EXPIRED: E.RDP_ERROR_ACCOUNT_DISABLED,
    STATUS_PASSWORD_MUST_CHANGE: E.RDP_ERROR_PASSWORD_MUST_CHANGE,
    STATUS_ACCOUNT_LOCKED_OUT: E.RDP_ERROR_ACCOUNT_LOCKED
});

// Unknown NTSTATUS during NLA is still an authentication failure, with the value as detail.
function fromNtStatus(status) {
    status = status >>> 0;
    const name = nameOf(NTSTATUS, status);
    const code = (name != null) ? NTSTATUS_TO_ERROR[name] : E.RDP_ERROR_AUTHENTICATION_FAILED;
    const hint = (code === E.RDP_ERROR_AUTHENTICATION_FAILED) ? shared.hints.CHECK_CREDENTIALS : undefined;
    return new RdpError(code, { detail: name || status, phase: PHASE.NLA, hint: hint });
}

// Set Error Info PDU errorInfo (MS-RDPBCGR 2.2.5.1.1), the values we name explicitly
const ERRINFO = Object.freeze({
    ERRINFO_NONE: 0x00000000,
    ERRINFO_RPC_INITIATED_DISCONNECT: 0x00000001,
    ERRINFO_RPC_INITIATED_LOGOFF: 0x00000002,
    ERRINFO_IDLE_TIMEOUT: 0x00000003,
    ERRINFO_LOGON_TIMEOUT: 0x00000004,
    ERRINFO_DISCONNECTED_BY_OTHERCONNECTION: 0x00000005,
    ERRINFO_OUT_OF_MEMORY: 0x00000006,
    ERRINFO_SERVER_DENIED_CONNECTION: 0x00000007,
    ERRINFO_SERVER_INSUFFICIENT_PRIVILEGES: 0x00000009,
    ERRINFO_SERVER_FRESH_CREDENTIALS_REQUIRED: 0x0000000A,
    ERRINFO_RPC_INITIATED_DISCONNECT_BYUSER: 0x0000000B,
    ERRINFO_LOGOFF_BY_USER: 0x0000000C,
    ERRINFO_LICENSE_INTERNAL: 0x00000100,
    ERRINFO_LICENSE_NO_LICENSE_SERVER: 0x00000101,
    ERRINFO_LICENSE_NO_LICENSE: 0x00000102,
    ERRINFO_LICENSE_BAD_CLIENT_MSG: 0x00000103,
    ERRINFO_LICENSE_HWID_DOESNT_MATCH_LICENSE: 0x00000104,
    ERRINFO_LICENSE_BAD_CLIENT_LICENSE: 0x00000105,
    ERRINFO_LICENSE_CANT_FINISH_PROTOCOL: 0x00000106,
    ERRINFO_LICENSE_CLIENT_ENDED_PROTOCOL: 0x00000107,
    ERRINFO_LICENSE_BAD_CLIENT_ENCRYPTION: 0x00000108,
    ERRINFO_LICENSE_CANT_UPGRADE_LICENSE: 0x00000109,
    ERRINFO_LICENSE_NO_REMOTE_CONNECTIONS: 0x0000010A,
    ERRINFO_GRAPHICS_MODE_NOT_SUPPORTED: 0x0000112D     // the server cannot use the graphics mode the client offered
});

// errorInfo → one of
//   { ignore: true }                  ERRINFO_NONE: no reason, keep any earlier reason (spec: ignore)
//   { clean: true, detail }           normal end (logoff, disconnect by the user): browser gets ['rdp-close']
//   { clean: false, error: RdpError } browser gets ['rdp-error', ...]
// Set Error Info only records the reason; the caller applies it when the connection closes.
function fromErrorInfo(errorInfo) {
    errorInfo = errorInfo >>> 0;
    const name = nameOf(ERRINFO, errorInfo);
    const detail = name || errorInfo;
    switch (errorInfo) {
        case ERRINFO.ERRINFO_NONE:
            return { ignore: true };
        case ERRINFO.ERRINFO_RPC_INITIATED_LOGOFF:
        case ERRINFO.ERRINFO_RPC_INITIATED_DISCONNECT_BYUSER:
        case ERRINFO.ERRINFO_LOGOFF_BY_USER:
            return { clean: true, detail: name };
        case ERRINFO.ERRINFO_SERVER_DENIED_CONNECTION:
        case ERRINFO.ERRINFO_SERVER_FRESH_CREDENTIALS_REQUIRED:
            return { clean: false, error: new RdpError(E.RDP_ERROR_SERVER_DENIED, { detail: detail }) };
        case ERRINFO.ERRINFO_SERVER_INSUFFICIENT_PRIVILEGES:
            return { clean: false, error: new RdpError(E.RDP_ERROR_ACCESS_DENIED, { detail: detail }) };
        case ERRINFO.ERRINFO_GRAPHICS_MODE_NOT_SUPPORTED:
            return { clean: false, error: new RdpError(E.RDP_ERROR_CAPABILITIES_REJECTED, { detail: detail, hint: shared.hints.USE_GFX }) };
    }
    if ((errorInfo >= 0x100) && (errorInfo <= 0x10A)) { return { clean: false, error: new RdpError(E.RDP_ERROR_LICENSING, { detail: detail, phase: PHASE.LICENSING }) }; }
    // Every other value: the server ended the session; the numeric value is kept as detail.
    // No range is classified as "our protocol error": that range also holds server-side failures.
    return { clean: false, error: new RdpError(E.RDP_ERROR_SERVER_DISCONNECTED, { detail: detail }) };
}

for (const table of [NEG_FAILURE, NTSTATUS, ERRINFO]) { for (const k of Object.keys(table)) { DETAIL_NAMES.add(k); } }

function nameOf(table, value) { for (const k of Object.keys(table)) { if (table[k] === value) { return k; } } return null; }
function hex(v) { return '0x' + ((v >>> 0).toString(16).toUpperCase().padStart(8, '0')); }

module.exports = Object.freeze({
    names: E,
    hints: shared.hints,
    descriptions: shared.descriptions,
    isKnown: shared.isKnown,
    PHASE: PHASE,
    RdpError: RdpError,
    toRdpError: toRdpError,
    NEG_FAILURE: NEG_FAILURE,
    fromNegotiationFailure: fromNegotiationFailure,
    NTSTATUS: NTSTATUS,
    fromNtStatus: fromNtStatus,
    ERRINFO: ERRINFO,
    fromErrorInfo: fromErrorInfo
});
