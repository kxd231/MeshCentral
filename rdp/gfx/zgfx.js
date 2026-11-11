/**
 * @description Bounded MS-RDPEGFX 3.1.9.1 ZGFX (RDP8 bulk) decompressor.
 * @license Apache-2.0
 * Token table and ring/match approach adapted from FreeRDP 3.10.3 libfreerdp/codec/zgfx.c,
 * Apache-2.0, Copyright 2014 Marc-Andre Moreau, 2017 Armin Novak / Thincast Technologies GmbH.
 * https://github.com/FreeRDP/FreeRDP/blob/3.10.3/libfreerdp/codec/zgfx.c
 * This decoder checks every bit read, reserved token, segment and output length before writing.
 */
'use strict';
const { Reader } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('../protocol/errors.js');
const { useLegacy } = require('./errors.js');
function bad() { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID', hint: 'use-legacy' }); }
function limit() { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', hint: 'use-legacy' }); }
// [prefix width, prefix, extra bits, match?, base], MS-RDPEGFX 3.1.9.1.2.4.
const SEGMENT_MAX_BYTES = 65535 + 1000 + 1; // maximum output, worst-case segment expansion of 1000 bytes (FreeRDP libfreerdp/codec/zgfx.c header comment), flags byte
const TOKENS = [
    [1,0,8,0,0], [5,17,5,1,0], [5,18,7,1,32], [5,19,9,1,160], [5,20,10,1,672], [5,21,12,1,1696],
    [5,24,0,0,0], [5,25,0,0,1], [6,44,14,1,5792], [6,45,15,1,22176],
    [6,52,0,0,2], [6,53,0,0,3], [6,54,0,0,255], [7,92,18,1,54944], [7,93,20,1,317088],
    [7,110,0,0,4], [7,111,0,0,5], [7,112,0,0,6], [7,113,0,0,7], [7,114,0,0,8], [7,115,0,0,9],
    [7,116,0,0,10], [7,117,0,0,11], [7,118,0,0,58], [7,119,0,0,59], [7,120,0,0,60],
    [7,121,0,0,61], [7,122,0,0,62], [7,123,0,0,63], [7,124,0,0,64], [7,125,0,0,128],
    [8,188,20,1,1365664], [8,189,21,1,2414240], [8,252,0,0,12], [8,253,0,0,56], [8,254,0,0,57],
    [8,255,0,0,102], [9,380,22,1,4511392], [9,381,23,1,8705696], [9,382,24,1,17094304]
];
const TABLE = new Map(TOKENS.map(t => [t[0] * 512 + t[1], t]));
const SHORT_LITERALS = new Set(TOKENS.filter(t => !t[3] && t[0] > 1).map(t => t[4]));
class Bits {
    constructor(b) {
        if (!b.length) bad();
        const pad = b[b.length - 1]; if (pad > 7) bad();
        this.b = b; this.pos = 0; this.end = (b.length - 1) * 8 - pad;
        if (this.end < 0) bad();
    }
    read(n) {
        if (this.pos + n > this.end) bad();
        let value = 0;
        for (let i = 0; i < n; i++, this.pos++) value = value * 2 + ((this.b[this.pos >>> 3] >>> (7 - (this.pos & 7))) & 1);
        return value;
    }
    align() { this.read((8 - this.pos % 8) % 8); }
}
class Zgfx {
    constructor(io) {
        this.io = io; this.index = 0; this.valid = 0; this.closed = false;
        try { io.reserve(L.ZGFX_HISTORY_BYTES); } catch (e) { throw useLegacy(e); }
        try { this.history = new Uint8Array(L.ZGFX_HISTORY_BYTES); }
        catch (e) { io.release(L.ZGFX_HISTORY_BYTES); throw useLegacy(e); }
    }
    writeHistory(b) {
        const n = Math.min(b.length, this.history.length - this.index);
        this.history.set(b.subarray(0, n), this.index);
        if (n < b.length) this.history.set(b.subarray(n), 0);
        this.index = (this.index + b.length) % this.history.length;
        this.valid = Math.min(this.history.length, this.valid + b.length);
    }
    segment(src, out, offset) {
        if (src.length < 2 || src.length > SEGMENT_MAX_BYTES) bad();
        const flags = src[0]; if (flags !== 4 && flags !== 0x24) bad();
        const begin = offset;
        const ensure = n => { if (n > 65535 - (offset - begin) || n > out.length - offset) bad(); };
        if (flags === 4) {
            const b = src.subarray(1); ensure(b.length); out.set(b, offset); this.writeHistory(b); return b.length;
        }
        const bits = new Bits(src.subarray(1));
        while (bits.pos < bits.end) {
            let prefix = 0, t = null;
            for (let n = 1; n <= 9; n++) { prefix = prefix * 2 + bits.read(1); t = TABLE.get(n * 512 + prefix); if (t) break; }
            if (!t) bad();
            const value = t[4] + bits.read(t[2]);
            if (!t[3]) {
                if (t[0] === 1 && SHORT_LITERALS.has(value)) bad();
                ensure(1); out[offset++] = value;
                this.history[this.index] = value; this.index = (this.index + 1) % this.history.length;
                this.valid = Math.min(this.history.length, this.valid + 1);
            } else if (value === 0) {
                const n = bits.read(15); bits.align(); ensure(n);
                if (n * 8 > bits.end - bits.pos) bad();
                const b = bits.b.subarray(bits.pos >>> 3, (bits.pos >>> 3) + n);
                out.set(b, offset); this.writeHistory(b); offset += n; bits.pos += n * 8;
            } else {
                if (value > this.history.length || value > this.valid) bad();
                let count = 3;
                if (bits.read(1)) {
                    count = 4; let extra = 2;
                    while (bits.read(1)) { if (++extra > 15) bad(); count *= 2; }
                    count += bits.read(extra);
                }
                ensure(count);
                // Copy history prefix then expand overlaps in the output, doubling valid data.
                const initial = Math.min(count, value), index = (this.index + this.history.length - value) % this.history.length;
                const front = Math.min(initial, this.history.length - index);
                out.set(this.history.subarray(index, index + front), offset);
                if (front < initial) out.set(this.history.subarray(0, initial - front), offset + front);
                let done = initial;
                while (done < count) { const n = Math.min(done, count - done); out.set(out.subarray(offset, offset + n), offset + done); done += n; }
                this.writeHistory(out.subarray(offset, offset + count)); offset += count;
            }
        }
        return offset - begin;
    }
    decompress(bytes, capacity = L.GFX_PDU_MAX_BYTES) {
        try { return this.decompressMessage(bytes, capacity); } catch (e) { throw useLegacy(e); }
    }
    decompressMessage(bytes, capacity) {
        if (this.closed) bad();
        const r = new Reader(bytes), descriptor = r.u8();
        let count = 1, total = 65535;
        if (descriptor === 0xe1) { count = r.u16le(); total = r.u32le(); if (!count || !total || count > Math.floor(r.remaining / 6)) bad(); }
        else if (descriptor !== 0xe0) bad();
        if (total > L.ZGFX_MAX_OUTPUT_BYTES || total > L.GFX_PDU_MAX_BYTES) limit();
        // Single raw segment has an exact size, no need to reserve the full segment limit.
        if (descriptor === 0xe0 && r.remaining >= 1 && r.buf[r.pos] === 4) total = r.remaining - 1;
        if (descriptor === 0xe0 && total > 65535) bad();
        if (total > capacity) limit();
        this.io.reserve(total);
        let released = false;
        const release = () => { if (!released) { released = true; this.io.release(total); } };
        try {
            const out = new Uint8Array(total); let offset = 0;
            for (let i = 0; i < count; i++) {
                const size = descriptor === 0xe0 ? r.remaining : r.u32le();
                offset += this.segment(r.bytes(size), out, offset);
            }
            r.expectEnd(); if (descriptor === 0xe1 && offset !== total) bad();
            return { bytes: out.subarray(0, offset), charged: total, release };
        } catch (e) { release(); throw e; }
    }
    close() {
        if (this.closed) return; this.closed = true; this.history = null; this.io.release(L.ZGFX_HISTORY_BYTES);
    }
}
module.exports = Object.freeze({ Zgfx });
