/** @description Client Info PDU, credentials remain byte arrays. @license Apache-2.0 */
'use strict';
const { Writer } = require('../core/stream.js');
const { utf16 } = require('./gcc.js');
const L = require('../core/limits.js');
const { RdpError } = require('./errors.js');
const INFO_FLAGS =
    0x00000001 |
    0x00000002 |
    0x00000008 |
    0x00000010 |
    0x00000020 |
    0x00000040 |
    0x00000100 |
    0x00020000 |
    0x00010000 |
    0x00080000;
// arcCookie: optional 28-byte ARC_CS_PRIVATE_PACKET (rdp/protocol/arc.js) for an automatic reconnect
function clientInfo(config, credentials, arcCookie) {
    const fields = [
        credentials.domain,
        credentials.username,
        credentials.password,
        utf16(config.alternateShell || ''),
        utf16(config.workingDir || ''),
    ];
    for (const a of fields) {
        if (!(a instanceof Uint8Array) || a.length & 1 || a.length > L.INFO_FIELD_MAX_CHARS * 2) {
            throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'LIMIT' });
        }
    }
    const w = new Writer(1024, 4096);
    try {
        w.u16le(0x40).u16le(0).u32le(0).u32le(INFO_FLAGS);
        for (const a of fields) {
            w.u16le(a.length);
        }
        for (const a of fields) {
            w.bytes(a).u16le(0);
        }
        const address = utf16('0.0.0.0\0'),
            dir = utf16('C:\\Windows\\System32\\mstscax.dll\0');
        w.u16le(2)
            .u16le(address.length)
            .bytes(address)
            .u16le(dir.length)
            .bytes(dir)
            .zeros(172)
            .u32le(0)
            .u32le(config.perfFlags || 0);
        if (arcCookie) {
            if (!(arcCookie instanceof Uint8Array) || arcCookie.length !== 28) {
                throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
            }
            w.u16le(arcCookie.length).bytes(arcCookie);
        } else {
            w.u16le(0);                 // cbAutoReconnectCookie
        }
        w.u16le(0).u16le(0);            // reserved1, reserved2
        return w.toBytes();
    } finally {
        w.wipe();
    }
}
module.exports = Object.freeze({ clientInfo, INFO_FLAGS });
