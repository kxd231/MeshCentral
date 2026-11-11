/**
* @description Web-RDP ASN.1 BER reader (definite lengths only) used by CredSSP, X.509 walking and MCS
* @license Apache-2.0
*
* Reading rules (X.690):
* - only definite lengths; the indefinite form (0x80) is rejected;
* - long-form lengths have at most 4 octets; strict (DER) mode also requires the minimal form;
* - a value never extends past its enclosing structure (Reader bounds), so a forged length throws
*   RdpError('RDP_ERROR_PROTOCOL', TRUNCATED) before anything is allocated;
* - high tag numbers (e.g. MCS [APPLICATION 101] = 7F 65) use at most 3 octets and must be >= 31;
* - parse() builds a generic tree with a depth limit (BER_MAX_DEPTH) and a node limit (BER_MAX_NODES).
* Values are returned as Reader views over the input, never as copies.
*/
'use strict';

const { RdpError } = require('../protocol/errors.js');
const { Reader } = require('./stream.js');

const BER_MAX_DEPTH = 16;
const BER_MAX_NODES = 4096;

const CLASS = Object.freeze({ UNIVERSAL: 0, APPLICATION: 1, CONTEXT: 2, PRIVATE: 3 });
// Identifier octets of the universal types we use (low tag form)
const TAG = Object.freeze({ BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, ENUMERATED: 0x0A, SEQUENCE: 0x30, SET: 0x31 });

function invalid() { return new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' }); }

function toReader(input) { return (input instanceof Reader) ? input : new Reader(input); }

// Identifier octets → { cls, constructed, number, id } (id: the single identifier octet, or -1 for the high tag form)
function readTag(r) {
    const b = r.u8();
    const cls = b >>> 6, constructed = (b & 0x20) !== 0;
    let number = b & 0x1F;
    if (number !== 0x1F) { return { cls: cls, constructed: constructed, number: number, id: b }; }
    number = 0;
    for (let count = 1; ; count++) {
        if (count > 3) { throw invalid(); }
        const c = r.u8();
        if ((count === 1) && ((c & 0x7F) === 0)) { throw invalid(); }  // leading zero bits are not minimal
        number = (number << 7) | (c & 0x7F);
        if ((c & 0x80) === 0) { break; }
    }
    if (number < 0x1F) { throw invalid(); }
    return { cls: cls, constructed: constructed, number: number, id: -1 };
}

function readLength(r, strict) {
    const b = r.u8();
    if (b < 0x80) { return b; }
    const n = b & 0x7F;
    if ((n === 0) || (n > 4)) { throw invalid(); }        // indefinite form, or more than 4 GiB
    let len = 0;
    for (let i = 0; i < n; i++) { len = (len * 256) + r.u8(); }
    if (strict && ((len < 0x80) || ((n > 1) && (len < Math.pow(256, n - 1))))) { throw invalid(); }
    return len;
}

// One TLV → { cls, constructed, number, id, value: Reader }. The value is checked against the
// remaining bytes before anything else happens.
function readTlv(input, strict) {
    const r = toReader(input);
    const t = readTag(r);
    const len = readLength(r, strict);
    t.value = r.sub(len);
    return t;
}

// Read a TLV whose identifier octet must equal id (low tag form); returns the value Reader
function expect(r, id, strict) {
    const t = readTlv(r, strict);
    if (t.id !== id) { throw invalid(); }
    return t.value;
}

// Like expect(), but returns null without consuming anything when the next identifier differs or r is empty
function optional(r, id, strict) {
    if ((r.remaining === 0) || (r.peekU8() !== id)) { return null; }
    return expect(r, id, strict);
}

// INTEGER content → JS number (two's complement, at most 6 content octets so the result is exact).
// strict: minimal encoding required.
function decodeInteger(v, strict) {
    const n = v.remaining;
    if ((n < 1) || (n > 6)) { throw invalid(); }
    const b = v.bytes(n);
    if (strict && (n > 1) && (((b[0] === 0x00) && ((b[1] & 0x80) === 0)) || ((b[0] === 0xFF) && ((b[1] & 0x80) !== 0)))) { throw invalid(); }
    let x = 0;
    for (let i = 0; i < n; i++) { x = (x * 256) + b[i]; }
    if (b[0] & 0x80) { x -= Math.pow(256, n); }
    return x;
}

function readInteger(r, strict, id) { return decodeInteger(expect(r, (id === undefined) ? TAG.INTEGER : id, strict), strict); }

// OCTET STRING → view of its bytes; maxBytes optional
function readOctetString(r, strict, maxBytes) {
    const v = expect(r, TAG.OCTET_STRING, strict);
    if ((maxBytes !== undefined) && (v.remaining > maxBytes)) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
    return v.rest();
}

// BIT STRING → { unused, bytes } (bytes: view without the unused-bits octet)
function readBitString(r, strict) {
    const v = expect(r, TAG.BIT_STRING, strict);
    const unused = v.u8();
    if ((unused > 7) || ((unused !== 0) && (v.remaining === 0))) { throw invalid(); }
    return { unused: unused, bytes: v.rest() };
}

// Generic tree for diagnostics and fuzzing: [{ cls, constructed, number, value: Uint8Array, children? }]
function parse(input, options) {
    const o = options || {};
    const maxDepth = o.maxDepth || BER_MAX_DEPTH, maxNodes = o.maxNodes || BER_MAX_NODES;
    const state = { nodes: 0 };
    function level(r, depth) {
        if (depth > maxDepth) { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'LIMIT' }); }
        const out = [];
        while (r.remaining > 0) {
            if (++state.nodes > maxNodes) { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'LIMIT' }); }
            const t = readTlv(r, !!o.strict);
            const node = { cls: t.cls, constructed: t.constructed, number: t.number, value: t.value.buf.subarray(t.value.start, t.value.end) };
            if (t.constructed) { node.children = level(t.value, depth + 1); }
            out.push(node);
        }
        return out;
    }
    return level(toReader(input), 1);
}

// Length octets for n (minimal form)
function encodeLength(n) {
    if (!Number.isInteger(n) || (n < 0) || (n > 0xFFFFFFFF)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
    if (n < 0x80) { return Uint8Array.of(n); }
    if (n <= 0xFF) { return Uint8Array.of(0x81, n); }
    if (n <= 0xFFFF) { return Uint8Array.of(0x82, n >>> 8, n & 0xFF); }
    if (n <= 0xFFFFFF) { return Uint8Array.of(0x83, n >>> 16, (n >>> 8) & 0xFF, n & 0xFF); }
    return Uint8Array.of(0x84, n >>> 24, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
}

// Minimal two's complement content octets of an integer (safe integer range)
function encodeIntegerContent(v) {
    if (!Number.isSafeInteger(v)) { throw new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }
    const out = [];
    let x = v;
    for (; ;) {
        const byte = ((x % 256) + 256) % 256;
        out.unshift(byte);
        x = (x - byte) / 256;
        if (((x === 0) && ((byte & 0x80) === 0)) || ((x === -1) && ((byte & 0x80) !== 0))) { break; }
    }
    return Uint8Array.from(out);
}

module.exports = Object.freeze({
    BER_MAX_DEPTH: BER_MAX_DEPTH, BER_MAX_NODES: BER_MAX_NODES, CLASS: CLASS, TAG: TAG,
    readTag: readTag, readLength: readLength, readTlv: readTlv, expect: expect, optional: optional,
    decodeInteger: decodeInteger, readInteger: readInteger, readOctetString: readOctetString, readBitString: readBitString,
    parse: parse, encodeLength: encodeLength, encodeIntegerContent: encodeIntegerContent
});
