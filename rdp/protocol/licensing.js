/** @description TLS licensing: only the valid-client shortcut is supported. @license Apache-2.0 */
'use strict';
const { Reader } = require('../core/stream.js');
const { RdpError } = require('./errors.js');
function accept(bytes) {
    const r = new Reader(bytes),
        type = r.u8(),
        version = r.u8(),
        size = r.u16le();
    if (size !== bytes.length || (version & 15) < 2 || (version & 15) > 3) {
        throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID', phase: 'licensing' });
    }
    if (type !== 0xff) {
        throw new RdpError('RDP_ERROR_LICENSING', { detail: 'UNSUPPORTED', phase: 'licensing' });
    }
    const code = r.u32le(),
        state = r.u32le();
    r.u16le();
    const n = r.u16le();
    r.skip(n);
    r.expectEnd();
    if (code !== 7 || state !== 2) {
        throw new RdpError('RDP_ERROR_LICENSING', { detail: code, phase: 'licensing' });
    }
    return true;
}
module.exports = Object.freeze({ accept });
