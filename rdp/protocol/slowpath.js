/**
 * @description Share Control/Data framing, bitmap and pointer updates to WIRE
 * @license Apache-2.0
 * Layout reference: MS-RDPBCGR 2.2.9.1; FreeRDP 3.10.3 core/update.c (Apache-2.0).
 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('./errors.js');
function bad(detail = 'INVALID') {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail });
}
function share(type, user, bytes) {
    return new Writer()
        .u16le(bytes.length + 6)
        .u16le(0x10 | type)
        .u16le(user)
        .bytes(bytes)
        .toBytes();
}
function data(shareId, user, type, bytes) {
    const body = new Writer()
        .u32le(shareId)
        .u8(0)
        .u8(1)
        .u16le(bytes.length + 4)
        .u8(type)
        .u8(0)
        .u16le(0)
        .bytes(bytes)
        .toBytes();
    return share(7, user, body);
}
function parseShare(bytes) {
    const r = new Reader(bytes),
        out = [];
    while (r.remaining) {
        const n = r.u16le();
        if (n === 0x8000) {
            // T.128 FlowPDU is always eight bytes, not a 32768-byte Share Control PDU.
            r.skip(6);
            continue;
        }
        if (n < 6) {
            bad();
        }
        const v = r.sub(n - 2),
            h = v.u16le(),
            source = v.u16le();
        if ((h & 0xfff0) !== 0x10) {
            bad();
        }
        const type = h & 15;
        if (type !== 7) {
            out.push({ type, source, body: v.rest() });
            continue;
        }
        const shareId = v.u32le();
        v.skip(1);
        const stream = v.u8(),
            length = v.u16le(),
            dataType = v.u8(),
            compression = v.u8(),
            compressedLength = v.u16le();
        // Share Control bounds the body. Servers use different uncompressedLength conventions;
        // compressedLength is ignored when compressedType is zero (MS-RDPBCGR 2.2.8.1.1.1.2).
        if (![0, 1, 2, 4].includes(stream) || compression !== 0) {
            bad(compression ? 'UNSUPPORTED' : 'INVALID');
        }
        out.push({ type, source, shareId, dataType, body: v.rest() });
    }
    return out;
}
function* bitmap(r, desktop, io) {
    const count = r.u16le();
    if (count < 1 || count > L.BITMAP_MAX_RECTS) {
        bad();
    }
    const rects = [];
    for (let i = 0; i < count; i++) {
        const x = r.u16le(),
            y = r.u16le(),
            right = r.u16le(),
            bottom = r.u16le(),
            bw = r.u16le(),
            bh = r.u16le(),
            bpp = r.u16le(),
            flags = r.u16le(),
            len = r.u16le();
        const width = right - x + 1,
            height = bottom - y + 1;
        if (
            width < 1 ||
            height < 1 ||
            bw < width ||
            bh < height ||
            bw > L.BITMAP_MAX_DIM ||
            bh > L.BITMAP_MAX_DIM ||
            ![15, 16, 24, 32].includes(bpp) ||
            flags & ~0x401
        ) {
            bad();
        }
        const p = r.sub(len);
        let codec = 0;
        if (flags & 1) {
            codec = bpp === 32 ? 2 : 1;
            if (!(flags & 0x400)) {
                const first = p.u16le(),
                    main = p.u16le(),
                    scan = p.u16le(),
                    uncompressed = p.u16le();
                if (first !== 0 || main !== p.remaining || scan === 0 || uncompressed === 0) {
                    bad();
                }
            }
        } else {
            const stride = Math.ceil((bw * Math.ceil(bpp / 8)) / 4) * 4;
            if (p.remaining !== stride * bh) {
                bad();
            }
        }
        if (p.remaining === 0) {
            bad();
        }
        const payload = p.rest();
        const visibleWidth = Math.min(width, desktop.width - x),
            visibleHeight = Math.min(height, desktop.height - y);
        // Keep the encoded dimensions/data: decoders crop the top-left visible part.
        if (visibleWidth > 0 && visibleHeight > 0)
            rects.push({
                codec,
                bpp,
                x,
                y,
                width: visibleWidth,
                height: visibleHeight,
                bw,
                bh,
                payload,
            });
    }
    r.expectEnd();
    const maxPixels = Math.max(desktop.width * desktop.height * 2, L.BITMAP_MAX_RECTS * 64 * 64);
    let first = 0;
    while (first < rects.length) {
        let end = first,
            size = 4,
            pixels = 0;
        while (end < rects.length) {
            const rect = rects[end],
                n = 20 + rect.payload.length,
                area = rect.bw * rect.bh;
            if (area > maxPixels || n + 4 > L.WIRE_FRAME_MAX_BYTES) {
                throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
            }
            if (end > first && (size + n > L.WIRE_BATCH_MAX_BYTES || pixels + area > maxPixels)) break;
            size += n;
            pixels += area;
            end++;
        }
        // Exact writer capacity, returned as a view: no full-update writer, growth or result copy.
        // The generator keeps it reserved across yield/backpressure; engine output has its own charge.
        io.reserve(size);
        try {
            const w = new Writer(size, size)
                .u8(1)
                .u8(0)
                .u16le(end - first);
            for (let i = first; i < end; i++) {
                const rect = rects[i];
                w.u8(rect.codec)
                    .u8(rect.bpp)
                    .u8(rect.codec === 0 ? 1 : 0)
                    .u8(0)
                    .u16le(rect.x)
                    .u16le(rect.y)
                    .u16le(rect.width)
                    .u16le(rect.height)
                    .u16le(rect.bw)
                    .u16le(rect.bh)
                    .u32le(rect.payload.length)
                    .bytes(rect.payload);
            }
            yield w.view();
        } finally {
            io.release(size);
        }
        first = end;
    }
}
// Indexed pointer pixels use the current color table; 1-bit pixels use black/white.
// The supplied palette is RGBA. Indexed pointers without a palette are rejected rather than guessed.
function masksToRgba(width, height, bpp, xor, and, palette) {
    if (
        width < 1 ||
        height < 1 ||
        width > L.POINTER_MAX_DIM ||
        height > L.POINTER_MAX_DIM ||
        ![1, 4, 8, 16, 24, 32].includes(bpp)
    ) {
        bad();
    }
    const xs = Math.ceil(Math.ceil((width * bpp) / 8) / 2) * 2,
        as = Math.ceil(Math.ceil(width / 8) / 2) * 2;
    if (xor.length !== xs * height || (and.length !== 0 && and.length !== as * height)) {
        bad();
    }
    if ((bpp === 4 || bpp === 8) && (!(palette instanceof Uint8Array) || palette.length < (1 << bpp) * 4)) {
        bad('UNSUPPORTED');
    }
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = bpp === 1 ? y : height - 1 - y;
        for (let x = 0; x < width; x++) {
            const d = (y * width + x) * 4,
                p = row * xs,
                mask = and.length ? (and[row * as + (x >>> 3)] >>> (7 - (x & 7))) & 1 : 0;
            let red = 0,
                green = 0,
                blue = 0,
                alpha = 255;
            if (bpp === 1) {
                red = green = blue = ((xor[p + (x >>> 3)] >>> (7 - (x & 7))) & 1) * 255;
            } else if (bpp === 4 || bpp === 8) {
                const index = bpp === 4 ? (xor[p + (x >>> 1)] >>> (x & 1 ? 0 : 4)) & 15 : xor[p + x];
                red = palette[index * 4];
                green = palette[index * 4 + 1];
                blue = palette[index * 4 + 2];
            } else if (bpp === 16) {
                const v = xor[p + x * 2] | (xor[p + x * 2 + 1] << 8);
                red = Math.round(((v >>> 11) * 255) / 31);
                green = Math.round((((v >>> 5) & 63) * 255) / 63);
                blue = Math.round(((v & 31) * 255) / 31);
            } else {
                const a = p + x * (bpp / 8);
                blue = xor[a];
                green = xor[a + 1];
                red = xor[a + 2];
                if (bpp === 32) {
                    alpha = xor[a + 3];
                }
            }
            // WIRE carries ordinary RGBA, so destination inversion is approximated by a checker
            // as in IronRDP pointer.rs (MIT/Apache-2.0) and FreeRDP codec/color.c (Apache-2.0).
            if (mask && alpha === 255) {
                if (red === 0 && green === 0 && blue === 0) {
                    alpha = 0;
                } else if (red === 255 && green === 255 && blue === 255) {
                    red = green = blue = (x + y) % 2 ? 0 : 255;
                }
            }
            out[d] = red;
            out[d + 1] = green;
            out[d + 2] = blue;
            out[d + 3] = alpha;
        }
    }
    return out;
}
// Surface Commands (MS-RDPBCGR 2.2.9.2) of a fast-path update, only after they were advertised (caps.js). Set Surface Bits and Stream
// Surface Bits become one WIRE SURFACE_BITS frame each (rdp/WIRE.md 0x02); Frame Markers are consumed. The RemoteFX payload is
// validated by the browser decoder (it is not decoded here). A codec that was not advertised ends the session.
const CMD_SET_SURFACE_BITS = 1,
    CMD_FRAME_MARKER = 4,
    CMD_STREAM_SURFACE_BITS = 6;
const SURFACE_HEADER = 24;
function* surfaceCommands(r, desktop, io, codecId) {
    while (r.remaining) {
        const cmd = r.u16le();
        if (cmd === CMD_FRAME_MARKER) {
            const action = r.u16le();
            r.u32le();
            if (action > 1) bad();
            continue;
        }
        if (cmd !== CMD_SET_SURFACE_BITS && cmd !== CMD_STREAM_SURFACE_BITS) bad('UNSUPPORTED');
        const left = r.u16le(),
            top = r.u16le(),
            right = r.u16le(),
            bottom = r.u16le(),
            bpp = r.u8(),
            flags = r.u8(),
            reserved = r.u8(),
            codec = r.u8(),
            width = r.u16le(),
            height = r.u16le(),
            length = r.u32le();
        // bpp is informational for RemoteFX (FreeRDP ignores it); the WIRE frame always says 32
        if (right <= left || bottom <= top || bpp < 1 || bpp > 32 || (flags & ~1) !== 0 || reserved !== 0) bad();
        if (flags & 1) r.skip(24); // TS_COMPRESSED_BITMAP_HEADER_EX
        if (codec !== codecId) bad('UNSUPPORTED'); // raw (0) and codecs we did not advertise
        if (width < 1 || height < 1 || width > L.BITMAP_MAX_DIM || height > L.BITMAP_MAX_DIM || length < 1) bad();
        if (length > L.WIRE_FRAME_MAX_BYTES - SURFACE_HEADER) {
            throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
        }
        const payload = r.bytes(length);
        if (left >= desktop.width || top >= desktop.height) continue; // completely outside the desktop
        const size = SURFACE_HEADER + length;
        io.reserve(size);
        try {
            yield new Writer(size, size)
                .u8(2)
                .u8(1)
                .u16le(0)
                .u16le(left)
                .u16le(top)
                .u16le(Math.min(right, desktop.width))
                .u16le(Math.min(bottom, desktop.height))
                .u8(32)
                .u8(0)
                .u16le(0)
                .u16le(width)
                .u16le(height)
                .u32le(length)
                .bytes(payload)
                .view();
        } finally {
            io.release(size);
        }
    }
}
class Output {
    constructor(io, desktop) {
        this.io = io;
        this.desktop = desktop;
        this.cached = new Set();
        this.palette = null;
        this.surface = false; // Surface Commands + RemoteFX advertised in the current activation
    }
    *surfaceCommands(bytes, codecId) {
        if (!this.surface) bad('UNSUPPORTED');
        yield* surfaceCommands(new Reader(bytes), this.desktop, this.io, codecId);
    }
    reset(desktop) {
        this.desktop = desktop;
        // The pointer cache survives a reactivation: servers (xrdp) refer to shapes set before the Deactivate-All
        this.palette = null;
    }
    pointer(kind, r) {
        const w = new Writer(256, L.WIRE_FRAME_MAX_BYTES).u8(0x20);
        if (kind === 'hidden' || kind === 'default') {
            w.u8(kind === 'hidden' ? 0 : 1);
        } else if (kind === 'system') {
            const type = r.u32le();
            if (type !== 0 && type !== 0x7f00) {
                bad();
            }
            w.u8(type === 0 ? 0 : 1);
        } else if (kind === 'position') {
            const x = r.u16le(),
                y = r.u16le();
            w.u8(4)
                .u16le(Math.min(x, this.desktop.width - 1))
                .u16le(Math.min(y, this.desktop.height - 1));
        } else if (kind === 'cached') {
            const index = r.u16le();
            if (!this.cached.has(index)) {
                bad();
            }
            w.u8(3).u16le(index);
        } else {
            const bpp = kind === 'color' ? 24 : r.u16le(),
                index = r.u16le(),
                hx = r.u16le(),
                hy = r.u16le(),
                width = r.u16le(),
                height = r.u16le();
            const al = kind === 'large' ? r.u32le() : r.u16le(),
                xl = kind === 'large' ? r.u32le() : r.u16le();
            if (
                (kind !== 'large' && (width > 96 || height > 96)) ||
                index >= L.POINTER_CACHE_MAX_ENTRIES ||
                hx >= width ||
                hy >= height ||
                width < 1 ||
                height < 1 ||
                width > L.POINTER_MAX_DIM ||
                height > L.POINTER_MAX_DIM
            ) {
                bad();
            }
            const xor = r.bytes(xl),
                and = r.bytes(al),
                size = width * height * 4;
            this.io.reserve(size);
            try {
                w.u8(2)
                    .u16le(index)
                    .u16le(hx)
                    .u16le(hy)
                    .u16le(width)
                    .u16le(height)
                    .bytes(masksToRgba(width, height, bpp, xor, and, this.palette));
            } finally {
                this.io.release(size);
            }
            if (r.remaining === 1) {
                r.skip(1);
            }
            this.cached.add(index);
        }
        r.expectEnd();
        return w.toBytes();
    }
    *update(bytes) {
        const r = new Reader(bytes),
            type = r.u16le();
        if (type === 1) {
            yield* bitmap(r, this.desktop, this.io);
            return;
        }
        if (type === 3) {
            r.skip(2);
            r.expectEnd();
            return null;
        }
        if (type === 2) {
            // No 8bpp desktop requested, but indexed cursor masks can reference a palette.
            r.skip(2);
            const count = r.u32le();
            if (count !== 256) {
                bad();
            }
            const p = new Uint8Array(1024);
            for (let i = 0; i < count; i++) {
                p[i * 4] = r.u8();
                p[i * 4 + 1] = r.u8();
                p[i * 4 + 2] = r.u8();
                p[i * 4 + 3] = 255;
            }
            r.expectEnd();
            this.palette = p;
            return null;
        }
        bad('UNSUPPORTED'); // Drawing orders / surface commands were not advertised.
    }
    slowPointer(bytes) {
        const r = new Reader(bytes),
            type = r.u16le();
        r.skip(2);
        const kind = { 1: 'system', 3: 'position', 6: 'color', 7: 'cached', 8: 'new', 9: 'large' }[type];
        if (!kind) {
            bad('UNSUPPORTED');
        }
        return this.pointer(kind, r);
    }
}
module.exports = Object.freeze({ share, data, parseShare, bitmap, masksToRgba, Output });
