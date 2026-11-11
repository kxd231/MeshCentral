/**
* @description Web-RDP ASN.1 DER encoder and strict DER readers
* @license Apache-2.0
*
* Encoding: build a tree with seq()/ctx()/int()/octets()/node() and call encode(). Sizes are computed
* first and the result is written into one dedicated Uint8Array, so secret values (TSPasswordCreds)
* are copied exactly once and the caller can wipe the output. Nesting is limited to BER_MAX_DEPTH and
* the output to maxBytes.
* Reading: the strict wrappers apply DER rules (minimal lengths and integers) on top of rdp/core/ber.js.
* A small own DER is used instead of node-forge: we need a handful of types, strict bounds and no
* intermediate copies of secrets, which node-forge's string-based buffers cannot give.
*/
'use strict';

const { RdpError } = require('../protocol/errors.js');
const ber = require('./ber.js');

function internal() { return new RdpError('RDP_ERROR_INTERNAL', { detail: 'INVALID' }); }

// tag: one identifier octet (number) or the identifier octets (Uint8Array, high tag form)
function node(tag, value) { return { tag: tag, value: value }; }
function constructed(tag, children) { return { tag: tag, children: children }; }
function seq() { return constructed(ber.TAG.SEQUENCE, Array.prototype.slice.call(arguments).filter(function (c) { return c != null; })); }
// [n] EXPLICIT (context specific, constructed)
function ctx(n, child) { if (!Number.isInteger(n) || (n < 0) || (n > 30)) { throw internal(); } return constructed(0xA0 | n, [child]); }
function int(v) { return node(ber.TAG.INTEGER, ber.encodeIntegerContent(v)); }
function octets(bytes) { return node(ber.TAG.OCTET_STRING, bytes); }

function tagLength(tag) {
    if (typeof tag == 'number') { if (!Number.isInteger(tag) || (tag < 0) || (tag > 0xFF) || ((tag & 0x1F) === 0x1F)) { throw internal(); } return 1; }
    if (tag instanceof Uint8Array) { return tag.length; }
    throw internal();
}

function lengthOfLength(n) { return (n < 0x80) ? 1 : (n <= 0xFF) ? 2 : (n <= 0xFFFF) ? 3 : (n <= 0xFFFFFF) ? 4 : 5; }

function measure(n, depth) {
    if ((n == null) || (typeof n != 'object')) { throw internal(); }
    if (depth > ber.BER_MAX_DEPTH) { throw internal(); }
    let content = 0;
    if (n.children !== undefined) {
        if (!Array.isArray(n.children)) { throw internal(); }
        for (const c of n.children) { content += measure(c, depth + 1); }
    } else {
        if (!(n.value instanceof Uint8Array)) { throw internal(); }
        content = n.value.length;
    }
    n._content = content;
    return tagLength(n.tag) + lengthOfLength(content) + content;
}

function write(n, out, pos) {
    if (typeof n.tag == 'number') { out[pos++] = n.tag; } else { out.set(n.tag, pos); pos += n.tag.length; }
    const l = ber.encodeLength(n._content);
    out.set(l, pos); pos += l.length;
    if (n.children !== undefined) { for (const c of n.children) { pos = write(c, out, pos); } }
    else { out.set(n.value, pos); pos += n.value.length; }
    delete n._content;
    return pos;
}

// Encode a tree into one dedicated Uint8Array (maxBytes: RDP_ERROR_RESOURCE_LIMIT beyond it)
function encode(tree, maxBytes) {
    const size = measure(tree, 1);
    if ((maxBytes !== undefined) && (size > maxBytes)) { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
    const out = new Uint8Array(size);
    if (write(tree, out, 0) !== size) { throw internal(); }
    return out;
}

// Strict DER readers (minimal lengths and integers)
const strict = Object.freeze({
    readTlv: function (r) { return ber.readTlv(r, true); },
    expect: function (r, id) { return ber.expect(r, id, true); },
    optional: function (r, id) { return ber.optional(r, id, true); },
    readInteger: function (r, id) { return ber.readInteger(r, true, id); },
    readOctetString: function (r, maxBytes) { return ber.readOctetString(r, true, maxBytes); },
    readBitString: function (r) { return ber.readBitString(r, true); },
    parse: function (input, options) { return ber.parse(input, Object.assign({}, options, { strict: true })); }
});

module.exports = Object.freeze({ node: node, constructed: constructed, seq: seq, ctx: ctx, int: int, octets: octets, encode: encode, strict: strict });
