/**
 * @description Auto-Reconnect cookie (MS-RDPBCGR 2.2.4.2 ARC_SC_PRIVATE_PACKET, 2.2.4.3 ARC_CS_PRIVATE_PACKET, 5.5):
 * the client proves it knows the server's random bits with SecurityVerifier = HMAC-MD5(ArcRandomBits, ClientRandom).
 * @license Apache-2.0
 *
 * Cross-checked with FreeRDP 3.x libfreerdp/core/info.c rdp_compute_client_auto_reconnect_cookie (Apache-2.0,
 * Copyright 2011 Marc-Andre Moreau). Under Enhanced RDP Security (TLS / CredSSP, the only mode this engine speaks) there is
 * no Security Exchange PDU and the client random is 32 zero bytes (FreeRDP: it is copied only for PROTOCOL_RDP).
 * The cookie is secret material: it lives in session memory, is never logged and every holder wipes it.
 */
'use strict';
const crypto = require('node:crypto');
const { Reader, Writer } = require('../core/stream.js');
const { RdpError } = require('./errors.js');

const COOKIE_BYTES = 28;            // cbLen (4) + version (4) + logonId (4) + 16 bytes
const CLIENT_RANDOM_BYTES = 32;
const ZERO_RANDOM = new Uint8Array(CLIENT_RANDOM_BYTES);   // never written to

function bad() { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' }); }

// server: the 28-byte ARC_SC_PRIVATE_PACKET kept by session-info.js. Returns the 28-byte ARC_CS_PRIVATE_PACKET.
function clientCookie(server, clientRandom) {
    if (!(server instanceof Uint8Array) || server.length !== COOKIE_BYTES) bad();
    const r = new Reader(server);
    if (r.u32le() !== COOKIE_BYTES || r.u32le() !== 1) bad();
    const logonId = r.u32le();
    const bits = r.copy(16);
    const random = clientRandom === undefined ? ZERO_RANDOM : clientRandom;
    if (!(random instanceof Uint8Array) || random.length !== CLIENT_RANDOM_BYTES) bad();
    let verifier;
    try { verifier = crypto.createHmac('md5', bits).update(random).digest(); } finally { bits.fill(0); }
    const w = new Writer(COOKIE_BYTES, COOKIE_BYTES).u32le(COOKIE_BYTES).u32le(1).u32le(logonId).bytes(verifier);
    verifier.fill(0);
    const out = w.toBytes();
    w.wipe();
    return out;
}

module.exports = Object.freeze({ clientCookie, COOKIE_BYTES, CLIENT_RANDOM_BYTES });
