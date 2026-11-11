/**
* @description RDPGFX surfaces as RGBA byte arrays: fill, blit, copy, dirty rectangles, composition rows. No DOM.
* @license Apache-2.0
*
* A surface keeps RGBA8888, not premultiplied, rows top-down (the dst of public/rdp/codecs/README.md), whatever the
* wire pixel format: XRGB surfaces always hold alpha 255; ARGB surfaces keep their alpha in the surface and the output ignores it. Every function checks its
* rectangles against the surface and throws CodecError('INVALID') / ('LIMIT'), so a server cannot make it write outside.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('../shared/constants.js'), require('../codecs/errors.js'));
    } else {
        root.RdpGfx = root.RdpGfx || {};
        root.RdpGfx.surface = factory(root.RdpShared.limits, root.RdpShared.constants, root.RdpCodecs.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, constants, codecErrors) {
    'use strict';
    const CodecError = codecErrors.CodecError;
    const LITTLE_ENDIAN = (new Uint8Array(new Uint32Array([1]).buffer)[0] === 1);
    const DIRTY_MAX_RECTS = 16;     // more rectangles collapse into their bounding box

    function inside(r, width, height) {
        return (r.x >= 0) && (r.y >= 0) && (r.width >= 1) && (r.height >= 1) && (r.x + r.width <= width) && (r.y + r.height <= height);
    }

    class Surface {
        constructor(id, width, height, format) {
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width < 1) || (height < 1) ||
                (width > limits.SURFACE_MAX_DIM) || (height > limits.SURFACE_MAX_DIM)) { throw new CodecError('LIMIT', 'surface size'); }
            this.id = id; this.width = width; this.height = height; this.format = format;
            this.stride = width * 4;
            try { this.data = new Uint8ClampedArray(this.stride * height); }
            catch (ex) { throw new CodecError('LIMIT', 'surface memory'); }
            if (format === constants.GFX_PIXEL_FORMAT.XRGB_8888) {
                const d = this.data;
                if (LITTLE_ENDIAN) { new Uint32Array(d.buffer, d.byteOffset, d.length >> 2).fill(0xFF000000); }
                else { for (let i = 3; i < d.length; i += 4) { d[i] = 255; } }
            }
            this.map = null;        // { x, y } output origin, or null
            this.dirty = [];        // rectangles changed since the last composition
        }

        get opaque() { return this.format === constants.GFX_PIXEL_FORMAT.XRGB_8888; }

        // The rectangle goes to the dirty list; many rectangles collapse into one bounding box
        markDirty(r) {
            const d = this.dirty;
            // A rectangle inside one that is already listed adds nothing (the list is composed once at END_FRAME)
            for (const q of d) {
                if ((r.x >= q.x) && (r.y >= q.y) && (r.x + r.width <= q.x + q.width) && (r.y + r.height <= q.y + q.height)) { return; }
            }
            if (d.length >= DIRTY_MAX_RECTS) {
                let x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
                for (const q of d) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + q.width); y1 = Math.max(y1, q.y + q.height); }
                this.dirty = [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }];
            } else { d.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
        }

        markAllDirty() { this.dirty = [{ x: 0, y: 0, width: this.width, height: this.height }]; }

        // color: { r, g, b, a } bytes; XRGB surfaces store alpha 255
        fill(rect, color) {
            if (!inside(rect, this.width, this.height)) { throw new CodecError('INVALID', 'fill rectangle'); }
            const a = this.opaque ? 255 : color.a;
            const d = this.data;
            if (LITTLE_ENDIAN) {
                const u32 = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
                const v = ((a << 24) | (color.b << 16) | (color.g << 8) | color.r) >>> 0;
                for (let y = rect.y; y < rect.y + rect.height; y++) { u32.fill(v, (y * this.width) + rect.x, (y * this.width) + rect.x + rect.width); }
            } else {
                for (let y = rect.y; y < rect.y + rect.height; y++) {
                    for (let x = rect.x; x < rect.x + rect.width; x++) {
                        const o = (y * this.stride) + (x * 4);
                        d[o] = color.r; d[o + 1] = color.g; d[o + 2] = color.b; d[o + 3] = a;
                    }
                }
            }
            this.markDirty(rect);
        }

        // Copies a rectangle out as a tight RGBA array (width * height * 4)
        extract(rect) {
            if (!inside(rect, this.width, this.height)) { throw new CodecError('INVALID', 'source rectangle'); }
            const out = new Uint8ClampedArray(rect.width * rect.height * 4);
            const row = rect.width * 4;
            for (let y = 0; y < rect.height; y++) {
                const s = ((rect.y + y) * this.stride) + (rect.x * 4);
                out.set(this.data.subarray(s, s + row), y * row);
            }
            return out;
        }

        // Writes tight RGBA pixels (width * height) at x, y. XRGB surfaces force alpha 255.
        put(x, y, width, height, rgba) {
            if (rgba.length !== width * height * 4) { throw new CodecError('INTERNAL', 'pixel buffer size'); }
            this.putStrided(x, y, width, height, rgba, 0, width * 4);
        }

        // As put(), from a larger array: row j of the rectangle starts at src[offset + j * stride]. Only the rectangle is written.
        putStrided(x, y, width, height, src, offset, stride) {
            if (!inside({ x: x, y: y, width: width, height: height }, this.width, this.height)) { throw new CodecError('INVALID', 'destination rectangle'); }
            if ((offset < 0) || (stride < width * 4) || (offset + ((height - 1) * stride) + (width * 4) > src.length)) { throw new CodecError('INTERNAL', 'pixel buffer size'); }
            const row = width * 4;
            for (let j = 0; j < height; j++) {
                const o = ((y + j) * this.stride) + (x * 4);
                const s = offset + (j * stride);
                this.data.set(src.subarray(s, s + row), o);
                if (this.opaque) { for (let k = o + 3; k < o + row; k += 4) { this.data[k] = 255; } }
            }
            this.markDirty({ x: x, y: y, width: width, height: height });
        }

        // Rows of `rect` composed for the output: RGBA with alpha 255, tight, into `out` (≥ width * height * 4)
        compose(rect, out) {
            const row = rect.width * 4;
            for (let j = 0; j < rect.height; j++) {
                const s = ((rect.y + j) * this.stride) + (rect.x * 4);
                out.set(this.data.subarray(s, s + row), j * row);
            }
            if (!this.opaque) { for (let k = 3; k < rect.width * rect.height * 4; k += 4) { out[k] = 255; } }
        }
    }

    // GFX cache (3.3.1.4): slot → { width, height, data }, bounded by slots and bytes
    class Cache {
        constructor() { this.slots = new Map(); this.bytes = 0; }
        set(slot, width, height, data) {
            if (!Number.isSafeInteger(slot) || (slot < 1) || (slot > limits.GFX_CACHE_MAX_SLOTS)) { throw new CodecError('INVALID', 'cache slot'); }
            const old = this.slots.get(slot);
            const total = this.bytes - (old ? old.data.length : 0) + data.length;
            if (total > limits.GFX_CACHE_MAX_BYTES) { throw new CodecError('LIMIT', 'cache bytes'); }
            this.slots.set(slot, { width: width, height: height, data: data });
            this.bytes = total;
        }
        get(slot) { return this.slots.get(slot); }
        evict(slot) {
            const old = this.slots.get(slot);
            if (!old) { throw new CodecError('INVALID', 'cache slot is empty'); }
            this.slots.delete(slot);
            this.bytes -= old.data.length;
        }
        clear() { this.slots.clear(); this.bytes = 0; }
    }

    return Object.freeze({ Surface: Surface, Cache: Cache, inside: inside, DIRTY_MAX_RECTS: DIRTY_MAX_RECTS });
});
