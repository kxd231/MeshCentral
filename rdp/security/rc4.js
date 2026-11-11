/**
* @description Web-RDP RC4 stream cipher for NTLM sealing; OpenSSL 3 no longer provides RC4 by default
* @license Apache-2.0
*
* Only used inside NTLM (MS-NLMP 3.4) as the specification requires; never for transport security.
* The key schedule state is secret: call wipe() when the NTLM context ends.
*/
'use strict';

const { RdpError } = require('../protocol/errors.js');

class Rc4 {
    constructor(key) {
        if (!(key instanceof Uint8Array) || (key.length < 1) || (key.length > 256)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
        const s = new Uint8Array(256);
        for (let i = 0; i < 256; i++) { s[i] = i; }
        for (let i = 0, j = 0; i < 256; i++) {
            j = (j + s[i] + key[i % key.length]) & 0xFF;
            const t = s[i]; s[i] = s[j]; s[j] = t;
        }
        this.s = s; this.i = 0; this.j = 0;
    }
    // XOR the key stream into a new dedicated Uint8Array (the state advances)
    update(input) {
        if (!(input instanceof Uint8Array) || (this.s === null)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
        const s = this.s, out = new Uint8Array(input.length);
        let i = this.i, j = this.j;
        for (let k = 0; k < input.length; k++) {
            i = (i + 1) & 0xFF;
            j = (j + s[i]) & 0xFF;
            const t = s[i]; s[i] = s[j]; s[j] = t;
            out[k] = input[k] ^ s[(s[i] + s[j]) & 0xFF];
        }
        this.i = i; this.j = j;
        return out;
    }
    wipe() { if (this.s !== null) { this.s.fill(0); this.s = null; } this.i = 0; this.j = 0; }
}

// RC4K(key, data) of MS-NLMP: one-shot encryption with a fresh key schedule
function rc4k(key, data) { const c = new Rc4(key); try { return c.update(data); } finally { c.wipe(); } }

module.exports = Object.freeze({ Rc4: Rc4, rc4k: rc4k });
