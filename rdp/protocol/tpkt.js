/**
* @description Web-RDP TPKT (T.123 / RFC 1006) framing and the TPKT / fast-path frame splitter
* @license Apache-2.0
*
* TPKT: version 3, reserved, 16-bit big-endian length including the 4-byte header (<= TPKT_MAX_BYTES).
* Fast-path output (MS-RDPBCGR 2.2.9.1.2): first byte with action 0 in its two low bits, then a 1-byte
* length or, when its high bit is set, a 15-bit length (<= FASTPATH_MAX_BYTES), header included.
* FrameSplitter reassembles both from an arbitrary chunked byte stream. It holds at most one partial
* frame plus the rest of the current chunk and never allocates more than the declared frame length,
* which the header check bounds before any allocation.
*/
'use strict';

const { RdpError } = require('./errors.js');
const limits = require('../core/limits.js');

const TPKT_VERSION = 3;
const TPKT_HEADER_BYTES = 4;
const TPKT_MIN_BYTES = 7;   // header + the smallest X.224 TPDU (Data: LI, code, EOT)

function protocol(detail, phase) { return new RdpError('RDP_ERROR_PROTOCOL', { detail: detail || 'INVALID', phase: phase }); }

// payload → TPKT frame (new Uint8Array)
function encode(payload) {
    if (!(payload instanceof Uint8Array)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
    const n = payload.length + TPKT_HEADER_BYTES;
    if (n > limits.TPKT_MAX_BYTES) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
    const out = new Uint8Array(n);
    out[0] = TPKT_VERSION; out[1] = 0; out[2] = n >>> 8; out[3] = n & 0xFF;
    out.set(payload, TPKT_HEADER_BYTES);
    return out;
}

// Length of a TPKT frame from its header (4 bytes available)
function frameLength(b, offset) {
    const o = offset || 0;
    if (b[o] !== TPKT_VERSION) { throw protocol(); }
    const n = (b[o + 2] << 8) | b[o + 3];
    if (n < TPKT_MIN_BYTES) { throw protocol(); }
    return n;   // a 16-bit field cannot exceed TPKT_MAX_BYTES (65535)
}

// One complete TPKT frame → its payload (view)
function decode(frame) {
    if (!(frame instanceof Uint8Array) || (frame.length < TPKT_HEADER_BYTES)) { throw protocol('TRUNCATED'); }
    const n = frameLength(frame, 0);
    if (n !== frame.length) { throw protocol((n > frame.length) ? 'TRUNCATED' : 'INVALID'); }
    return frame.subarray(TPKT_HEADER_BYTES);
}

const FRAME = Object.freeze({ TPKT: 'tpkt', FASTPATH: 'fastpath' });

// Reassembles TPKT and fast-path frames: push(chunk) returns the complete frames [{ type, data }],
// data is a dedicated Uint8Array holding the whole frame including its header.
class FrameSplitter {
    constructor(phase) {
        this.chunks = [];       // pending input chunks; the first one is consumed from this.head
        this.head = 0;
        this.pending = 0;       // bytes pending in chunks
        this.need = -1;         // length of the frame being assembled, -1 while its header is incomplete
        this.type = null;
        this.phase = phase;
    }
    get bufferedBytes() { return this.pending; }

    push(chunk) {
        if (!(chunk instanceof Uint8Array)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
        const frames = [];
        if (chunk.length > 0) { this.chunks.push(chunk); this.pending += chunk.length; }
        for (; ;) {
            if (this.need < 0) {
                if (this.pending < 1) { break; }
                const b0 = this.peek(0);
                if (b0 === TPKT_VERSION) {
                    if (this.pending < TPKT_HEADER_BYTES) { break; }
                    // byte 1 is reserved; T.123 receivers ignore it
                    const n = (this.peek(2) << 8) | this.peek(3);
                    if (n < TPKT_MIN_BYTES) { throw protocol(null, this.phase); }
                    this.need = n; this.type = FRAME.TPKT;
                } else if ((b0 & 0x03) === 0) {
                    if (this.pending < 2) { break; }
                    const l1 = this.peek(1);
                    let n, header;
                    if (l1 & 0x80) {
                        if (this.pending < 3) { break; }
                        n = ((l1 & 0x7F) << 8) | this.peek(2); header = 3;
                    } else { n = l1; header = 2; }
                    if ((n < header) || (n > limits.FASTPATH_MAX_BYTES)) { throw protocol(null, this.phase); }
                    this.need = n; this.type = FRAME.FASTPATH;
                } else {
                    throw protocol(null, this.phase);
                }
            }
            if (this.pending < this.need) { break; }
            frames.push({ type: this.type, data: this.take(this.need) });
            this.need = -1; this.type = null;
        }
        return frames;
    }

    peek(i) {
        let k = this.head + i;
        for (const c of this.chunks) { if (k < c.length) { return c[k]; } k -= c.length; }
        throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' });
    }

    take(n) {
        const out = new Uint8Array(n);
        let o = 0;
        while (o < n) {
            const c = this.chunks[0];
            const m = Math.min(n - o, c.length - this.head);
            out.set(c.subarray(this.head, this.head + m), o);
            o += m; this.head += m;
            if (this.head === c.length) { this.chunks.shift(); this.head = 0; }
        }
        this.pending -= n;
        return out;
    }

    // Bytes received after the last complete frame (e.g. when handing the stream to another reader)
    drain() {
        const out = this.take(this.pending);
        this.need = -1; this.type = null;
        return out;
    }
}

module.exports = Object.freeze({
    TPKT_VERSION: TPKT_VERSION, TPKT_HEADER_BYTES: TPKT_HEADER_BYTES, TPKT_MIN_BYTES: TPKT_MIN_BYTES, FRAME: FRAME,
    encode: encode, decode: decode, frameLength: frameLength, FrameSplitter: FrameSplitter
});
