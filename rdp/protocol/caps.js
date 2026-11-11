/**
 * @description Bounded Demand Active capabilities and conservative bitmap-only Confirm Active
 * @license Apache-2.0
 * Layouts: MS-RDPBCGR 2.2.7; cross-checked with FreeRDP 3.10.3 core/capabilities.c
 * (Apache-2.0, Copyright 2011 Marc-Andre Moreau). No drawing orders, bulk or codecs.
 */
'use strict';
const { Reader, Writer, concat } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('./errors.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID', phase: 'capabilities' });
}
// orderFlags: NEGOTIATEORDERSUPPORT (0x02) | ZEROBOUNDSDELTASSUPPORT (0x08), both mandatory (MS-RDPBCGR 2.2.7.1.3);
// Windows rejects a Confirm Active without the second with ERRINFO_BADCAPABILITIES (0x10EA). orderSupport stays all zero.
const ORDER_FLAGS = 0x0a;
function cap(type, w) {
    const data = w.toBytes();
    return new Writer()
        .u16le(type)
        .u16le(data.length + 4)
        .bytes(data)
        .toBytes();
}
// Bitmap Codecs (MS-RDPBCGR 2.2.7.2.10) with RemoteFX (MS-RDPRFX 2.2.1.1), as FreeRDP 3.x writes it
// (core/capabilities.c rdp_write_rfx_client_capability_container; Apache-2.0). codecProperties is a
// TS_RFX_CLNT_CAPS_CONTAINER with RLGR1 and RLGR3, DWT 5/3, ICT, 64x64 tiles, video mode.
const RFX_GUID = [0x12, 0x2f, 0x77, 0x76, 0x72, 0xbd, 0x63, 0x44, 0xaf, 0xb3, 0xb7, 0x3c, 0x9c, 0x6f, 0x78, 0x86];
const RFX_CODEC_ID = 3;
function rfxIcap(w, entropy) {
    return w.u16le(0x0100).u16le(0x40).u8(0).u8(1).u8(1).u8(entropy);
}
function bitmapCodecs() {
    const props = new Writer().u32le(49).u32le(1).u32le(37).u16le(0xcbc0).u32le(8).u16le(1).u16le(0xcbc1).u32le(29).u8(1).u16le(0xcfc0).u16le(2).u16le(8);
    rfxIcap(props, 1);
    rfxIcap(props, 4);
    const p = props.toBytes();
    return new Writer().u8(1).bytes(Uint8Array.from(RFX_GUID)).u8(RFX_CODEC_ID).u16le(p.length).bytes(p);
}
// Surface Commands (2.2.7.2.9): Set Surface Bits 0x02, Frame Marker 0x10, Stream Surface Bits 0x40. Only for a 32 bpp session.
function surfaceOffered(c) {
    return c.mode === 'legacy' && Array.isArray(c.surfaceCodecs) && c.surfaceCodecs.includes('rfx') && c.colorDepth === 32;
}
function surfaceCapabilities(c) {
    if (!surfaceOffered(c)) return [];
    return [cap(28, new Writer().u32le(0x52).u32le(0)), cap(29, bitmapCodecs())];
}
function capabilities(c) {
    return [
        cap(1, new Writer().u16le(4).u16le(7).u16le(0x200).u16le(0).u16le(0).u16le(0x405).zeros(6).u8(1).u8(1)),
        cap(
            2,
            new Writer()
                .u16le(c.colorDepth)
                .u16le(1)
                .u16le(1)
                .u16le(1)
                .u16le(c.width)
                .u16le(c.height)
                .u16le(0)
                .u16le(1)
                .u16le(1)
                .u8(0)
                .u8(8)
                .u16le(1)
                .u16le(0),
        ),
        cap(3, new Writer().zeros(20).u16le(1).u16le(20).u16le(0).u16le(1).u16le(0).u16le(ORDER_FLAGS).zeros(32).zeros(20)),
        cap(4, new Writer().zeros(36)), // three caches, zero entries and sizes
        cap(8, new Writer().u16le(1).u16le(L.POINTER_CACHE_MAX_ENTRIES).u16le(L.POINTER_CACHE_MAX_ENTRIES)),
        cap(
            13,
            new Writer()
                .u16le(0x13d)
                .u16le(0)
                .u32le(c.keyboardLayout || 0x409)
                .u32le(4)
                .u32le(0)
                .u32le(12)
                .zeros(64),
        ),
        cap(15, new Writer().u32le(0)),
        cap(16, new Writer().zeros(48)),
        cap(20, new Writer().u32le(0).u32le(1600)),
        cap(12, new Writer().u16le(0).u16le(0)),
        cap(9, new Writer().u16le(0).u16le(0)),
        cap(14, new Writer().u16le(1).u16le(0)),
        cap(5, new Writer().u16le(0).u16le(0).u16le(2).u16le(2)),
        cap(10, new Writer().u16le(6).u16le(0)),
        cap(7, new Writer().zeros(8)),
        cap(26, new Writer().u32le(L.FASTPATH_REASSEMBLY_MAX_BYTES)),
        cap(27, new Writer().u16le(3)),
        cap(25, new Writer().u16le(0)),
        ...surfaceCapabilities(c),
    ];
}
function parseDemand(bytes) {
    const r = new Reader(bytes),
        shareId = r.u32le(),
        sourceLength = r.u16le(),
        capsLength = r.u16le();
    r.skip(sourceLength);
    if (capsLength < 4) {
        bad();
    }
    const caps = r.sub(capsLength);
    const count = caps.u16le();
    caps.skip(2);
    if (count > 64) {
        bad();
    }
    const sets = new Map();
    let width, height, bpp;
    for (let i = 0; i < count; i++) {
        const type = caps.u16le(),
            n = caps.u16le();
        if (n < 4 || sets.has(type)) {
            bad();
        }
        const v = caps.sub(n - 4);
        sets.set(type, v.rest());
        if (type === 2) {
            const b = new Reader(sets.get(type));
            bpp = b.u16le();
            b.skip(6);
            width = b.u16le();
            height = b.u16le();
        }
    }
    caps.expectEnd();
    r.u32le();
    r.expectEnd(); // sessionId
    if (
        !width ||
        !height ||
        width > L.DESKTOP_MAX_DIM ||
        height > L.DESKTOP_MAX_DIM ||
        ![15, 16, 24, 32].includes(bpp)
    ) {
        bad();
    }
    let fastInput = false,
        refresh = false,
        suppress = false;
    if (sets.has(13)) {
        const v = new Reader(sets.get(13));
        fastInput = !!(v.u16le() & 0x28);
    }
    if (sets.has(1)) {
        const v = new Reader(sets.get(1));
        v.skip(18);
        refresh = !!v.u8();
        suppress = !!v.u8();
    }
    return { shareId, width, height, bpp, sets, fastInput, refresh, suppress };
}
function confirm(shareId, user, c) {
    const caps = capabilities(c),
        bytes = concat(caps),
        source = Uint8Array.of(0x4d, 0x65, 0x73, 0x68, 0);
    return new Writer()
        .u32le(shareId)
        .u16le(1002)
        .u16le(source.length)
        .u16le(bytes.length + 4)
        .bytes(source)
        .u16le(caps.length)
        .u16le(0)
        .bytes(bytes)
        .toBytes();
}
module.exports = Object.freeze({ capabilities, parseDemand, confirm, surfaceOffered, RFX_CODEC_ID });
