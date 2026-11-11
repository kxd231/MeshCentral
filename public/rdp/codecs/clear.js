/**
 * @description Session-scoped MS-RDPEGFX ClearCodec: residual, bands, glyphs, raw/NSCodec/RLEX.
 * @license Apache-2.0
 * Algorithm adapted from FreeRDP libfreerdp/codec/clear.c (Apache-2.0), Copyright
 * 2014 Marc-Andre Moreau, 2016 Armin Novak / Thincast Technologies GmbH.
 * Cache sizes and glyph area are protocol constants, not configurable resource limits.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'), require('./nsc.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.clear = factory(root.RdpShared.limits, root.RdpCodecs.errors, root.RdpCodecs.nsc);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors, nsc) {
    'use strict';
    const fail = code => { throw new errors.CodecError(code); };
    const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
    const VBARS = 32768, SHORTS = 16384, HEIGHT = 52, GLYPHS = 4000;
    // Match GfxClient.WORK_PIXELS_MAX without importing the client into a codec.
    const WORK_PIXELS_MAX = 64 * 1024 * 1024;
    const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    const ALPHA_MASK = LITTLE_ENDIAN ? 0xff000000 : 0xff;
    // Dense bounded stores preserve the old tail when a cached V-Bar shrinks then grows,
    // just like FreeRDP's capacity/count distinction. Glyph references are charged as 8 bytes each.
    const CACHE_BYTES = (VBARS + SHORTS) * HEIGHT * 4 + VBARS * 2 + SHORTS + GLYPHS * 8;
    class Reader {
        constructor(src) { this.src = src; this.p = 0; this.view = new DataView(src.buffer, src.byteOffset, src.length); }
        get left() { return this.src.length - this.p; }
        need(n) { if (n > this.left) { fail('TRUNCATED'); } }
        u8() { this.need(1); return this.src[this.p++]; }
        u16() { this.need(2); const n = this.view.getUint16(this.p, true); this.p += 2; return n; }
        u32() { this.need(4); const n = this.view.getUint32(this.p, true); this.p += 4; return n; }
        bytes(n) { this.need(n); const b = this.src.subarray(this.p, this.p + n); this.p += n; return b; }
        sub(n) { return new Reader(this.bytes(n)); }
        color() {
            this.need(3);
            const b = this.src[this.p++], g = this.src[this.p++], r = this.src[this.p++];
            return LITTLE_ENDIAN ? (r | g << 8 | b << 16 | 0xff000000) : (r << 24 | g << 16 | b << 8 | 255);
        }
        run() { let n = this.u8(); if (n === 255) { n = this.u16(); if (n === 65535) { n = this.u32(); } } return n; }
    }

    class ClearCodec {
        constructor({ budget } = {}) {
            this.budget = budget; this.reserved = 0; this.closed = false;
            this.sequence = 0; this.vbarCursor = 0; this.shortCursor = 0;
            try {
                this._reserve(CACHE_BYTES);
                this.vbars = new Uint8Array(VBARS * HEIGHT * 4);
                this.shorts = new Uint8Array(SHORTS * HEIGHT * 4);
                this.vbars32 = new Uint32Array(this.vbars.buffer);
                this.shorts32 = new Uint32Array(this.shorts.buffer);
                this.counts = new Uint8Array(VBARS);
                this.capacities = new Uint8Array(VBARS);
                this.shortCounts = new Uint8Array(SHORTS);
                this.glyphs = new Array(GLYPHS).fill(null);
            } catch (e) { this.close(); throw errors.toCodecError(e); }
        }
        _reserve(n) {
            if (this.reserved + n > limits.BROWSER_CODEC_STATE_MAX_BYTES) { fail('LIMIT'); }
            if (this.budget) { this.budget.reserve(n); }
            this.reserved += n;
        }
        _release(n) { this.reserved -= n; if (this.budget) { this.budget.release(n); } }
        reset() { if (!this.closed) { this.sequence = 0; } } // ResetGraphics preserves every cache and cursor
        close() {
            if (this.closed) { return; }
            this.closed = true;
            this.vbars = this.shorts = this.counts = this.capacities = this.shortCounts = this.glyphs = null;
            this.vbars32 = this.shorts32 = null;
            if (this.reserved) { this._release(this.reserved); }
        }
        _work(n) { this.work += n; if (this.work > WORK_PIXELS_MAX) { fail('LIMIT'); } }
        _grow(index, height) {
            const cap = this.capacities[index], base = index * HEIGHT;
            if (height > cap) {
                this.vbars32.fill(0, base + cap, base + height);
                this.capacities[index] = height;
            }
            this.counts[index] = height;
        }
        decode(src, rect, dst, params) {
            try {
                if (this.closed) { fail('INTERNAL'); }
                if (!(src instanceof Uint8Array) || !rect || !dst) { fail('INVALID'); }
                if (!integer(dst.width, 1, limits.SURFACE_MAX_DIM) || !integer(dst.height, 1, limits.SURFACE_MAX_DIM) ||
                    dst.width * dst.height > limits.SURFACES_MAX_PIXELS ||
                    !integer(rect.x, 0, dst.width) || !integer(rect.y, 0, dst.height) ||
                    !integer(rect.width, 1, limits.BITMAP_MAX_DIM) || !integer(rect.height, 1, limits.BITMAP_MAX_DIM) ||
                    rect.x + rect.width > dst.width || rect.y + rect.height > dst.height ||
                    !integer(dst.stride, dst.width * 4, Math.floor(Number.MAX_SAFE_INTEGER / dst.height))) { fail('LIMIT'); }
                if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID'); }
                if (dst.data.length < dst.stride * dst.height || src.length > limits.GFX_PDU_MAX_BYTES) { fail('LIMIT'); }
                if (src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength &&
                    dst.data.byteOffset < src.byteOffset + src.byteLength) { fail('INVALID'); }
                const r = new Reader(src), flags = r.u8(), seq = r.u8(), area = rect.width * rect.height;
                // FreeRDP resynchronizes whenever expected == 0, including wrap and ResetGraphics.
                // Unknown flag bits are ignored, as in FreeRDP; HIT still requires INDEX.
                if ((flags & 2 && !(flags & 1)) || (this.sequence && seq !== this.sequence)) { fail('INVALID'); }
                let glyph = -1;
                if (flags & 1) { glyph = r.u16(); if (glyph >= GLYPHS || area > 1024) { fail('INVALID'); } }
                if (flags & 4) { this.vbarCursor = this.shortCursor = 0; }
                this.work = 0;
                let image;
                if (flags & 2) {
                    image = this.glyphs[glyph];
                    if (!image || image.length < area * 4 || r.left) { fail('INVALID'); }
                } else {
                    const residual = r.u32(), bands = r.u32(), subcodecs = r.u32();
                    if (residual + bands + subcodecs > r.left) { fail('INVALID'); }
                    // Paint only after every layer succeeded. Omitted layers preserve destination pixels.
                    image = new Uint8Array(area * 4);
                    const image32 = new Uint32Array(image.buffer);
                    for (let y = 0; y < rect.height; y++) {
                        const start = (rect.y + y) * dst.stride + rect.x * 4;
                        image.set(dst.data.subarray(start, start + rect.width * 4), y * rect.width * 4);
                    }
                    this._residual(r.sub(residual), image32, area);
                    this._bands(r.sub(bands), image32, rect.width, rect.height);
                    this._subcodecs(r.sub(subcodecs), image, image32, rect.width, rect.height);
                    // FreeRDP ignores bytes after the three bounded composite layers.
                    r.p += r.left;
                    if (glyph >= 0) {
                        const old = this.glyphs[glyph];
                        if (old && old.length >= image.length) {
                            // FreeRDP preserves capacity/count and the old tail on a smaller miss.
                            old.set(image);
                        } else {
                            this._reserve(image.length);
                            this.glyphs[glyph] = image;
                            if (old) { this._release(old.length); }
                        }
                    }
                }
                for (let y = 0; y < rect.height; y++) {
                    const start = (rect.y + y) * dst.stride + rect.x * 4;
                    if (flags & 2) {
                        // FreeRDP's glyph copy keeps destination alpha, just like 24-bit raw/residual.
                        for (let x = 0; x < rect.width; x++) {
                            const p = (y * rect.width + x) * 4, o = start + x * 4;
                            dst.data[o] = image[p]; dst.data[o + 1] = image[p + 1]; dst.data[o + 2] = image[p + 2];
                        }
                    } else { dst.data.set(image.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), start); }
                }
                this.sequence = (seq + 1) & 255;
            } catch (e) { throw errors.toCodecError(e); }
        }
        _residual(r, image, area) {
            if (!r.left) { return; }
            let p = 0;
            while (r.left) {
                const color = r.color(), n = r.run();
                if (p >= area || n > area - p) { fail('INVALID'); }
                this._work(n);
                for (let i = 0; i < n; i++, p++) {
                    image[p] = (image[p] & ALPHA_MASK) | (color & ~ALPHA_MASK);
                }
            }
            if (p !== area) { fail('INVALID'); }
        }
        _bands(r, image, width, height) {
            while (r.left) {
                const x0 = r.u16(), x1 = r.u16(), y0 = r.u16(), y1 = r.u16(), bg = r.color();
                const h = y1 - y0 + 1;
                if (x1 < x0 || h < 1 || h > HEIGHT) { fail('INVALID'); }
                r.need((x1 - x0 + 1) * 2);
                this._work((x1 - x0 + 1) * h);
                for (let x = x0; x <= x1; x++) {
                    const header = r.u16();
                    let index;
                    if (header & 0x8000) {
                        index = header & 0x7fff;
                        this._grow(index, h);
                    } else {
                        let on, length, shortIndex;
                        if (header & 0x4000) {
                            shortIndex = header & 0x3fff; on = r.u8(); length = this.shortCounts[shortIndex];
                        } else {
                            on = header & 255; const off = header >>> 8;
                            if (off < on || off - on > HEIGHT) { fail('INVALID'); }
                            length = off - on; r.need(length * 3);
                            shortIndex = this.shortCursor;
                            const base = shortIndex * HEIGHT;
                            for (let y = 0; y < length; y++) { this.shorts32[base + y] = r.color(); }
                            this.shortCounts[shortIndex] = length;
                            this.shortCursor = (shortIndex + 1) & 0x3fff;
                        }
                        index = this.vbarCursor;
                        this._grow(index, h);
                        const base = index * HEIGHT, shortBase = shortIndex * HEIGHT;
                        this.vbars32.fill(bg, base, base + h);
                        for (let y = on, end = Math.min(h, on + length); y < end; y++) {
                            this.vbars32[base + y] = this.shorts32[shortBase + y - on];
                        }
                        this.vbarCursor = (index + 1) & 0x7fff;
                    }
                    // Decode/cache all columns, clip painting to rect even if a band extends past it.
                    if (x >= width || y0 >= height) { continue; }
                    let o = y0 * width + x;
                    const base = index * HEIGHT, end = Math.min(h, height - y0);
                    for (let y = 0; y < end; y++, o += width) {
                        image[o] = this.vbars32[base + y];
                    }
                }
            }
        }
        _subcodecs(r, image, image32, width, height) {
            while (r.left) {
                const x = r.u16(), y = r.u16(), w = r.u16(), h = r.u16(), count = r.u32(), id = r.u8();
                if (x + w > width || y + h > height || id > 2) { fail('INVALID'); }
                const p = r.sub(count); this._work(w * h);
                if (id === 0) {
                    if (count !== w * h * 3) { fail('INVALID'); }
                    for (let j = 0; j < h; j++) {
                        for (let i = 0; i < w; i++) {
                            const color = p.color(), o = (y + j) * width + x + i;
                            image32[o] = (image32[o] & ALPHA_MASK) | (color & ~ALPHA_MASK);
                        }
                    }
                } else if (id === 1) {
                    if (!w || !h) {
                        // Native NSCodec accepts empty images with a valid header/planes.
                        if (p.left < 20) { fail('TRUNCATED'); }
                        const sizes = p.u32() + p.u32() + p.u32() + p.u32(), cll = p.u8(), cs = p.u8();
                        p.bytes(2); if (cll < 1 || cll > 7 || cs > 1) { fail('INVALID'); } p.bytes(sizes);
                    } else {
                        nsc.decode(p.src, { x, y, width: w, height: h },
                            { data: image, width, height, stride: width * 4 }, { bitmapWidth: w, bitmapHeight: h });
                    }
                } else { this._rlex(p, image32, width, x, y, w, h); }
            }
        }
        _rlex(r, image, stride, x, y, width, height) {
            const count = r.u8();
            if (count < 1 || count > 127) { fail('INVALID'); }
            r.need(count * 3);
            const palette = new Uint32Array(count);
            for (let i = 0; i < count; i++) { palette[i] = r.color(); }
            const bits = Math.floor(Math.log2(Math.max(1, count - 1))) + 1, mask = (1 << bits) - 1;
            const area = width * height; let pixel = 0, column = 0, offset = y * stride + x;
            while (r.left) {
                const control = r.u8(), run = r.run(), stop = control & mask, depth = control >>> bits, start = stop - depth;
                if (start < 0 || stop >= count || run + depth + 1 > area - pixel) { fail('INVALID'); }
                pixel += run + depth + 1;
                let left = run;
                while (left) {
                    const n = Math.min(left, width - column);
                    image.fill(palette[start], offset, offset + n);
                    offset += n; column += n; left -= n;
                    if (column === width) { column = 0; offset += stride - width; }
                }
                for (let i = start; i <= stop; i++) {
                    image[offset++] = palette[i];
                    if (++column === width) { column = 0; offset += stride - width; }
                }
            }
            if (pixel !== area) { fail('INVALID'); }
        }
    }
    return Object.freeze({ ClearCodec });
});
