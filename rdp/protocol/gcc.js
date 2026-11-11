/**
 * @description T.124 Conference Create and RDP client/server data blocks
 * @license Apache-2.0
 * Wire layouts cross-checked with FreeRDP 3.10.3 libfreerdp/core/gcc.c (Apache-2.0),
 * Copyright Marc-Andre Moreau, Norbert Federa, Martin Haimberger, Armin Novak, Thincast.
 */
'use strict';
const { Reader, Writer, concat } = require('../core/stream.js');
const per = require('../core/per.js');
const L = require('../core/limits.js');
const { RdpError } = require('./errors.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
}
function utf16(text) {
    const w = new Writer();
    for (let i = 0; i < text.length; i++) {
        w.u16le(text.charCodeAt(i));
    }
    return w.toBytes();
}
function channels(c) {
    return c.mode === 'gfx' || c.displayControl !== false ? ['cliprdr', 'drdynvc'] : ['cliprdr'];
}
function block(type, bytes) {
    return new Writer()
        .u16le(type)
        .u16le(bytes.length + 4)
        .bytes(bytes)
        .toBytes();
}
function clientBlocks(c, protocol) {
    if (
        ![15, 16, 24, 32].includes(c.colorDepth) ||
        c.width < 200 ||
        c.height < 200 ||
        c.width > L.DESKTOP_MAX_DIM ||
        c.height > L.DESKTOP_MAX_DIM
    ) {
        bad();
    }
    const name = utf16((c.clientName || 'MeshCentral').slice(0, 15));
    const core = new Writer()
        .u32le(0x80004)
        .u16le(c.width)
        .u16le(c.height)
        .u16le(0xca01)
        .u16le(0xaa03)
        .u32le(c.keyboardLayout || 0x409)
        .u32le(2600)
        .bytes(name)
        .zeros(32 - name.length)
        .u32le(4)
        .u32le(0)
        .u32le(12)
        .zeros(64)
        .u16le(0xca01)
        .u16le(1)
        .u32le(0)
        .u16le(Math.min(24, c.colorDepth))
        .u16le(0x0f)
        .u16le(0x21 | (c.colorDepth === 32 ? 2 : 0) | (c.mode === 'gfx' ? 0x100 : 0))
        .zeros(64)
        .u8(6)
        .u8(0)
        .u32le(protocol)
        .toBytes();
    const names = channels(c);
    if (names.length > L.MCS_MAX_STATIC_CHANNELS) {
        bad();
    }
    const net = new Writer().u32le(names.length);
    for (const name of names) {
        const a = Uint8Array.from(name, (ch) => ch.charCodeAt(0));
        net.bytes(a)
            .zeros(8 - a.length)
            .u32le(0x80000000);
    }
    return concat([
        block(0xc001, core),
        block(0xc002, new Uint8Array(8)),
        block(0xc003, net.toBytes()),
        block(0xc004, new Uint8Array(8)),
    ]);
}
const OID = Uint8Array.of(0, 5, 0, 20, 124, 0, 1);
function request(c, protocol) {
    const data = clientBlocks(c, protocol),
        w = new Writer();
    w.bytes(OID);
    per.writeLength(w, data.length + 14);
    w.bytes(Uint8Array.of(0, 8, 0, 16, 0, 1, 0xc0, 0, 0x44, 0x75, 0x63, 0x61));
    per.writeLength(w, data.length);
    return w.bytes(data).toBytes();
}
function parseResponse(bytes, expectedCount) {
    const r = new Reader(bytes);
    per.expect(r, OID);
    per.readLength(r); // MUST be ignored (MS-RDPBCGR 2.2.1.4.1)
    if (r.u8() !== 0x14) {
        bad();
    }
    per.readUint16(r, 1001);
    per.readInteger(r);
    if (r.u8() !== 0 || r.u8() !== 1 || r.u8() !== 0xc0) {
        bad();
    }
    per.expect(r, Uint8Array.of(0, 0x4d, 0x63, 0x44, 0x6e));
    const blocks = r.sub(per.readLength(r));
    r.expectEnd();
    const seen = new Set(),
        out = { channels: [] };
    while (blocks.remaining) {
        const type = blocks.u16le(),
            n = blocks.u16le();
        if (n < 4 || seen.has(type)) {
            bad();
        }
        seen.add(type);
        const v = blocks.sub(n - 4);
        if (type === 0x0c01) {
            out.version = v.u32le();
            if (v.remaining >= 4) {
                out.requestedProtocols = v.u32le();
            }
            if (v.remaining >= 4) {
                out.earlyFlags = v.u32le();
            }
        } else if (type === 0x0c02) {
            if (v.u32le() !== 0 || v.u32le() !== 0) {
                throw new RdpError('RDP_ERROR_STANDARD_SECURITY_UNSUPPORTED');
            }
        } else if (type === 0x0c03) {
            out.globalChannel = v.u16le();
            const count = v.u16le();
            if (
                count > L.MCS_MAX_STATIC_CHANNELS ||
                (expectedCount !== undefined && count !== expectedCount) ||
                out.globalChannel < 1001
            ) {
                bad();
            }
            for (let i = 0; i < count; i++) {
                const id = v.u16le();
                if (id < 1001 || id === out.globalChannel || out.channels.includes(id)) {
                    bad();
                }
                out.channels.push(id);
            }
            if (count & 1) {
                v.skip(2);
            }
            v.expectEnd();
        }
        v.skip(v.remaining);
    }
    if (!seen.has(0x0c01) || !seen.has(0x0c02) || !seen.has(0x0c03)) {
        bad();
    }
    return out;
}
module.exports = Object.freeze({ utf16, channels, clientBlocks, request, parseResponse });
