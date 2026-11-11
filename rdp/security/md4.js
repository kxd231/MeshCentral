/**
* @description Web-RDP MD4 (RFC 1320) for NTOWFv2; OpenSSL 3 no longer provides MD4 by default
* @license Apache-2.0
*
* Written from the RFC. The input is usually a password: the padded copy and the message schedule
* are wiped before returning and the digest is written straight into the returned array. The state
* words live in JS numbers (registers, JIT spill slots) that cannot be wiped, so this is best effort,
* not an absolute erasure guarantee. Only used for the NT hash, never as a general purpose hash.
*/
'use strict';

const { RdpError } = require('../protocol/errors.js');

function rotl(x, s) { return (x << s) | (x >>> (32 - s)); }

const R2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
const R3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const S1 = [3, 7, 11, 19], S2 = [3, 5, 9, 13], S3 = [3, 9, 11, 15];

function putWord(out, o, v) { out[o] = v & 0xFF; out[o + 1] = (v >>> 8) & 0xFF; out[o + 2] = (v >>> 16) & 0xFF; out[o + 3] = (v >>> 24) & 0xFF; }

// Returns a dedicated 16-byte Uint8Array
function md4(input) {
    if (!(input instanceof Uint8Array) || (input.length > 0x0FFFFFFF)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
    const bitLen = input.length * 8;
    const total = (((input.length + 8) >>> 6) + 1) * 64;
    const m = new Uint8Array(total);
    m.set(input);
    m[input.length] = 0x80;
    m[total - 8] = bitLen & 0xFF; m[total - 7] = (bitLen >>> 8) & 0xFF; m[total - 6] = (bitLen >>> 16) & 0xFF; m[total - 5] = (bitLen >>> 24) & 0xFF;
    m[total - 4] = Math.floor(bitLen / 0x100000000) & 0xFF;
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const x = new Int32Array(16);
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) { const p = off + (i * 4); x[i] = m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24); }
        const aa = a, bb = b, cc = c, dd = d;
        for (let i = 0; i < 16; i++) {
            const t = (a + ((b & c) | (~b & d)) + x[i]) | 0;
            a = d; d = c; c = b; b = rotl(t, S1[i & 3]);
        }
        for (let i = 0; i < 16; i++) {
            const t = (a + ((b & c) | (b & d) | (c & d)) + x[R2[i]] + 0x5A827999) | 0;
            a = d; d = c; c = b; b = rotl(t, S2[i & 3]);
        }
        for (let i = 0; i < 16; i++) {
            const t = (a + (b ^ c ^ d) + x[R3[i]] + 0x6ED9EBA1) | 0;
            a = d; d = c; c = b; b = rotl(t, S3[i & 3]);
        }
        a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
    }
    m.fill(0); x.fill(0);
    // Written word by word: no intermediate array holds the digest
    const out = new Uint8Array(16);
    putWord(out, 0, a); putWord(out, 4, b); putWord(out, 8, c); putWord(out, 12, d);
    return out;
}

module.exports = md4;
