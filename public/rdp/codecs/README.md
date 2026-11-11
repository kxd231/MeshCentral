# Web-RDP decoders: interface contract

Interface contract: change the code and this document together.
License of every file in `public/rdp/`: Apache-2.0. No code copied from GPL sources; code ported
from FreeRDP or IronRDP carries an attribution comment with the original license.

## Environment

- Plain JavaScript (ES2020), no DOM, no `window`, no `document`, no imports. Each file is a UMD
  module: `module.exports = <exports>` under Node (unit tests, benchmarks), and
  `self.RdpCodecs.<name> = <exports>` under `importScripts()` in the worker. `<name>` is the file
  name without `.js`. The UMD wrapper is the one used by `public/rdp/shared/*.js`.
- Limits come from `RdpShared.limits` (`public/rdp/shared/limits.js`), never hard-coded.
- No global mutable state. Everything stateful lives in an instance.
- A decoder keeps no reference to `src` or `dst` after a call returns (it copies what it caches).

## Common types

```js
src  : Uint8Array                       // encoded data, exactly the codec payload
rect : { x, y, width, height }          // destination in dst coordinates (surface for GFX,
                                        //   desktop for legacy), integers, width/height ≥ 1
dst  : { data: Uint8ClampedArray | Uint8Array,   // RGBA8888, not premultiplied, rows top-down
         stride,                        // bytes per row, ≥ width * 4
         width, height }                // dst size in pixels; data.length ≥ stride * height
budget : { reserve(bytes), release(bytes) }       // worker-wide BROWSER_CODEC_STATE_MAX_BYTES;
                                        //   reserve() throws CodecError('LIMIT') when exhausted
```

The caller has checked that `rect` lies inside `dst`; the decoder checks again and throws `LIMIT`
if not. Opaque codecs write alpha 255; codecs with alpha write it as decoded. A decoder never
allocates a buffer whose size comes from the input without checking it against a limit first, and
reserves every buffer it **retains** between calls through `budget` (released in `reset`/`close`).
Temporary buffers inside one call are bounded by `rect` size and need no reservation.
Outside the decoders the worker bounds the remaining browser memory: surfaces by
`SURFACES_MAX_PIXELS` (canvas and RGBA storage), the GFX cache by `GFX_CACHE_MAX_BYTES`, VideoFrames
by `AVC_MAX_PENDING_FRAMES`, encoded data by `BROWSER_PENDING_MAX_BYTES`.

## Exports

| File | Exports | Instance scope |
|---|---|---|
| `interleaved.js` | `decode(src, rect, dst, params)`, `decodeRaw(src, rect, dst, params)` | stateless |
| `planar.js` | `decode(src, rect, dst, params)` | stateless |
| `nsc.js` | `decode(src, rect, dst, params)` | stateless |
| `alpha.js` | `decode(src, rect, dst, params)` (writes only the alpha channel) | stateless |
| `clear.js` | `class ClearCodec { constructor({ budget }); decode(src, rect, dst, params); reset(); close() }` | one per session; caches persist across surfaces; `reset()` on RESETGRAPHICS |
| `rfx.js` | `class RfxDecoder { constructor({ budget }); decode(src, rect, dst, params) → { rects }; decodeToSink(src, rect, params, bounds, sink); reset(); close() }`, `probe() → bool` | one per session and mode (GFX, legacy surface bits); `reset()` on RESETGRAPHICS / `rdp-resize` |
| `rfx-common.js` | RLGR1/RLGR3, sub-band layout, dequantization, inverse DWT 5/3, YCbCr → RGBA of one 64x64 tile (`TileWorkspace`); shared with `progressive.js` | stateless functions over a caller-owned `TileWorkspace`; registered as `self.RdpCodecs['rfx-common']` |
| `progressive.js` | `class ProgressiveContext { constructor({ budget, surfaceWidth, surfaceHeight }); decode(src, dst, params) → { rects }; close() }` | **one per surface** (created on its first WireToSurface2), holds the progressive tile state of the surface; closed on DELETESURFACE (and `close()` of the session). Encoding context ids (`codecContextId`) are bookkeeping of the owner only: it checks that DELETEENCODINGCONTEXT names a live id, bounds the live ids by `GFX_PROGRESSIVE_MAX_CONTEXTS`, and **DELETEENCODINGCONTEXT does not drop tile state** (Windows 10 deletes a context after 1-3 PDUs and continues on the next id without SYNC/CONTEXT, its difference tiles add to the state of earlier contexts; FreeRDP behaves the same) |
| `avc420.js` | `class Avc420Decoder` (below), `Avc420Decoder.probe()` | one per surface |
| `avc444.js` | `class Avc444Decoder` (below), `Avc444Decoder.probe()`, `Yuv444Planes`, `parsePayload` | one per surface and chroma layout, on the surface's one `Avc420Decoder` |
| `avc444-simd.js` | `create({ pw, ph, scratchBytes, outBytes }) → kernel \| null`, `available()` (optional accelerator of `avc444.js`, below) | one kernel (one WebAssembly memory) per `Yuv444Planes` |
| `errors.js` | `CODES`, `CodecError`, `toCodecError` (contract file) | — |

`params`:

| Function | `params` |
|---|---|
| `interleaved.decode` | `{ bpp: 15 \| 16 \| 24, bitmapWidth, bitmapHeight }` |
| `interleaved.decodeRaw` | `{ bpp: 15 \| 16 \| 24 \| 32, bitmapWidth, bitmapHeight, bottomUp: bool }` |
| `planar.decode` | `{ bitmapWidth, bitmapHeight, bottomUp: bool, opaque: bool }` (both flags required; alpha plane presence from the planar header) |
| `nsc.decode` | `{ bitmapWidth, bitmapHeight }`: encoded image size (SURFACE_BITS `width`/`height`, or `rect` size in GFX); writes the top-left `rect` part |
| `alpha.decode` | `{ }` (image size = `rect`) |
| `ClearCodec.decode` | `{ }` (image size = `rect`) |
| `RfxDecoder.decode` | `{ clip: { x, y, width, height } }`: output limited to this rectangle (target rect of the surface command or the surface); `rect` is the surface command's rectangle whose top-left corner is the origin of the RemoteFX coordinates |
| `ProgressiveContext.decode` | `{ frameId }`: the GFX frame (StartFrame) of the PDU; tiles are positioned in surface coordinates, clipped to the surface and to the region rectangles. PDUs of one frame share their updated tiles: a later PDU of the frame paints the tiles of the earlier ones inside its own region rectangles (Windows splits a frame's update this way) |

Legacy bitmaps: the encoded image is `bitmapWidth × bitmapHeight` (row padding included); the
decoder decodes it and writes only the top-left `rect.width × rect.height` part at `rect.x, rect.y`.

Planar `bottomUp` means source rows are bottom-up: composition indexes source row
`bitmapHeight - 1 - y` before cropping, without an additional flip buffer. `opaque` forces
alpha 255 even when an alpha plane exists (the plane is still decoded and validated).
Legacy desktop calls use `{ bottomUp: true, opaque: true }` (FreeRDP graphics vFlip=TRUE);
GFX calls use `{ bottomUp: false, opaque: false }` to preserve stream orientation and alpha.

`{ rects }`: the rectangles actually written, in `dst` coordinates, used for composition.

`RfxDecoder.decodeToSink(src, rect, params, bounds, sink)` is `decode` without a destination buffer (the legacy worker paints
straight from the decoder's tile buffer, no desktop-sized scratch): `bounds` is `{ width, height }` of the coordinate space and
`sink(tileX, tileY, px, py, pw, ph, pixels)` is called for every visible piece of a decoded tile (the tile starts at
`tileX, tileY`; the piece is the `pw × ph` block at `px, py` inside the tile; `pixels` is the 64×64 RGBA tile, rows of 256 bytes,
alpha 255, valid during the call only). `RfxDecoder.probe()` decodes a built-in message and returns whether the result is right
(`infos.options.browser.rfx`, rdp/WIRE.md).

## AVC420 (asynchronous)

`avc420.js` wraps WebCodecs `VideoDecoder`; it is the only asynchronous codec.

```js
const d = new Avc420Decoder({ budget });
d.submit(src, ctx) → Promise<null | { frame, regions, quality }>
  // src: RDPGFX_AVC420_BITMAP_STREAM (metablock + H.264 Annex B)
  // ctx: { surfaceWidth, surfaceHeight, destRect: { x, y, width, height } }   (from WireToSurface1)
  // frame: VideoFrame whose visible area maps 1:1 onto destRect
  // regions: [{ x, y, width, height }] in surface coordinates, each inside destRect (from the metablock)
  // quality: [{ qp, qualityVal, progressive }] one per region
d.reset();   // DELETESURFACE / session teardown: VideoDecoder.reset(); pending promises resolve to null (RESETGRAPHICS does not reset decoders: rdp/GFX-CAPS.md)
d.close();   // as reset, then VideoDecoder.close(); later submit() throws CodecError('INTERNAL')
Avc420Decoder.probe() → Promise<{ ok: bool, decodeMs: number }>
```

- `submit` validates the metablock (region count bounded by `src` length, regions inside `destRect`
  and the surface) and the SPS before configuring: coded size ≥ `destRect` and ≤ `destRect` rounded
  up to 16, ≤ `SURFACE_MAX_DIM`. The codec string (`avc1.PPCCLL`) is derived from the SPS; the decoder
  is (re)configured on the first IDR and when the SPS changes, with `optimizeForLatency: true`.
- At most `AVC_MAX_PENDING_FRAMES` submissions may be unresolved or resolved with an unclosed
  frame; `submit` beyond that throws `CodecError('LIMIT')`.
- Results resolve in submit order. The worker awaits each result before applying later operations
  that touch the same surface, so asynchronous decoding never reorders drawing.
- The caller draws only `regions` from `frame` and then calls `frame.close()` exactly once, also on
  error paths. Frames that arrive after `reset`/`close` are closed by the decoder itself.
- Decode errors reject with `CodecError('INVALID' | 'UNSUPPORTED')`.
- `probe()` decodes a built-in IDR frame and measures the time; its result is
  `infos.options.browser.h264` (rdp/WIRE.md). `isConfigSupported()` alone is not enough.

## AVC444 / AVC444v2 (asynchronous)

`avc444.js` decodes RDPGFX_AVC444_BITMAP_STREAM (MS-RDPEGFX 2.2.4.5, codecId 000E AVC444; AVC444v2 000F is 2.2.4.6) and rebuilds YUV444
per 3.3.8.3.2 / 3.3.8.3.3. The two views (main/luma and auxiliary/chroma) are **one H.264 stream**: "These bitstreams MUST be encoded using
the same MPEG-4 AVC/H.264 encoder and decoded by a single MPEG-4 AVC/H.264 decoder as one stream" (2.2.4.5). One `Avc420Decoder` per surface
decodes them (luma chunk, then chroma chunk, outputs matched by timestamp); the same decoder also decodes the AVC420 pictures of the surface.

```js
const shared = new Avc420Decoder({ budget, hardwareAcceleration: 'prefer-software' });   // one per surface, owned by the caller
const d = new Avc444Decoder({ budget, codecId, decoder: shared, simd });  // codecId 0x0E (AVC444, chroma layout v1) or 0x0F (AVC444v2); without `decoder` it makes its own; `simd`: the avc444-simd.js module (optional)
d.submit(src, ctx) → Promise<null | { regions, combine(), toRgba(box, out), close() }>   // ctx as for Avc420Decoder.submit; null after reset/close
  // src: the AVC444 payload: u32 (bits 0..29 cbAvc420EncodedBitstream1, bits 30..31 LC), RDPGFX_AVC420_BITMAP_STREAM
  //      (stream 1; for LC 0 exactly cbAvc420EncodedBitstream1 bytes), and for LC 0 a second RDPGFX_AVC420_BITMAP_STREAM.
  //      The spec wants cbAvc420EncodedBitstream1 = 0 for LC 2; like FreeRDP it is not used for LC 1 and 2 (the rest is the stream)
  // regions: [{ x, y, width, height }] surface coordinates: the regions of the received views (a list, overlaps allowed), each inside destRect
result.combine() → Promise<void>   // reads the rows of the decoded views the regions need into the decoder's YUV444 planes, closes the VideoFrames
result.toRgba(box, out) → Uint8ClampedArray   // box inside destRect, surface coordinates; RGBA (alpha 255), tight rows; `out` (optional, >= width * height * 4) is reused.
  // With `result.zeroCopy === true` (the kernels run) `out` may be null: the result is then a view of the kernel's band region, valid until the next toRgba() / combine() of the decoder.
  // That view lives on a `WebAssembly.Memory` buffer: it cannot be transferred or detached (postMessage transfer would fail), and the caller must copy it synchronously (e.g. into the surface) before the next call
result.close()                     // idempotent; closes unclosed VideoFrames, returns the pending slots
d.reset(); d.close();              // a shared decoder is reset / closed by its owner; planes and buffers are released by close()
Avc444Decoder.probe() → Promise<{ ok: bool, decodeMs: number }>
```

Exports: `Avc444Decoder`, `Yuv444Planes` (combine and conversion without VideoFrames: `new Yuv444Planes(width, height, { simd })`, `applyLuma` (→ the rectangles written), `applyChromaV1`, `applyChromaV2`, `toRgba(box, dx, dy, out, flat)`, `bandOf`), `parsePayload`, `readView`, `PROBE`.

`avc444-simd.js` is an optional accelerator (WebAssembly SIMD, source `tools/avc444-simd/avc444-simd.c`, built by `tools/avc444-simd/build.sh`, embedded as base64). `Yuv444Planes` given the module keeps its planes in a WebAssembly memory
(with a region the decoded views are read into and a 4 MiB region for RGBA bands) and runs the luma combine, the AVC444v2 chroma combine and `toRgba` there, 16 samples at a time. The bytes are exactly those of the JavaScript path
(tests: random planes, all 2^24 Y/U/V values, the reverse filter, partial regions, every origin parity) and the module checks itself against the JavaScript path once before first use; without WebAssembly SIMD, with a failed self test or for a surface of more than 4096 x 2304 pixels (a pixel count: 8192 x 1152 still qualifies) the JavaScript path runs. The embedded module's provenance (`provenance.sha256`, `provenance.toolchain`) is checked by `tools/avc444-simd/build.sh --check`.
`toRgba(..., flat = true)` (LC 1: the luma view was just combined over the box and nothing else) skips the reverse filter, which cannot change a block whose four chroma samples are equal.

- LC 0: luma view in stream 1, chroma view in stream 2. LC 1: luma view only. LC 2: chroma view only (stream 1). LC 3 or a length outside the payload is
  `CodecError`. A chroma view is a P picture of the stream the luma view started, so LC 2 needs the SPS / IDR picture of an earlier picture on the same decoder.
- State persists per surface: the Y, U, V planes (rounded up to 16). A region is grown to whole 16x16 macroblocks of the picture before it is written (3.3.8.3.2: conversion
  of the entire macroblock, then the region mask; the caller paints only the exact regions). A luma view writes Y and the half-resolution U/V (replicated 2x2); a chroma view
  fills the other chroma samples (v1: odd rows from the luma plane of the auxiliary frame in 8-line blocks U/V, odd columns of even rows from its U/V; v2: odd columns from the
  left (U) and right (V) halves of its luma plane, columns 0 mod 4 and 2 mod 4 of odd rows from its U and V; the halves are min(surface width, picture width) rounded up to 32 apart, like FreeRDP
  yuv.c:503-504, samples that would lie beyond the picture row keep the main-view value). `toRgba` converts with BT.709 full range (FreeRDP `YUV2R/G/B`, not the stream's VUI) and applies the
  optional reverse filter for the main-view chroma with threshold 30.
- The caller serialises: `combine()` of picture n+1 is called only after the last `toRgba` of picture n (the worker's paint chain does this). `combine()` is the only point that touches the planes.
- Budgets and ownership as for AVC420: planes and read buffers are charged to `budget`; the pending limit `AVC_MAX_PENDING_FRAMES` counts VideoFrames (a picture with both views holds two,
  the worker counts them before it submits); every VideoFrame is closed on every path (`combine()`, `close()`, `reset()`, the decoder's close).
- A VideoFrame is read as I420 or NV12 (rows of the macroblock-aligned picture: the visible size rounded up to 16; Chrome's software decoder reports a coded height of 66 for 64). The AVC444 decoder
  asks for `hardwareAcceleration: 'prefer-software'` (deterministic I420); the worker creates the surface's shared decoder in software mode from the start when the session confirmed a 10.x set, so AVC420 pictures followed by AVC444 pictures stay one stream. Another format (also a GPU-only frame whose `format` is null), a cropped origin or a coded area smaller than the aligned
  picture is `CodecError('UNSUPPORTED')` from `combine()`.
- If the second chunk of a picture cannot be submitted (validation, budget) after the first one was, the picture is lost for good (the reference chain advanced): not retryable, `LIMIT` has no `budget` flag then.
- `probe()` decodes built-in pictures of both layouts for real, each ONE stream made by one encoder (IDR main view, P auxiliary view), checks the pixels and the time; its result is
  `infos.options.browser.avc444` (rdp/WIRE.md).

## Errors

`public/rdp/codecs/errors.js`: `class CodecError extends Error { constructor(code, message) }`.

| `code` | Meaning |
|---|---|
| `TRUNCATED` | input ended before a structure was complete |
| `INVALID` | value outside the specification (bad header, RLE run past the end, unknown opcode) |
| `LIMIT` | within the specification but above our limits, budget exhausted, or rectangle outside `dst` |
| `UNSUPPORTED` | valid but not implemented (e.g. a codec variant) |
| `INTERNAL` | anything else; a decoder bug |

A decoder throws only `CodecError`; the worker converts any other exception with `toCodecError`
(→ `INTERNAL`). After an error the worker stops applying operations and sends
`['client-error', code]`; the session ends. Messages never contain image data.

## Testing expectations for every decoder

- Unit tests with vectors from the specification, FreeRDP or IronRDP (the source named in the
  test); output compared byte for byte.
- Mutation test: truncate at every byte, flip random bits and lengths (fixed seed); the decoder must
  either succeed or throw `CodecError`, never another exception, never hang, never write outside
  `dst` (guard bytes around the destination), never leave budget reserved after `close()`.
- Benchmark: MB/s and megapixels/s on a fixed input.
