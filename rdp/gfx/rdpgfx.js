/** @description MS-RDPEGFX client negotiation, validation and ordered forwarding; see GFX-CAPS.md. @license Apache-2.0 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('../protocol/errors.js');
const { useLegacy } = require('./errors.js');
const { Zgfx } = require('./zgfx.js');
const { ClearStructure } = require('./clear.js');
const { WIRE, GFX_CMD: C, GFX_CODEC: K, GFX_FORWARDED, GFX_CAPSETS_ALLOWED } = require('../../public/rdp/shared/constants.js');
const FORWARDED = new Set(GFX_FORWARDED);
// Caps of the browser decoders (public/rdp/codecs/avc420.js MAX_REGIONS, progressive.js and rfx.js RECTS_MAX), mirrored here so a picture
// the browser would refuse ends the session at once with RESOURCE_LIMIT and the use-legacy hint; a unit test keeps them equal.
const AVC_REGIONS_MAX = 8192, REGION_RECTS_MAX = 4096;
const DRAWING = new Set([C.WIRETOSURFACE_1, C.WIRETOSURFACE_2, C.SOLIDFILL, C.SURFACETOSURFACE, C.SURFACETOCACHE, C.CACHETOSURFACE]);
function bad() { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID', hint: 'use-legacy' }); }
function limit() { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT', hint: 'use-legacy' }); }
function packet(cmd, body) { return new Writer().u16le(cmd).u16le(0).u32le(8 + body.length).bytes(body).toBytes(); }
function pixel(v) { if (v !== 0x20 && v !== 0x21) bad(); return v; }
function rect(r, s) {
    const x = r.u16le(), y = r.u16le(), right = r.u16le(), bottom = r.u16le();
    if (right <= x || bottom <= y || right > s.width || bottom > s.height) bad();
    return { x, y, width: right - x, height: bottom - y };
}
function points(r, s, source) {
    const count = r.u16le(); r.need(count * 4);
    for (let i = 0; i < count; i++) {
        const x = r.u16le(), y = r.u16le();
        if (x + source.width > s.width || y + source.height > s.height) bad();
    }
}
class Graphics {
    // canRestart(): the server may close a confirmed pipeline now (xrdp restarts it around a resize); otherwise a peer close ends the session
    constructor(io, send, onConfirm, onDesktop = (w, h) => io.desktop(w, h), canRestart = () => false, restarted = false) {
        this.restarted = restarted;
        this.io = io; this.send = send; this.onConfirm = onConfirm; this.onDesktop = onDesktop; this.canRestart = canRestart;
        const ids = io.config.gfxCapsets;
        if (!Array.isArray(ids)) bad();
        this.advertised = GFX_CAPSETS_ALLOWED.filter(c => ['A','B','D'].includes(c.id) && ids.includes(c.id));
        if (!this.advertised.length) throw new RdpError('RDP_ERROR_CAPABILITIES_REJECTED', { detail: 'UNSUPPORTED', hint: 'use-legacy' });
        this.caps = null; this.closed = false; this.frameId = null; this.surfaces = new Map();
        this.contexts = new Set(); this.cache = new Map(); this.cacheBytes = 0; this.pixels = 0;
        this.desktop = null; this.queue = []; this.pendingBytes = 0; this.clear = null;
        this.zgfx = new Zgfx(io);
        io.gfxChannel();
        const w = new Writer().u16le(this.advertised.length);
        for (const c of this.advertised) w.u32le(c.version).u32le(4).u32le(c.flags);
        try { send(packet(C.CAPSADVERTISE, w.toBytes())); }
        catch (e) { this.close(); throw e; }
    }
    get pending() { return this.queue[0] || null; }
    receive(bytes) {
        try { return this.receiveMessage(bytes); } catch (e) { throw useLegacy(e); }
    }
    receiveMessage(bytes) {
        if (this.closed) bad();
        if (this.queue.length >= L.GFX_QUEUE_MAX_MESSAGES) limit();
        const result = this.zgfx.decompress(bytes, L.REASSEMBLY_MAX_BYTES - this.pendingBytes);
        if (!result.bytes.length) { result.release(); bad(); }
        this.queue.push({ result, offset: 0 }); this.pendingBytes += result.charged;
    }
    // Consecutive PDUs (of one or several decompressed messages, in order) go into one WIRE frame (rdp/WIRE.md "0x10 GFX"), so the
    // number of frames, IPC messages and websocket sends follows the logical frames, not the PDUs or the DVC messages. A frame ends after
    // an END_FRAME (at most one per frame and always its last PDU: the ledger entry and its credit check stay atomic) or before a PDU that
    // would take it above WIRE_BATCH_MAX_BYTES (a PDU is never split and a larger one travels alone). PDUs are validated one by one, in
    // order, before they are copied; the frame is reserved when it is built. A partly consumed message retains its single reservation.
    drain(canForward = true) {
        try { return this.drainPending(canForward); } catch (e) { throw useLegacy(e); }
    }
    drainPending(canForward) {
        while (!this.closed && this.pending && !this.io.outputBlocked()) {
            const parts = [], consumed = [];
            let total = 1, endId = null, stop = false, progressed = false;
            for (const p of this.queue) {
                const bytes = p.result.bytes;
                while (p.offset < bytes.length) {
                    const h = new Reader(bytes, p.offset), cmd = h.u16le(), flags = h.u16le(), size = h.u32le();
                    if (flags || size < 8) bad();
                    if (size > L.GFX_PDU_MAX_BYTES || size + 1 > L.WIRE_FRAME_MAX_BYTES) limit();
                    h.need(size - 8);
                    if (!this.caps && cmd !== C.CAPSCONFIRM) bad();
                    if (!canForward && cmd !== C.CAPSCONFIRM) { stop = true; break; }
                    if (parts.length && total + size > L.WIRE_BATCH_MAX_BYTES) { stop = true; break; }     // not validated yet: it starts the next frame
                    const body = h.sub(size - 8);
                    const id = this.validate(cmd, body, size);
                    body.expectEnd();
                    if (FORWARDED.has(cmd)) { parts.push({ bytes: bytes, offset: p.offset, size: size }); total += size; }
                    p.offset += size;
                    progressed = true;
                    if (id !== null) { endId = id; stop = true; break; }
                }
                if (p.offset === bytes.length) { consumed.push(p); }
                if (stop) { break; }
            }
            if (parts.length) {
                this.io.reserve(total);
                let frame;
                try {
                    frame = new Uint8Array(total); frame[0] = WIRE.GFX;
                    let at = 1;
                    for (const part of parts) { frame.set(part.bytes.subarray(part.offset, part.offset + part.size), at); at += part.size; }
                }
                catch (e) { this.io.release(total); throw e; }
                // Ownership and reservation pass to engine; it releases even on session end.
                this.io.sendFrame(frame, endId === null ? null : [endId], { charged: total });
            }
            for (const p of consumed) { this.queue.shift(); this.pendingBytes -= p.result.charged; p.result.release(); }
            if (!progressed) { return; }       // stopped before the first PDU: waiting for canForward
        }
    }
    surface(r) { const id = r.u16le(), s = this.surfaces.get(id); if (!s) bad(); return s; }
    slot(r) { const id = r.u16le(); if (id < 1 || id > L.GFX_CACHE_MAX_SLOTS) bad(); return id; }
    validate(cmd, r, size) {
        if (cmd === C.CAPSCONFIRM) {
            if (this.caps) bad();
            const version = r.u32le(), length = r.u32le(), flags = r.u32le(); r.expectEnd();
            // The server selects a version and may switch off what we offered: Windows 10 confirms 8.1 with AVC420_ENABLED
            // cleared (flags 0x2 for our 0x12) when it has no H.264 encoder. Flags we did not offer are still refused.
            const set = this.advertised.find(c => c.version === version && (flags & ~c.flags) === 0);
            if (!set || length !== 4) bad();
            // Without SMALL_CACHE the server assumes a 100 MiB cache, which GFX_CACHE_MAX_BYTES (16 MiB) would end mid-session:
            // fail now, before any picture, so the browser falls back to legacy graphics at once
            if (!(flags & 0x2)) throw new RdpError('RDP_ERROR_CAPABILITIES_REJECTED', { detail: 'UNSUPPORTED', hint: 'use-legacy' });
            this.caps = { capsVersion: version, flags }; this.onConfirm(this.caps); return null;
        }
        if (!this.caps || !FORWARDED.has(cmd)) bad();
        if (DRAWING.has(cmd) && this.frameId === null) bad();
        switch (cmd) {
            case C.CREATESURFACE: {
                const id = r.u16le(), width = r.u16le(), height = r.u16le(), format = pixel(r.u8()); r.expectEnd();
                if (this.surfaces.has(id) || !width || !height) bad();
                if (width > L.SURFACE_MAX_DIM || height > L.SURFACE_MAX_DIM || this.surfaces.size >= L.SURFACE_MAX_COUNT || this.pixels + width * height > L.SURFACES_MAX_PIXELS) limit();
                this.surfaces.set(id, { id, width, height, format, mapping: null }); this.pixels += width * height; break;
            }
            case C.DELETESURFACE: {
                const s = this.surface(r); r.expectEnd(); this.surfaces.delete(s.id); this.pixels -= s.width * s.height;
                for (const key of this.contexts) if (key.startsWith(s.id + ':')) this.contexts.delete(key);
                break;
            }
            case C.MAPSURFACETOOUTPUT: {
                const s = this.surface(r); if (r.u16le()) bad();
                const x = r.u32le(), y = r.u32le(); r.expectEnd();
                if (!this.desktop || x >= this.desktop.width || y >= this.desktop.height) bad();
                s.mapping = { x, y }; break;
            }
            case C.STARTFRAME:
                if (this.frameId !== null) bad();
                r.u32le(); this.frameId = r.u32le(); break;
            case C.ENDFRAME: {
                const id = r.u32le(); if (this.frameId === null || this.frameId !== id) bad();
                this.frameId = null; return id;
            }
            case C.RESETGRAPHICS: {
                if (size !== 340) bad();
                const width = r.u32le(), height = r.u32le(), count = r.u32le();
                if (width < L.DESKTOP_MIN_DIM || height < L.DESKTOP_MIN_DIM || width > L.DESKTOP_MAX_DIM || height > L.DESKTOP_MAX_DIM || count > 16) limit();
                let primary = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < count; i++) {
                    const left = r.u32le() | 0, top = r.u32le() | 0, right = r.u32le() | 0, bottom = r.u32le() | 0, flags = r.u32le();
                    if (left > right || top > bottom || right - left + 1 > width || bottom - top + 1 > height || flags & ~1) bad();
                    if (Math.abs(left) > L.DESKTOP_MAX_DIM || Math.abs(top) > L.DESKTOP_MAX_DIM || Math.abs(right) > L.DESKTOP_MAX_DIM || Math.abs(bottom) > L.DESKTOP_MAX_DIM) limit();
                    if (flags & 1) { if (left || top || ++primary > 1) bad(); }
                    minX = Math.min(minX, left); minY = Math.min(minY, top);
                    maxX = Math.max(maxX, right); maxY = Math.max(maxY, bottom);
                }
                if (count && (primary !== 1 || maxX - minX + 1 > width || maxY - minY + 1 > height)) bad();
                r.skip(r.remaining); this.desktop = { width, height };
                if (this.clear) this.clear.reset();
                this.onDesktop(width, height); break;
            }
            case C.SOLIDFILL: {
                const s = this.surface(r); r.skip(4); const n = r.u16le(); r.need(n * 8);
                for (let i = 0; i < n; i++) rect(r, s); break;
            }
            case C.SURFACETOSURFACE: {
                const src = this.surface(r), dst = this.surface(r), box = rect(r, src); points(r, dst, box); break;
            }
            case C.SURFACETOCACHE: {
                const s = this.surface(r); r.skip(8); const slot = this.slot(r), box = rect(r, s); r.expectEnd();
                const bytes = box.width * box.height * 4, previous = this.cache.get(slot);
                const total = this.cacheBytes - (previous ? previous.bytes : 0) + bytes;
                if (total > L.GFX_CACHE_MAX_BYTES) limit();
                this.cache.set(slot, { width: box.width, height: box.height, bytes }); this.cacheBytes = total; break;
            }
            case C.CACHETOSURFACE: {
                const slot = this.slot(r), s = this.surface(r), entry = this.cache.get(slot); if (!entry) bad(); points(r, s, entry); break;
            }
            case C.EVICTCACHEENTRY: {
                const slot = this.slot(r), entry = this.cache.get(slot); r.expectEnd(); if (!entry) bad();
                this.cache.delete(slot); this.cacheBytes -= entry.bytes; break;
            }
            case C.DELETEENCODINGCONTEXT: {
                const s = this.surface(r), key = s.id + ':' + r.u32le(); r.expectEnd();
                if (!this.contexts.delete(key)) bad(); break;
            }
            case C.WIRETOSURFACE_1: {
                const s = this.surface(r), codec = r.u16le(); pixel(r.u8()); const box = rect(r, s), n = r.u32le();
                if (n !== r.remaining || !n) bad();
                const allowed = [K.UNCOMPRESSED, K.CAVIDEO, K.CLEARCODEC, K.PLANAR, K.ALPHA];
                if (this.caps.capsVersion === 0x80105 && this.caps.flags & 0x10) allowed.push(K.AVC420);
                // 10.x: all AVC codecs unless the server confirmed AVC_DISABLED (GFX-CAPS.md)
                if ((this.caps.capsVersion >>> 16) === 0xA && !(this.caps.flags & 0x20)) allowed.push(K.AVC420, K.AVC444, K.AVC444v2);
                if (!allowed.includes(codec)) bad();
                this.bitmap(codec, r.sub(n), s, box); break;
            }
            case C.WIRETOSURFACE_2: {
                const s = this.surface(r); if (r.u16le() !== K.CAPROGRESSIVE) bad();
                const key = s.id + ':' + r.u32le(); pixel(r.u8()); const n = r.u32le();
                if (n !== r.remaining || !n) bad();
                const b = r.sub(n);
                // Tile state belongs to the SURFACE (Windows continues on a new context id with difference tiles and upgrades), so an
                // upgrade tile only needs an earlier Progressive PDU on this surface, not on this context id.
                this.progressive(b, s, s.progressiveSeen === true);
                if (!this.contexts.has(key) && this.contexts.size >= L.GFX_PROGRESSIVE_MAX_CONTEXTS) limit();
                this.contexts.add(key); s.progressiveSeen = true; break;
            }
            default: bad();
        }
        return null;
    }
    bitmap(codec, r, s, box) {
        // Structural headers only. Entropy streams and pixels are never decoded on the server.
        if (codec === K.UNCOMPRESSED) { if (r.remaining !== box.width * box.height * 4) bad(); r.skip(r.remaining); }
        else if (codec === K.CAVIDEO) {
            while (r.remaining) {
                const type = r.u16le(), n = r.u32le(); if (n < 6) bad();
                if (type === 0xCCC6 && n >= 9) { const b = r.sub(n - 6); b.u8(); if (b.u16le() > REGION_RECTS_MAX) limit(); b.skip(b.remaining); }     // WBT_REGION: numRects
                else { r.skip(n - 6); }
            }
        } else if (codec === K.CLEARCODEC) {
            if (!this.clear) this.clear = new ClearStructure(this.io);
            this.clear.validate(r, box);
        } else if (codec === K.ALPHA) {
            if (r.u16le() !== 0x414c) bad(); const compressed = r.u16le();
            const pixels = box.width * box.height;
            // Like FreeRDP and public/rdp/codecs/alpha.js: zero-length runs are valid, bytes after the last pixel are ignored.
            if (!compressed) { if (r.remaining < pixels) bad(); r.skip(r.remaining); }
            else {
                let count = 0;
                while (count < pixels) {
                    r.u8(); let run = r.u8();
                    if (run === 255) { run = r.u16le(); if (run === 65535) run = r.u32le(); }
                    if (run > pixels - count) bad(); count += run;
                }
                r.skip(r.remaining);
            }
        } else if (codec === K.AVC420) {
            this.avcStream(r, s, box);
        } else if (codec === K.AVC444 || codec === K.AVC444v2) {
            // RDPGFX_AVC444_BITMAP_STREAM (2.2.4.5; AVC444v2 is 2.2.4.6): u32 { cbAvc420EncodedBitstream1:30, LC:2 }, stream 1, and for LC 0 stream 2. Each
            // stream is an AVC420 bitstream. LC 0: both (stream 1 is cbAvc420EncodedBitstream1 bytes); 1: stream 1 only; 2: chroma stream only; 3: invalid.
            const info = r.u32le(), size = info & 0x3fffffff, lc = info >>> 30;
            if (lc === 3) bad();
            if (lc === 0) {
                if (size < 4 || size > r.remaining) bad();
                this.avcStream(r.sub(size), s, box);
                if (!r.remaining) bad();
            }
            this.avcStream(r, s, box);
        } else { r.need(1); r.skip(r.remaining); } // Planar stream, checked again by the browser decoder
    }
    // RDPGFX_AVC420_BITMAP_STREAM: metablock (regions inside the destination rectangle) and an Annex B stream, decoded by the browser
    avcStream(r, s, box) {
        const count = r.u32le(); if (count > Math.floor(r.remaining / 10)) bad();
        if (count > AVC_REGIONS_MAX) limit();
        for (let i = 0; i < count; i++) {
            const region = rect(r, s);
            if (region.x < box.x || region.y < box.y || region.x + region.width > box.x + box.width || region.y + region.height > box.y + box.height) bad();
        }
        r.skip(count * 2); r.need(4); r.skip(r.remaining);
    }
    progressive(r, surface, known) {
        // MS-RDPEGFX 2.2.4.2.1: inspect block and region envelopes, never tile entropy data.
        while (r.remaining) {
            const type = r.u16le(), length = r.u32le(); if (length < 6) bad();
            const b = r.sub(length - 6);
            if (type === 0xccc0 || type === 0xccc1) { if (length !== 12) bad(); b.skip(b.remaining); }
            else if (type === 0xccc2) { if (length !== 6) bad(); }
            else if (type === 0xccc3) { if (length !== 10) bad(); b.u8(); if (b.u16le() !== 64) bad(); b.u8(); }
            else if (type === 0xccc4) {
                if (b.u8() !== 64) bad(); const rects = b.u16le(), quant = b.u8(), progQuant = b.u8(); b.u8();
                const tiles = b.u16le(), tileBytes = b.u32le();
                if (!rects || quant > 7) bad();
                if (rects > REGION_RECTS_MAX) limit();
                for (let i = 0; i < rects; i++) {
                    const x = b.u16le(), y = b.u16le(), w = b.u16le(), h = b.u16le();
                    if (!w || !h || x + w > surface.width || y + h > surface.height) bad();
                }
                b.skip(quant * 5 + progQuant * 16);
                if (tileBytes !== b.remaining) bad();
                for (let i = 0; i < tiles; i++) {
                    const tileType = b.u16le(), tileLength = b.u32le();
                    if (tileType < 0xccc5 || tileType > 0xccc7 || tileLength < 6 || (tileType === 0xccc7 && !known)) bad();
                    const tile = b.sub(tileLength - 6);
                    for (let q = 0; q < 3; q++) if (tile.u8() >= quant) bad();
                    if (tile.u16le() * 64 >= surface.width || tile.u16le() * 64 >= surface.height) bad();
                    if (tileType !== 0xccc7) tile.u8(); // flags; entropy and diffing handled in browser
                    if (tileType !== 0xccc5) { const quality = tile.u8(); if (quality !== 255 && quality >= progQuant) bad(); }
                    let payloadBytes = 0;
                    for (let n = 0; n < (tileType === 0xccc7 ? 6 : 4); n++) payloadBytes += tile.u16le();
                    if (payloadBytes !== tile.remaining) bad();
                    tile.skip(payloadBytes);
                    known = true;
                }
            } else bad();
            b.expectEnd();
        }
    }
    gfxAck({ frameId, queueDepth, totalFramesDecoded }) {
        if (this.closed || !this.caps) return;
        for (const v of [frameId, queueDepth, totalFramesDecoded]) if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) bad();
        if (queueDepth === 0xffffffff) bad();
        this.send(packet(C.FRAMEACKNOWLEDGE, new Writer().u32le(queueDepth).u32le(frameId).u32le(totalFramesDecoded).toBytes()));
    }
    peerClose() {
        const confirmed = !!this.caps;
        this.close();
        if ((confirmed || this.restarted) && !this.canRestart()) throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 0x00000004, phase: 'session', hint: 'use-legacy' });
    }
    close() {
        if (this.closed) return; this.closed = true;
        for (const p of this.queue) p.result.release();
        this.queue = []; this.pendingBytes = 0;
        if (this.clear) { this.clear.close(); this.clear = null; }
        this.zgfx.close(); this.surfaces.clear(); this.contexts.clear(); this.cache.clear(); this.io.gfxChannel();
    }
}
module.exports = Object.freeze({ Graphics, AVC_REGIONS_MAX, REGION_RECTS_MAX });
