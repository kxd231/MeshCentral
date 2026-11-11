/**
* @description RemoteFX (MS-RDPRFX) message decoder: header blocks, frame, region and tile set to RGBA tiles
* @license Apache-2.0
*
* Used for legacy Set/Stream Surface Bits (rdp/WIRE.md 0x02) and for GFX WireToSurface1 CAVIDEO (0x0003).
* Message structure and tolerances follow FreeRDP libfreerdp/codec/rfx.c (Copyright 2011 Vic Lee, Marc-Andre Moreau
* and others; Apache-2.0): the four header blocks (sync, codec versions, channels, context) must have been seen before
* any frame block and may repeat; FRAME_BEGIN, REGION, TILESET, FRAME_END follow in that order; the entropy mode comes
* from the context block; a tile set without tiles is accepted; tiles are painted only inside the region rectangles
* (a region without rectangles means the whole channel), moved to the origin of the surface command and clipped to the
* output rectangle. The pixel pipeline (RLGR, differential LL3, dequantization, inverse DWT, ICT) is rfx-common.js.
*
* Every count and length is checked against the input and the limits before it is used. A tile that lies completely
* outside the visible area is parsed and bounds-checked but not decoded; a tile set that decodes more tiles than the
* visible area has (a repeated tile) is refused (CodecError 'LIMIT'), so the work of one message is bounded by its area.
* Regions are unioned into disjoint bands before tile intersections; on band overflow, intersections are bounded
* by one enclosing rectangle per tile (may also paint gaps inside that rectangle). Piece count, area and intersection work are capped
* across the entire decode call, including multiple frames. All tile headers and output limits of a tile set are checked
* before painting its first tile. Entropy/differential errors may still leave earlier, correctly decoded tiles painted.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('../shared/limits.js'), require('./errors.js'), require('./rfx-common.js'));
    } else {
        root.RdpCodecs = root.RdpCodecs || {};
        root.RdpCodecs.rfx = factory(root.RdpShared.limits, root.RdpCodecs.errors, root.RdpCodecs['rfx-common']);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, errors, common) {
    'use strict';
    const CodecError = errors.CodecError;

    // Block types (MS-RDPRFX 2.2.2.1)
    const WBT = Object.freeze({ SYNC: 0xCCC0, CODEC_VERSIONS: 0xCCC1, CHANNELS: 0xCCC2, CONTEXT: 0xCCC3, FRAME_BEGIN: 0xCCC4, FRAME_END: 0xCCC5, REGION: 0xCCC6, EXTENSION: 0xCCC7 });
    const CBT = Object.freeze({ REGION: 0xCAC1, TILESET: 0xCAC2, TILE: 0xCAC3 });
    const MAGIC = 0xCACCACCA, VERSION = 0x0100, TILE_SIZE = 0x40;
    const ENTROPY_RLGR1 = 1, ENTROPY_RLGR3 = 4;
    const H_SYNC = 1, H_VERSIONS = 2, H_CHANNELS = 4, H_CONTEXT = 8, H_ALL = 15;

    // Client-side limits (not in the wire contract), derived from the shared ones
    const TILES_MAX = Math.pow(Math.ceil(limits.SURFACE_MAX_DIM / common.TILE_DIM), 2);     // one tile set: every tile of the largest surface
    const RECTS_MAX = 4096;                                                                 // region rectangles of one frame
    const OPS_MAX = 16 * 1024 * 1024;                                                       // tiles x rectangles tested in one tile set
    const QUANT_TABLES_MAX = 255;                                                           // numQuant is a byte
    const TILE_HEADER_BYTES = 19;                                                           // CBT_TILE block: 6 + quant idx 3 + xIdx, yIdx, 3 lengths 10
    const STATE_BYTES = common.WORKSPACE_BYTES + (3 * RECTS_MAX * 4 * 4) + (QUANT_TABLES_MAX * common.QUANT_VALUES);

    function fail(code, what) { throw new CodecError(code, what); }
    const isInt = (n) => Number.isSafeInteger(n);

    class RfxDecoder {
        // deps: { budget: { reserve, release } } (optional in tests)
        constructor(deps) {
            this.budget = (deps && deps.budget) || null;
            this.closed = false;
            this.ws = null;                 // TileWorkspace, allocated on the first decode
            this.reserved = 0;
            this.rectsRaw = null;           // region rectangles as parsed: x0, y0, x1, y1 relative to the origin
            this.rectsClip = null;          // the same moved to the origin and clipped to the visible area
            this.pieces = null;             // visible pieces of one tile
            this.quant = null;              // numQuant x 10 values of the last tile set
            this.numQuant = 0;
            this.numRects = 0;
            this.headers = 0;               // H_* bits of the header blocks seen
            this.mode3 = false;             // RLGR3 (context entropy bits 4), otherwise RLGR1
            this.channelWidth = 0;
            this.channelHeight = 0;
            this.expect = WBT.FRAME_BEGIN;
            this.stats = { tiles: 0, tilesSkipped: 0, frames: 0 };
        }

        _ensure() {
            if (this.closed) { fail('INTERNAL', 'RemoteFX decoder is closed'); }
            if (this.ws !== null) { return; }
            if (this.budget) { this.budget.reserve(STATE_BYTES); }
            this.reserved = this.budget ? STATE_BYTES : 0;
            this.ws = new common.TileWorkspace();
            this.rectsRaw = new Int32Array(RECTS_MAX * 4);
            this.rectsClip = new Int32Array(RECTS_MAX * 4);
            this.pieces = new Int32Array(RECTS_MAX * 4);
            this.quant = new Uint8Array(QUANT_TABLES_MAX * common.QUANT_VALUES);
        }

        _release() {
            this.ws = this.rectsRaw = this.rectsClip = this.pieces = this.quant = null;
            if (this.reserved > 0) {
                const n = this.reserved;
                this.reserved = 0;
                try { this.budget.release(n); } catch (ex) { /* budget already reset */ }
            }
        }

        // RESETGRAPHICS / rdp-resize: frame state starts over, buffers are given back. Like FreeRDP's rfx_context_reset the header blocks
        // already seen stay valid (a server that does not repeat them after a resize keeps working).
        reset() {
            this.expect = WBT.FRAME_BEGIN;
            this.numRects = 0;
            this.numQuant = 0;
            this._release();
        }

        close() {
            this.reset();
            this.closed = true;
        }

        // Decodes src into dst (contract: public/rdp/codecs/README.md). rect: the surface command's rectangle, its top-left corner
        // is the origin of the RemoteFX coordinates; params.clip (default rect) limits the output. → { rects } written, dst coordinates.
        decode(src, rect, dst, params) {
            const v = this._validate(src, rect, dst, params);
            const rects = [];
            const data = dst.data, stride = dst.stride;
            const aligned = ((data.byteOffset & 3) === 0) && ((stride & 3) === 0) && common.LITTLE_ENDIAN;
            const dst32 = aligned ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2) : null;
            const self = this;
            this._run(src, rect.x, rect.y, v, function (tx, ty, px, py, pw, ph) {
                const x = tx + px, y = ty + py;
                if (dst32 !== null) {
                    const p32 = self.ws.pixels32;
                    for (let j = 0; j < ph; j++) {
                        const d = ((y + j) * (stride >>> 2)) + x, s = ((py + j) << 6) + px;
                        for (let i = 0; i < pw; i++) { dst32[d + i] = p32[s + i]; }
                    }
                } else {
                    const p8 = self.ws.pixels8;
                    for (let j = 0; j < ph; j++) {
                        const d = ((y + j) * stride) + (x * 4), s = (((py + j) << 6) + px) * 4;
                        for (let i = 0; i < pw * 4; i++) { data[d + i] = p8[s + i]; }
                    }
                }
                rects.push({ x: x, y: y, width: pw, height: ph });
            });
            return { rects: rects };
        }

        // The same decoding without a destination buffer: sink(tileX, tileY, px, py, pw, ph, pixels) is called for every visible piece
        // of a decoded tile, in dst coordinates: the tile starts at (tileX, tileY), the piece is the pw x ph block at (px, py) inside the
        // tile, `pixels` is the 64x64 RGBA tile (Uint8ClampedArray, rows of 256 bytes, alpha 255), valid during the call only.
        // bounds: { width, height } of the area the output coordinates live in (nothing is reported outside it).
        decodeToSink(src, rect, params, bounds, sink) {
            const v = this._validateSink(src, rect, params, bounds);
            const self = this;
            return this._run(src, rect.x, rect.y, v, function (tx, ty, px, py, pw, ph) { sink(tx, ty, px, py, pw, ph, self.ws.pixels8); });
        }

        _validate(src, rect, dst, params) {
            if (!dst || !isInt(dst.width) || !isInt(dst.height) || !isInt(dst.stride) || (dst.width < 1) || (dst.height < 1) ||
                (dst.width > limits.SURFACE_MAX_DIM) || (dst.height > limits.SURFACE_MAX_DIM) || (dst.stride < dst.width * 4)) { fail('LIMIT', 'destination'); }
            if (!(dst.data instanceof Uint8Array) && !(dst.data instanceof Uint8ClampedArray)) { fail('INVALID', 'destination data'); }
            if (dst.data.length < dst.stride * dst.height) { fail('LIMIT', 'destination size'); }
            if (src instanceof Uint8Array && src.buffer === dst.data.buffer && src.byteOffset < dst.data.byteOffset + dst.data.byteLength &&
                dst.data.byteOffset < src.byteOffset + src.byteLength) { fail('INVALID', 'source overlaps destination'); }
            return this._validateSink(src, rect, params, dst);
        }

        // → visible area { x0, y0, x1, y1 } = clip within bounds
        _validateSink(src, rect, params, bounds) {
            if (!(src instanceof Uint8Array)) { fail('INVALID', 'source'); }
            if (!rect || !isInt(rect.x) || !isInt(rect.y) || !isInt(rect.width) || !isInt(rect.height) || (rect.width < 1) || (rect.height < 1) ||
                (rect.x < 0) || (rect.y < 0) || (rect.x + rect.width > bounds.width) || (rect.y + rect.height > bounds.height)) { fail('LIMIT', 'rectangle'); }
            const c = (params && params.clip) ? params.clip : rect;
            if (!isInt(c.x) || !isInt(c.y) || !isInt(c.width) || !isInt(c.height) || (c.width < 1) || (c.height < 1)) { fail('INVALID', 'clip'); }
            const x0 = Math.max(c.x, 0), y0 = Math.max(c.y, 0), x1 = Math.min(c.x + c.width, bounds.width), y1 = Math.min(c.y + c.height, bounds.height);
            return { x0: x0, y0: y0, x1: x1, y1: y1 };
        }

        // ---- message ----------------------------------------------------------------------------------------------
        _run(src, ox, oy, v, emit) {
            this._ensure();
            const tilesAllowed = (Math.ceil(Math.max(0, v.x1 - v.x0) / common.TILE_DIM) + 1) * (Math.ceil(Math.max(0, v.y1 - v.y0) / common.TILE_DIM) + 1);
            const work = { checks: 0, tiles: 0, pieces: 0, area: 0, tilesAllowed: tilesAllowed, piecesMax: 4 * tilesAllowed + 4 * RECTS_MAX };
            try {
                let pos = 0;
                const end = src.length;
                while (end - pos > 6) {
                    const type = src[pos] | (src[pos + 1] << 8);
                    const len = (src[pos + 2] | (src[pos + 3] << 8) | (src[pos + 4] << 16) | (src[pos + 5] << 24)) >>> 0;
                    if (len < 6) { fail('INVALID', 'block length'); }
                    if (len > end - pos) { fail('TRUNCATED', 'block'); }
                    if ((type > WBT.CONTEXT) && (this.headers !== H_ALL)) { fail('INVALID', 'frame block before the header blocks'); }
                    let body = pos + 6;
                    const bodyEnd = pos + len;
                    if ((type >= WBT.CONTEXT) && (type <= WBT.EXTENSION)) {
                        // RFX_CODEC_CHANNELT: codecId 1, channelId 0xFF for the context and 0 for the rest
                        if (bodyEnd - body < 2) { fail('TRUNCATED', 'codec channel'); }
                        if (src[body] !== 1) { fail('INVALID', 'codec id'); }
                        if (src[body + 1] !== ((type === WBT.CONTEXT) ? 0xFF : 0)) { fail('INVALID', 'channel id'); }
                        body += 2;
                    }
                    switch (type) {
                        case WBT.SYNC: this._sync(src, body, bodyEnd); break;
                        case WBT.CODEC_VERSIONS: this._versions(src, body, bodyEnd); break;
                        case WBT.CHANNELS: this._channels(src, body, bodyEnd); break;
                        case WBT.CONTEXT: this._context(src, body, bodyEnd); break;
                        case WBT.FRAME_BEGIN: this._frameBegin(src, body, bodyEnd); break;
                        case WBT.REGION: this._region(src, body, bodyEnd); break;
                        case WBT.EXTENSION: this._tileset(src, body, bodyEnd, ox, oy, v, emit, work); break;
                        case WBT.FRAME_END: this._frameEnd(); break;
                        default: fail('INVALID', 'block type');
                    }
                    pos = bodyEnd;
                }
            } catch (ex) {
                this.expect = WBT.FRAME_BEGIN;
                throw errors.toCodecError(ex);
            }
        }

        _sync(src, p, end) {
            this.headers &= ~H_SYNC;
            if (end - p < 6) { fail('TRUNCATED', 'sync'); }
            const magic = ((src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0);
            if (magic !== MAGIC) { fail('INVALID', 'sync magic'); }
            if ((src[p + 4] | (src[p + 5] << 8)) !== VERSION) { fail('INVALID', 'sync version'); }
            this.headers |= H_SYNC;
        }

        _versions(src, p, end) {
            this.headers &= ~H_VERSIONS;
            if (end - p < 4) { fail('TRUNCATED', 'codec versions'); }
            if (src[p] !== 1) { fail('INVALID', 'number of codecs'); }
            if (src[p + 1] !== 1) { fail('INVALID', 'codec id'); }
            if ((src[p + 2] | (src[p + 3] << 8)) !== VERSION) { fail('INVALID', 'codec version'); }
            this.headers |= H_VERSIONS;
        }

        _channels(src, p, end) {
            this.headers &= ~H_CHANNELS;
            if (end - p < 1) { fail('TRUNCATED', 'channels'); }
            const n = src[p];
            if (n < 1) { fail('INVALID', 'no channels'); }
            if (end - p - 1 < n * 5) { fail('TRUNCATED', 'channel list'); }
            // Only the first channel is used (several are virtual monitors of RDVH sessions)
            if (src[p + 1] !== 0) { fail('INVALID', 'channel id'); }
            const w = src[p + 2] | (src[p + 3] << 8), h = src[p + 4] | (src[p + 5] << 8);
            if (w === 0 || h === 0) { fail('INVALID', 'channel size'); }
            this.channelWidth = w;
            this.channelHeight = h;
            this.headers |= H_CHANNELS;
        }

        _context(src, p, end) {
            this.headers &= ~H_CONTEXT;
            if (end - p < 5) { fail('TRUNCATED', 'context'); }
            // ctxId (p), tileSize (p + 1), properties (p + 3)
            if ((src[p + 1] | (src[p + 2] << 8)) !== TILE_SIZE) { fail('INVALID', 'tile size'); }
            const entropy = (((src[p + 3] | (src[p + 4] << 8)) & 0x1E00) >> 9);
            if (entropy === ENTROPY_RLGR1) { this.mode3 = false; }
            else if (entropy === ENTROPY_RLGR3) { this.mode3 = true; }
            else { fail('INVALID', 'entropy algorithm'); }
            this.headers |= H_CONTEXT;
        }

        _frameBegin(src, p, end) {
            if (this.expect !== WBT.FRAME_BEGIN) { fail('INVALID', 'unexpected FRAME_BEGIN'); }
            this.expect = WBT.REGION;
            if (end - p < 6) { fail('TRUNCATED', 'frame begin'); }
        }

        _frameEnd() {
            if (this.expect !== WBT.FRAME_END) { fail('INVALID', 'unexpected FRAME_END'); }
            this.expect = WBT.FRAME_BEGIN;
            this.stats.frames++;
        }

        _region(src, p, end) {
            if (this.expect !== WBT.REGION) { fail('INVALID', 'unexpected REGION'); }
            this.expect = WBT.EXTENSION;
            if (end - p < 3) { fail('TRUNCATED', 'region'); }
            const n = src[p + 1] | (src[p + 2] << 8);
            p += 3;
            if (n === 0) {
                // No rectangle: the whole channel (MS-RDPRFX 2.2.2.3.3)
                this.numRects = 1;
                this.rectsRaw[0] = 0; this.rectsRaw[1] = 0; this.rectsRaw[2] = this.channelWidth; this.rectsRaw[3] = this.channelHeight;
                return;
            }
            if (n > RECTS_MAX) { fail('LIMIT', 'region rectangles'); }
            if (end - p < n * 8) { fail('TRUNCATED', 'region rectangles'); }
            for (let i = 0; i < n; i++, p += 8) {
                const x = src[p] | (src[p + 1] << 8), y = src[p + 2] | (src[p + 3] << 8);
                const w = src[p + 4] | (src[p + 5] << 8), h = src[p + 6] | (src[p + 7] << 8);
                this.rectsRaw[i * 4] = x; this.rectsRaw[(i * 4) + 1] = y; this.rectsRaw[(i * 4) + 2] = x + w; this.rectsRaw[(i * 4) + 3] = y + h;
            }
            this.numRects = n;
            if (end - p < 4) { fail('TRUNCATED', 'region tail'); }
            // regionType is only logged by FreeRDP; exactly one tile set follows
            if ((src[p + 2] | (src[p + 3] << 8)) !== 1) { fail('INVALID', 'number of tile sets'); }
        }

        // Sweep horizontal bands, merging touching/overlapping x intervals, then coalesce identical adjacent bands.
        // This is the disjoint-region representation used by FreeRDP region16 (Apache-2.0), implemented here independently.
        // Input is rectsClip; rectsRaw is scratch output. All temporary arrays are bounded by RECTS_MAX.
        // Return -1 on fragmentation overflow, leaving rectsClip intact for per-tile bounding rectangles.
        _unionRegion(n, work) {
            if (n < 2) { return n; }
            const rc = this.rectsClip, out = this.rectsRaw, band = this.pieces;
            const order = Array.from({ length: n }, (_, i) => i * 4).sort((a, b) => rc[a] - rc[b]);
            const ys = Array.from(new Set(order.flatMap((i) => [rc[i + 1], rc[i + 3]]))).sort((a, b) => a - b);
            let count = 0, prevAt = 0, prevCount = 0;
            for (let y = 0; y + 1 < ys.length; y++) {
                const y0 = ys[y], y1 = ys[y + 1];
                let nb = 0;
                for (const i of order) {
                    if (++work.checks > OPS_MAX) { fail('LIMIT', 'region union work'); }
                    if (rc[i + 1] > y0 || rc[i + 3] < y1) { continue; }
                    if (nb && rc[i] <= band[(nb - 1) * 4 + 2]) {
                        band[(nb - 1) * 4 + 2] = Math.max(band[(nb - 1) * 4 + 2], rc[i + 2]);
                    } else {
                        const b = nb++ * 4;
                        band[b] = rc[i]; band[b + 1] = y0; band[b + 2] = rc[i + 2]; band[b + 3] = y1;
                    }
                }
                let same = nb > 0 && nb === prevCount;
                for (let i = 0; same && i < nb; i++) {
                    const a = (prevAt + i) * 4, b = i * 4;
                    same = out[a] === band[b] && out[a + 2] === band[b + 2] && out[a + 3] === y0;
                }
                if (same) {
                    for (let i = 0; i < nb; i++) { out[(prevAt + i) * 4 + 3] = y1; }
                } else {
                    if (count + nb > RECTS_MAX) { return -1; }
                    prevAt = count; prevCount = nb;
                    out.set(band.subarray(0, nb * 4), count * 4);
                    count += nb;
                }
            }
            rc.set(out.subarray(0, count * 4));
            return count;
        }

        _tileset(src, p, end, ox, oy, v, emit, work) {
            if (this.expect !== WBT.EXTENSION) { fail('INVALID', 'unexpected tile set'); }
            this.expect = WBT.FRAME_END;
            if (end - p < 14) { fail('TRUNCATED', 'tile set'); }
            if ((src[p] | (src[p + 1] << 8)) !== CBT.TILESET) { fail('INVALID', 'tile set subtype'); }
            const props = src[p + 4] | (src[p + 5] << 8);
            const numQuant = src[p + 6];
            if (numQuant < 1) { fail('INVALID', 'no quantization table'); }
            if (src[p + 7] !== TILE_SIZE) { fail('INVALID', 'tile size'); }
            const numTiles = src[p + 8] | (src[p + 9] << 8);
            if (numTiles < 1) { return; }           // Windows Server 2012 sends empty tile sets
            const dataSize = (src[p + 10] | (src[p + 11] << 8) | (src[p + 12] << 16) | (src[p + 13] << 24)) >>> 0;
            p += 14;
            if (numTiles > TILES_MAX) { fail('LIMIT', 'tiles'); }
            if (end - p < numQuant * 5) { fail('TRUNCATED', 'quantization tables'); }
            if (end - p - (numQuant * 5) < dataSize) { fail('TRUNCATED', 'tile data'); }
            if (numTiles * this.numRects > OPS_MAX) { fail('LIMIT', 'tiles x rectangles'); }
            // The entropy mode of the context applies; a tile set that names another one is inconsistent
            const et = (props >> 10) & 15;
            if (((et === ENTROPY_RLGR1) && this.mode3) || ((et === ENTROPY_RLGR3) && !this.mode3)) { fail('INVALID', 'tile set entropy differs from the context'); }
            const q = this.quant;
            for (let i = 0; i < numQuant; i++, p += 5) {
                for (let j = 0; j < 5; j++) {
                    q[(i * 10) + (j * 2)] = src[p + j] & 15;
                    q[(i * 10) + (j * 2) + 1] = src[p + j] >> 4;
                }
            }
            this.numQuant = numQuant;

            // Region rectangles in output coordinates, clipped to the visible area; empty ones are dropped
            const raw = this.rectsRaw, rc = this.rectsClip;
            let nr = 0;
            for (let i = 0; i < this.numRects; i++) {
                const x0 = Math.max(ox + raw[i * 4], v.x0), y0 = Math.max(oy + raw[(i * 4) + 1], v.y0);
                const x1 = Math.min(ox + raw[(i * 4) + 2], v.x1), y1 = Math.min(oy + raw[(i * 4) + 3], v.y1);
                if (x1 > x0 && y1 > y0) { rc[nr * 4] = x0; rc[(nr * 4) + 1] = y0; rc[(nr * 4) + 2] = x1; rc[(nr * 4) + 3] = y1; nr++; }
            }
            const unionCount = this._unionRegion(nr, work);
            const mergePerTile = unionCount < 0;
            if (!mergePerTile) { nr = unionCount; }
            if (numTiles * nr > OPS_MAX - work.checks) { fail('LIMIT', 'tiles x union rectangles'); }
            work.checks += numTiles * nr;

            // A tile set of a conforming encoder holds each tile of the visible area once: more decoded tiles than the area has is a
            // decompression bomb (the same tile repeated), not a picture
            const tilesStart = p;
            // MS-RDPRFX 2.2.2.3.4 describes tilesDataSize as the encoded field size, but does not
            // require a decoder rejection on mismatch. Like FreeRDP rfx.c, bound each tile by the
            // enclosing block; an understated size must not truncate otherwise complete tiles.
            const ws = this.ws, pieces = this.pieces, mode3 = this.mode3;
            // Pass 0 validates every header, referenced quant and the full output budget. Pass 1 decodes and paints.
            for (let pass = 0; pass < 2; pass++) {
                p = tilesStart;
                for (let t = 0; t < numTiles; t++) {
                    if (end - p < 6) { fail('TRUNCATED', 'tile header'); }
                    if ((src[p] | (src[p + 1] << 8)) !== CBT.TILE) { fail('INVALID', 'tile block type'); }
                    const blockLen = (src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16) | (src[p + 5] << 24)) >>> 0;
                    if (blockLen < TILE_HEADER_BYTES) { fail('INVALID', 'tile length'); }
                    if (blockLen > end - p) { fail('TRUNCATED', 'tile'); }
                    const qY = src[p + 6], qCb = src[p + 7], qCr = src[p + 8];
                    if (qY >= numQuant || qCb >= numQuant || qCr >= numQuant) { fail('INVALID', 'quantization index'); }
                    if (pass === 0) {
                        for (const qi of [qY, qCb, qCr]) {
                            for (let j = 0; j < 10; j++) { if (q[qi * 10 + j] < 1) { fail('INVALID', 'quantization value'); } }
                        }
                    }
                    const xIdx = src[p + 9] | (src[p + 10] << 8), yIdx = src[p + 11] | (src[p + 12] << 8);
                    const yLen = src[p + 13] | (src[p + 14] << 8), cbLen = src[p + 15] | (src[p + 16] << 8), crLen = src[p + 17] | (src[p + 18] << 8);
                    if (TILE_HEADER_BYTES + yLen + cbLen + crLen > blockLen) { fail('INVALID', 'tile component lengths'); }
                    if (yLen === 0 || cbLen === 0 || crLen === 0) { fail('INVALID', 'empty tile component'); }
                    const yAt = p + TILE_HEADER_BYTES, cbAt = yAt + yLen, crAt = cbAt + cbLen;
                    p += blockLen;

                    // Pieces of the tile inside the region
                    const tx = ox + (xIdx * common.TILE_DIM), ty = oy + (yIdx * common.TILE_DIM);
                    const vx0 = Math.max(tx, v.x0), vy0 = Math.max(ty, v.y0), vx1 = Math.min(tx + common.TILE_DIM, v.x1), vy1 = Math.min(ty + common.TILE_DIM, v.y1);
                    let np = 0;
                    if (vx1 > vx0 && vy1 > vy0) {
                        for (let i = 0; i < nr; i++) {
                            const x0 = Math.max(rc[i * 4], vx0), y0 = Math.max(rc[(i * 4) + 1], vy0), x1 = Math.min(rc[(i * 4) + 2], vx1), y1 = Math.min(rc[(i * 4) + 3], vy1);
                            if (x1 > x0 && y1 > y0) {
                                if (x0 === vx0 && y0 === vy0 && x1 === vx1 && y1 === vy1) { np = 0; pieces[0] = x0; pieces[1] = y0; pieces[2] = x1; pieces[3] = y1; np = 1; break; }
                                if (mergePerTile && np) {
                                    pieces[0] = Math.min(pieces[0], x0); pieces[1] = Math.min(pieces[1], y0);
                                    pieces[2] = Math.max(pieces[2], x1); pieces[3] = Math.max(pieces[3], y1);
                                } else {
                                    pieces[np * 4] = x0; pieces[(np * 4) + 1] = y0; pieces[(np * 4) + 2] = x1; pieces[(np * 4) + 3] = y1; np++;
                                }
                            }
                        }
                    }
                    if (pass === 0) {
                        if (np && ++work.tiles > work.tilesAllowed) { fail('LIMIT', 'more tiles than the area holds'); }
                        work.pieces += np;
                        for (let i = 0; i < np; i++) { work.area += (pieces[i * 4 + 2] - pieces[i * 4]) * (pieces[i * 4 + 3] - pieces[i * 4 + 1]); }
                        if (work.pieces > work.piecesMax || work.area > work.tilesAllowed * common.TILE_COEFFS) { fail('LIMIT', 'message pieces or piece area'); }
                        continue;
                    }
                    if (np === 0) { this.stats.tilesSkipped++; continue; }

                    ws.load(src, yAt, yLen); common.decodeComponent(ws, ws.y, mode3, q, qY * 10);
                    ws.load(src, cbAt, cbLen); common.decodeComponent(ws, ws.cb, mode3, q, qCb * 10);
                    ws.load(src, crAt, crLen); common.decodeComponent(ws, ws.cr, mode3, q, qCr * 10);
                    common.ycbcrToRgba(ws);
                    this.stats.tiles++;
                    for (let i = 0; i < np; i++) {
                        const x0 = pieces[i * 4], y0 = pieces[(i * 4) + 1];
                        emit(tx, ty, x0 - tx, y0 - ty, pieces[(i * 4) + 2] - x0, pieces[(i * 4) + 3] - y0);
                    }
                }
            }
        }
    }

    // Self-test for infos.options.browser.rfx: one solid 64x64 tile (30, 144, 255), RLGR1, produced by the FreeRDP encoder
    // (Apache-2.0), must decode to that colour.
    const PROBE_HEX = 'c0cc0c000000caacccca0001c3cc0d00000001ff0040002822c1cc0a00000001010001c2cc0c000000010040004000c4cc0e0000000100000000000100c6cc1700000001000101000000000040004000c1ca0100c7cc4b0000000100c2ca0000514401400100300000006666778898c3ca300000000000000000000006000c000b0000001f1391f800001f11fffffffff23f000000001f13fffffffec7e000c5cc080000000100';
    function probe() {
        const src = new Uint8Array(PROBE_HEX.length / 2);
        for (let i = 0; i < src.length; i++) { src[i] = parseInt(PROBE_HEX.substr(i * 2, 2), 16); }
        const d = new RfxDecoder({});
        try {
            const dst = { data: new Uint8ClampedArray(64 * 64 * 4), stride: 256, width: 64, height: 64 };
            const rect = { x: 0, y: 0, width: 64, height: 64 };
            d.decode(src, rect, dst, { clip: rect });
            for (const p of [0, 2080, 4095]) {
                const o = p * 4;
                if ((Math.abs(dst.data[o] - 30) > 1) || (Math.abs(dst.data[o + 1] - 144) > 1) || (Math.abs(dst.data[o + 2] - 255) > 1) || (dst.data[o + 3] !== 255)) { return false; }
            }
            return true;
        } catch (ex) {
            return false;
        } finally {
            d.close();
        }
    }

    return Object.freeze({ RfxDecoder: RfxDecoder, probe: probe, WBT: WBT, CBT: CBT, TILES_MAX: TILES_MAX, RECTS_MAX: RECTS_MAX, STATE_BYTES: STATE_BYTES });
});
