/**
 * @description MS-RDPEGFX 2.2.4.1 structural ClearCodec validation; never reconstructs pixels.
 * @license Apache-2.0
 * References: 2.2.4.1.1.1 residual runs, 2.2.4.1.1.2 bands/V-Bars,
 * 2.2.4.1.1.3 subcodec envelopes, 3.3.1.9–13 cache metadata and 4.1.1.4 (band/V-Bar example with glyph-index storage).
 * A glyph hit may reshape the stored pixels to any area up to the stored one (FreeRDP clear.c).
 */
'use strict';
const { RdpError } = require('../protocol/errors.js');
const { useLegacy } = require('./errors.js');
function bad() { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID', hint: 'use-legacy' }); }
const METADATA_BYTES = 4000 * 2;
class ClearStructure {
    constructor(io) {
        this.io = io; this.sequence = 0; this.closed = false;
        try { io.reserve(METADATA_BYTES); } catch (e) { throw useLegacy(e); }
        try {
            // Zero = missing glyph; V-Bar hits need no server-side cache metadata.
            this.glyphs = new Uint16Array(4000);
        } catch (e) { io.release(METADATA_BYTES); throw useLegacy(e); }
    }
    validate(r, box) {
        try { return this.validateStructure(r, box); } catch (e) { throw useLegacy(e); }
    }
    validateStructure(r, box) {
        const flags = r.u8(), seq = r.u8(), area = box.width * box.height;
        if (this.closed || (flags & 2 && !(flags & 1)) || (this.sequence && seq !== this.sequence)) bad();
        let glyph = null;
        if (flags & 1) { glyph = r.u16le(); if (glyph >= 4000 || area > 1024) bad(); }
        if (flags & 2) {
            const stored = this.glyphs[glyph]; if (!stored || area > stored) bad();
        } else {
            const residual = r.u32le(), bands = r.u32le(), subcodecs = r.u32le();
            if (residual + bands + subcodecs > r.remaining) bad();
            this.residual(r.sub(residual), area);
            this.bands(r.sub(bands), box);
            this.subcodecs(r.sub(subcodecs), box);
            // Unknown flags and trailing composite bytes are ignored, as in FreeRDP.
            r.skip(r.remaining);
            if (glyph !== null) this.glyphs[glyph] = Math.max(this.glyphs[glyph], area);
        }
        r.expectEnd(); this.sequence = (seq + 1) & 255;
    }
    residual(r, area) {
        let pixels = 0;
        while (r.remaining) {
            r.skip(3); let n = r.u8();
            if (n === 255) { n = r.u16le(); if (n === 65535) n = r.u32le(); }
            if (n > area - pixels) bad(); pixels += n;
        }
    }
    bands(r, box) {
        while (r.remaining) {
            const x0 = r.u16le(), x1 = r.u16le(), y0 = r.u16le(), y1 = r.u16le();
            const height = y1 - y0 + 1;
            // FreeRDP consumes/cache-updates the complete band, including edges outside the target.
            // The browser clips painting to its destination; the envelope still bounds every read.
            if (x1 < x0 || height < 1 || height > 52) bad();
            r.skip(3); r.need((x1 - x0 + 1) * 2);
            for (let x = x0; x <= x1; x++) {
                const header = r.u16le();
                if (header & 0x8000) {
                    // Empty hits get black pixels; mismatched heights are resized by FreeRDP.
                    continue;
                }
                if (header & 0x4000) {
                    r.skip(1); // short V-Bar yOn; empty/mismatched hits are accepted
                } else {
                    const on = header & 255, off = header >>> 8;
                    if (off < on || off - on > 52) bad();
                    r.skip((off - on) * 3);
                }
            }
        }
    }
    subcodecs(r, box) {
        while (r.remaining) {
            const x = r.u16le(), y = r.u16le(), width = r.u16le(), height = r.u16le();
            const count = r.u32le(), id = r.u8(), rawBytes = 3 * width * height;
            // Raw is exactly 3*w*h. NSCodec/RLEX have no additional count restriction here: the envelope is bounded by the
            // outer payload (sub(count) below) and FreeRDP has no upper bound. MS-RDPEGFX 2.2.4.1.1.3.1 says
            // bitmapDataByteCount MUST NOT exceed 3*w*h, but a narrow NSCodec strip (20-byte header) can
            // legitimately sit above any fixed formula, so a looser check would risk false rejections.
            if (x + width > box.width || y + height > box.height || id > 2 ||
                (id === 0 && count !== rawBytes)) bad();
            // NSCodec/RLEX payload decoding belongs to the browser. No nested payload may escape its envelope.
            const payload = r.sub(count); payload.skip(payload.remaining); payload.expectEnd();
        }
    }
    // ResetGraphics only restarts sequence synchronization; glyph metadata survives.
    reset() { if (!this.closed) this.sequence = 0; }
    close() {
        if (this.closed) return; this.closed = true;
        this.glyphs = null; this.io.release(METADATA_BYTES);
    }
}
module.exports = Object.freeze({ ClearStructure });
