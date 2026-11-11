/**
 * @description T.125 MCS connection, domain and Send Data PDUs
 * @license Apache-2.0
 * Layout reference: MS-RDPBCGR 2.2.1 and FreeRDP 3.10.3 core/mcs.c (Apache-2.0).
 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const ber = require('../core/ber.js'),
    der = require('../core/der.js'),
    per = require('../core/per.js');
const gcc = require('./gcc.js');
const { RdpError } = require('./errors.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
}
const domain = (a) =>
    der.constructed(
        0x30,
        a.map((n) => der.int(n)),
    );
function connectInitial(c, protocol) {
    return der.encode(
        der.constructed(Uint8Array.of(0x7f, 0x65), [
            der.octets(Uint8Array.of(1)),
            der.octets(Uint8Array.of(1)),
            der.node(1, Uint8Array.of(0xff)),
            domain([34, 2, 0, 1, 0, 1, 65535, 2]),
            domain([1, 1, 1, 1, 0, 1, 1056, 2]),
            domain([65535, 64535, 65535, 1, 0, 1, 65535, 2]),
            der.octets(gcc.request(c, protocol)),
        ]),
        65528,
    );
}
function parseConnectResponse(bytes, count) {
    const r = new Reader(bytes),
        t = ber.readTlv(r);
    r.expectEnd();
    if (t.cls !== 1 || !t.constructed || t.number !== 102) {
        bad();
    }
    const v = t.value;
    if (ber.readInteger(v, false, 10) !== 0) {
        throw new RdpError('RDP_ERROR_SERVER_DENIED', { phase: 'mcs' });
    }
    ber.readInteger(v);
    const params = ber.expect(v, 0x30);
    for (let i = 0; i < 8; i++) {
        const n = ber.readInteger(params);
        if (n < 0 || n > 65535) {
            bad();
        }
    }
    params.expectEnd();
    const data = ber.readOctetString(v, false, 65528);
    v.expectEnd();
    return gcc.parseResponse(data, count);
}
function erectDomain() {
    return Uint8Array.of(4, 1, 0, 1, 0);
}
function attachUser() {
    return Uint8Array.of(0x28);
}
function parseAttach(bytes) {
    const r = new Reader(bytes);
    if (r.u8() !== 0x2e || r.u8() !== 0) {
        bad();
    }
    const id = per.readUint16(r, 1001);
    r.expectEnd();
    return id;
}
function join(user, channel) {
    return new Writer()
        .u8(0x38)
        .u16be(user - 1001)
        .u16be(channel)
        .toBytes();
}
function parseJoin(bytes, user, channel) {
    const r = new Reader(bytes);
    if (
        r.u8() !== 0x3e ||
        r.u8() !== 0 ||
        per.readUint16(r, 1001) !== user ||
        r.u16be() !== channel ||
        r.u16be() !== channel
    ) {
        bad();
    }
    r.expectEnd();
}
function sendData(user, channel, data) {
    const w = new Writer();
    w.u8(0x64)
        .u16be(user - 1001)
        .u16be(channel)
        .u8(0x70);
    per.writeLength(w, data.length);
    // This framing is also used for Client Info; do not leave a secret in Writer's spare buffer.
    try {
        return w.bytes(data).toBytes();
    } finally {
        w.wipe();
    }
}
function parseData(bytes) {
    const r = new Reader(bytes),
        h = r.u8();
    if (h >>> 2 === 8) {
        throw new RdpError('RDP_ERROR_SERVER_DISCONNECTED');
    }
    if (h !== 0x68) {
        bad();
    }
    const user = per.readUint16(r, 1001),
        channelId = r.u16be();
    // dataPriority (top 2 bits, any value: Windows uses top, high and low), segmentation begin+end (0x30), padding zero.
    if ((r.u8() & 0x3f) !== 0x30) {
        bad();
    }
    const data = r.bytes(per.readLength(r));
    r.expectEnd();
    return { user, channelId, data };
}
module.exports = Object.freeze({
    connectInitial,
    parseConnectResponse,
    erectDomain,
    attachUser,
    parseAttach,
    join,
    parseJoin,
    sendData,
    parseData,
});
