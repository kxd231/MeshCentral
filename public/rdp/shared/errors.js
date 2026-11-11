/**
* @description Web-RDP error names shared by the server and the browser
* @license Apache-2.0
*
* Contract file: shared by the server and the browser; change code and documentation (rdp/WIRE.md) together.
* The server sends these names in ['rdp-error', { code, ... }] (rdp/WIRE.md). The browser maps
* them to translated text. Names never change meaning once released; add new ones instead.
* Usable from Node (require) and from a browser worker (importScripts → self.RdpShared.errors).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(); }
    else { root.RdpShared = root.RdpShared || {}; root.RdpShared.errors = factory(); }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';

    // name → short English description (logs, fallback UI text)
    const descriptions = {
        // Transport and relay
        RDP_ERROR_RELAY_FAILED: 'The relay to the agent could not be established',
        RDP_ERROR_CONNECT_FAILED: 'The agent could not connect to the RDP server',
        RDP_ERROR_CONNECTION_LOST: 'The connection to the RDP server was lost',
        RDP_ERROR_TIMEOUT: 'The RDP server did not respond in time',

        // Security negotiation
        RDP_ERROR_STANDARD_SECURITY_UNSUPPORTED: 'The RDP server only offers Standard RDP Security (RC4), which is not supported; enable TLS or NLA on the server',
        RDP_ERROR_SECURITY_NEGOTIATION: 'The RDP server rejected the security protocol',
        RDP_ERROR_TLS_FAILED: 'The TLS connection to the RDP server failed',
        RDP_ERROR_CERT_CHANGED: 'The certificate of the RDP server differs from the one trusted for this device, the session was refused before any credential was sent',
        RDP_ERROR_TRUST_RACE: 'Another session pinned a different certificate for this device at the same moment, the session was ended; credentials may already have reached the endpoint of this session, check the device and the network and try again',
        RDP_ERROR_NLA_DOWNGRADE: 'The RDP server no longer offers NLA, which it offered before, the session was refused before any credential was sent',

        // Authentication (NLA or server logon)
        RDP_ERROR_NO_CREDENTIALS: 'No credentials were provided',
        RDP_ERROR_AUTHENTICATION_FAILED: 'Authentication failed, check the username and password',
        RDP_ERROR_PASSWORD_EXPIRED: 'The password has expired',
        RDP_ERROR_PASSWORD_MUST_CHANGE: 'The password must be changed before logging on',
        RDP_ERROR_ACCOUNT_LOCKED: 'The account is locked',
        RDP_ERROR_ACCOUNT_DISABLED: 'The account is disabled or has expired',
        RDP_ERROR_ACCOUNT_RESTRICTION: 'Account restrictions prevent this logon (logon hours, workstation, ...)',
        RDP_ERROR_LOGON_TYPE_NOT_GRANTED: 'The user is not allowed to log on through Remote Desktop',
        RDP_ERROR_ACCESS_DENIED: 'Access denied by the RDP server',

        // Session setup
        RDP_ERROR_LICENSING: 'The RDP server could not issue a license',
        RDP_ERROR_CAPABILITIES_REJECTED: 'The RDP server does not support the requested graphics mode, try the GFX mode',
        RDP_ERROR_H264_REQUIRED: 'The RDP server requires H.264, which this browser cannot decode',
        RDP_ERROR_SERVER_DENIED: 'The RDP server denied the connection',
        RDP_ERROR_SERVER_DISCONNECTED: 'The RDP server ended the session',

        // Robustness
        RDP_ERROR_PROTOCOL: 'The RDP server sent invalid data',
        RDP_ERROR_RESOURCE_LIMIT: 'A resource limit was exceeded, the session was closed',
        RDP_ERROR_TOO_MANY_SESSIONS: 'Too many Web-RDP sessions are open on this server',
        RDP_ERROR_CLIENT_STALLED: 'The browser stopped processing the session, it was closed',
        RDP_ERROR_CLIENT_DECODE: 'The browser could not decode the image data',
        RDP_ERROR_CLIENT_PROTOCOL: 'The browser sent invalid data, the session was closed',
        RDP_ERROR_INTERNAL: 'Internal error in the Web-RDP engine'
    };

    const names = {};
    for (const name of Object.keys(descriptions)) { names[name] = name; }

    // Fixed hint identifiers for ['rdp-error', { hint }]; the browser maps them to translated text
    const hints = Object.freeze({
        USE_GFX: 'use-gfx',                 // capabilities rejected in legacy mode, the server needs GFX
        USE_LEGACY: 'use-legacy',           // GFX not available on the server
        ENABLE_TLS: 'enable-tls',           // the server only offers Standard RDP Security
        ENABLE_H264: 'enable-h264',         // the server needs H.264 (browser decoder missing or too slow)
        CHECK_CREDENTIALS: 'check-credentials'
    });

    return Object.freeze({
        names: Object.freeze(names),
        hints: hints,
        descriptions: Object.freeze(descriptions),
        isKnown: function (name) { return Object.prototype.hasOwnProperty.call(descriptions, name); }
    });
});
