/**
 * @description Aligned PER subset for T.125 MCS / T.124 GCC (MS-RDPBCGR 2.2.1)
 * @license Apache-2.0
 */
'use strict';
const { RdpError } = require('../protocol/errors.js');
function invalid() {
    return new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
}
function readLength(r) {
    const n = r.u8();
    return n & 0x80 ? ((n & 0x7f) << 8) | r.u8() : n;
}
function writeLength(w, n) {
    if (!Number.isInteger(n) || n < 0 || n > 32767) {
        throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
    }
    if (n < 128) {
        w.u8(n);
    } else {
        w.u16be(n | 0x8000);
    }
    return w;
}
function readInteger(r) {
    const n = readLength(r);
    if (n < 1 || n > 4) {
        throw invalid();
    }
    let v = 0;
    for (let i = 0; i < n; i++) {
        v = v * 256 + r.u8();
    }
    return v;
}
function readUint16(r, min = 0) {
    const n = r.u16be() + min;
    if (n > 65535) {
        throw invalid();
    }
    return n;
}
function writeUint16(w, n, min = 0) {
    return w.u16be(n - min);
}
function expect(r, bytes) {
    for (const n of bytes) {
        if (r.u8() !== n) {
            throw invalid();
        }
    }
}
module.exports = Object.freeze({ readLength, writeLength, readInteger, readUint16, writeUint16, expect });
