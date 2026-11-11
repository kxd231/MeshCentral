/**
* @description Web-RDP bounds-checked binary reader and writer
* @license Apache-2.0
*
* Every read checks the remaining length first and throws RdpError('RDP_ERROR_PROTOCOL', TRUNCATED)
* instead of reading past the end. bytes() and sub() return views without copying; copy() returns a
* dedicated Uint8Array. The Writer grows up to a fixed maximum and wipes every buffer it abandons,
* so it can hold secrets (call wipe() when done).
*/
'use strict';

const { RdpError } = require('../protocol/errors.js');

function truncated() { return new RdpError('RDP_ERROR_PROTOCOL', { detail: 'TRUNCATED' }); }
function invalid() { return new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' }); }
function internal() { return new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }

class Reader {
    // buf: Uint8Array. The reader covers buf[start, end).
    constructor(buf, start, end) {
        if (!(buf instanceof Uint8Array)) { throw internal(); }
        if (start === undefined) { start = 0; }
        if (end === undefined) { end = buf.length; }
        if (!Number.isInteger(start) || !Number.isInteger(end) || (start < 0) || (end < start) || (end > buf.length)) { throw internal(); }
        this.buf = buf;
        this.start = start;
        this.pos = start;
        this.end = end;
    }
    get offset() { return this.pos - this.start; }      // bytes consumed
    get length() { return this.end - this.start; }      // total bytes covered
    get remaining() { return this.end - this.pos; }
    need(n) { if (!Number.isInteger(n) || (n < 0) || (n > (this.end - this.pos))) { throw truncated(); } }
    u8() { this.need(1); return this.buf[this.pos++]; }
    peekU8() { this.need(1); return this.buf[this.pos]; }
    u16le() { this.need(2); const b = this.buf, p = this.pos; this.pos += 2; return b[p] | (b[p + 1] << 8); }
    u16be() { this.need(2); const b = this.buf, p = this.pos; this.pos += 2; return (b[p] << 8) | b[p + 1]; }
    u32le() { this.need(4); const b = this.buf, p = this.pos; this.pos += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
    u32be() { this.need(4); const b = this.buf, p = this.pos; this.pos += 4; return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
    skip(n) { this.need(n); this.pos += n; }
    // View of the next n bytes (no copy; valid as long as the underlying buffer is)
    bytes(n) { this.need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    // Dedicated copy of the next n bytes
    copy(n) { return new Uint8Array(this.bytes(n)); }
    rest() { return this.bytes(this.remaining); }
    // Reader over the next n bytes; this reader skips them
    sub(n) { this.need(n); const r = new Reader(this.buf, this.pos, this.pos + n); this.pos += n; return r; }
    // Reader over [offset, offset + n) relative to the start of this reader, without moving (offset fields)
    at(offset, n) {
        if (!Number.isInteger(offset) || !Number.isInteger(n) || (offset < 0) || (n < 0) || (offset > this.length) || (n > (this.length - offset))) { throw truncated(); }
        return new Reader(this.buf, this.start + offset, this.start + offset + n);
    }
    // The structure must be fully consumed
    expectEnd() { if (this.pos !== this.end) { throw invalid(); } }
}

class Writer {
    // maxBytes: hard limit of the output (RDP_ERROR_RESOURCE_LIMIT beyond it)
    constructor(initialBytes, maxBytes) {
        if (maxBytes === undefined) { maxBytes = 65536; }
        if (initialBytes === undefined) { initialBytes = Math.min(256, maxBytes); }
        if (!Number.isInteger(maxBytes) || (maxBytes < 0) || !Number.isInteger(initialBytes) || (initialBytes < 0) || (initialBytes > maxBytes)) { throw internal(); }
        this.buf = new Uint8Array(initialBytes);
        this.pos = 0;
        this.max = maxBytes;
    }
    get length() { return this.pos; }
    reserve(n) {
        if (!Number.isInteger(n) || (n < 0)) { throw internal(); }
        const need = this.pos + n;
        if (need > this.max) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
        if (need <= this.buf.length) { return; }
        let size = Math.max(16, this.buf.length * 2);
        while (size < need) { size *= 2; }
        const next = new Uint8Array(Math.min(size, this.max));
        next.set(this.buf.subarray(0, this.pos));
        this.buf.fill(0);
        this.buf = next;
    }
    u8(v) { checkUint(v, 0xFF); this.reserve(1); this.buf[this.pos++] = v; return this; }
    u16le(v) { checkUint(v, 0xFFFF); this.reserve(2); const b = this.buf, p = this.pos; b[p] = v & 0xFF; b[p + 1] = v >>> 8; this.pos += 2; return this; }
    u16be(v) { checkUint(v, 0xFFFF); this.reserve(2); const b = this.buf, p = this.pos; b[p] = v >>> 8; b[p + 1] = v & 0xFF; this.pos += 2; return this; }
    u32le(v) { checkUint(v, 0xFFFFFFFF); this.reserve(4); writeU32le(this.buf, this.pos, v); this.pos += 4; return this; }
    u32be(v) { checkUint(v, 0xFFFFFFFF); this.reserve(4); const b = this.buf, p = this.pos; b[p] = v >>> 24; b[p + 1] = (v >>> 16) & 0xFF; b[p + 2] = (v >>> 8) & 0xFF; b[p + 3] = v & 0xFF; this.pos += 4; return this; }
    bytes(a) { if (!(a instanceof Uint8Array)) { throw internal(); } this.reserve(a.length); this.buf.set(a, this.pos); this.pos += a.length; return this; }
    zeros(n) { this.reserve(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }
    // Overwrite already written bytes (length fields, offsets, MIC)
    setU16le(at, v) { checkUint(v, 0xFFFF); this.check(at, 2); this.buf[at] = v & 0xFF; this.buf[at + 1] = v >>> 8; return this; }
    setU16be(at, v) { checkUint(v, 0xFFFF); this.check(at, 2); this.buf[at] = v >>> 8; this.buf[at + 1] = v & 0xFF; return this; }
    setU32le(at, v) { checkUint(v, 0xFFFFFFFF); this.check(at, 4); writeU32le(this.buf, at, v); return this; }
    setBytes(at, a) { if (!(a instanceof Uint8Array)) { throw internal(); } this.check(at, a.length); this.buf.set(a, at); return this; }
    check(at, n) { if (!Number.isInteger(at) || (at < 0) || ((at + n) > this.pos)) { throw internal(); } }
    // Dedicated copy of the written bytes
    toBytes() { return this.buf.slice(0, this.pos); }
    // View of the written bytes (no copy; invalid after the next write or wipe)
    view() { return this.buf.subarray(0, this.pos); }
    wipe() { this.buf.fill(0); this.pos = 0; }
}

function checkUint(v, max) { if (!Number.isInteger(v) || (v < 0) || (v > max)) { throw internal(); } }
function writeU32le(b, p, v) { b[p] = v & 0xFF; b[p + 1] = (v >>> 8) & 0xFF; b[p + 2] = (v >>> 16) & 0xFF; b[p + 3] = v >>> 24; }

// Concatenate Uint8Arrays into a new dedicated array (maxBytes: optional limit)
function concat(parts, maxBytes) {
    let n = 0;
    for (const p of parts) { if (!(p instanceof Uint8Array)) { throw internal(); } n += p.length; }
    if ((maxBytes !== undefined) && (n > maxBytes)) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// Zero every argument that is a typed array (null and undefined are ignored)
function wipe() {
    for (const a of arguments) { if ((a != null) && ArrayBuffer.isView(a)) { new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(0); } }
}

module.exports = Object.freeze({ Reader: Reader, Writer: Writer, concat: concat, wipe: wipe });
