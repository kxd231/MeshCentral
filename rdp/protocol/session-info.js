/** @description Save Session Info validation; ARC cookie stays in session memory only. @license Apache-2.0 */
'use strict';
const { Reader } = require('../core/stream.js');
const { RdpError } = require('./errors.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
}
function string(r, length, max, fixed) {
    if (length < 2 || length > max || length & 1) bad();
    const b = r.bytes(fixed || length);
    if (b[length - 1] !== 0 || b[length - 2] !== 0) bad();
}
function parse(bytes) {
    const r = new Reader(bytes),
        type = r.u32le();
    let cookie = null;
    try {
        if (type === 0) {
            const d = r.u32le();
            string(r, d, 52, 52);
            const u = r.u32le();
            string(r, u, 512, 512);
            r.u32le();
        } else if (type === 1) {
            if (r.u16le() !== 1) bad();
            const size = r.u32le();
            if (size !== 18 && size !== 576) bad();
            r.u32le();
            const d = r.u32le(),
                u = r.u32le();
            r.skip(558);
            string(r, d, 52);
            string(r, u, 512);
            while (r.remaining) if (r.u8() !== 0) bad();
        } else if (type === 2) {
            r.skip(576);
        } else if (type === 3) {
            const length = r.u16le(),
                fields = r.u32le();
            if (length < 6 || length > bytes.length - 4 || fields & ~3) bad();
            if (fields & 1) {
                const n = r.u32le();
                // Register the source view before any later validation can fail. No secret copy yet.
                cookie = r.buf.subarray(r.pos, Math.min(r.pos + 28, r.end));
                if (n !== 28) bad();
                const v = r.sub(n);
                if (v.u32le() !== 28 || v.u32le() !== 1) bad();
                v.u32le();
                v.skip(16);
            }
            if (fields & 2) {
                if (r.u32le() !== 8) bad();
                r.skip(8);
            }
            r.skip(570);
        } else bad();
        r.expectEnd();
        return cookie ? new Uint8Array(cookie) : null;
    } finally {
        // Extended info owns reconnect material even when its header/fields are invalid.
        // Wipe the consumed receive view on every exit, including failures before locating ARC.
        if (type === 3) bytes.fill(0);
    }
}
module.exports = Object.freeze({ parse });
