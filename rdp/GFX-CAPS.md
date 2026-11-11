# GFX capability and sequencing contract

Source: [MS-RDPEGFX, 2023-09-20](https://winprotocoldoc.z19.web.core.windows.net/MS-RDPEGFX/%5BMS-RDPEGFX%5D-230920.pdf), sections 1.5, 1.7, 2.2.2, 2.2.3, 3.2.5 and 3.3.5. Numeric values are the frozen `public/rdp/shared/constants.js` contract. This file defines validation by the server; bitmap decoding remains in the browser. Changes to this contract require a separate `contract:` commit.

## Codec matrix

WireToSurface1 (section 2.2.2.1) accepts `UNCOMPRESSED=0000`, `CAVIDEO=0003` (RemoteFX), `CLEARCODEC=0008`, `PLANAR=000A`, `AVC420=000B`, `ALPHA=000C`, `AVC444=000E`, `AVC444v2=000F`, subject to negotiation below. WireToSurface2 (2.2.2.2) accepts **only** `CAPROGRESSIVE=0009` and carries a persistent context ID. Codec IDs from the legacy Bitmap Codecs capability do not apply (1.7).

Here **base** means 0000, 0008, 000A, 000C in WTS1. **R/P** means RemoteFX (0003, WTS1) and Progressive (0009, WTS2), subject to THINCLIENT. A codec listed as supported may be sent even when another codec is preferred. In particular AVC420 does not mean AVC420-only.

| Version (section) | Value | WTS1 / WTS2 codecs in addition to base | Capability data and flags | Advertisement |
|---|---|---|---|---|
| 8.0 (2.2.3.1) | 00080004 | R/P; THINCLIENT requires RemoteFX in place of Progressive | 4 bytes: THINCLIENT, SMALL_CACHE | A: flags 00000002 |
| 8.1 (2.2.3.2) | 00080105 | R/P; 000B when AVC420_ENABLED | 4 bytes: THINCLIENT, SMALL_CACHE, AVC420_ENABLED | B: flags 00000012; only IPC explicitly enabling B |
| 10.0 (2.2.3.3) | 000A0002 | R/P; AVC (000B, 000E, 000F) unless AVC_DISABLED; YUV444 required when enabled | 4 bytes: SMALL_CACHE, AVC_DISABLED | C: flags 00000022; **not offered** |
| 10.1 (2.2.3.4) | 000A0100 | R/P; AVC including 000F implied (1.7); no AVC disable flag | 16 zero reserved bytes, no flags field | excluded |
| 10.2 (2.2.3.5) | 000A0200 | as 10.0 | 4 bytes: SMALL_CACHE, AVC_DISABLED | excluded from current allowlist |
| 10.3 (2.2.3.6) | 000A0301 | as 10.0; AVC_THINCLIENT prefers YUV444 | 4 bytes: AVC_DISABLED, AVC_THINCLIENT; implicit 16 MiB cache | excluded from current allowlist |
| 10.4 (2.2.3.7) | 000A0400 | as 10.3; when AVC enabled, support YUV420 mixed with other codecs in one frame | 4 bytes: SMALL_CACHE, AVC_DISABLED, AVC_THINCLIENT | D: flags 00000042 (SMALL_CACHE \| AVC_THINCLIENT, AVC enabled); offered only when the browser passed the AVC444 probe |
| 10.5 (2.2.3.8) | 000A0502 | as 10.4 | as 10.4; scaled mapping required (1.5.1) | excluded |
| 10.6 (2.2.3.9) | 000A0600 | as 10.4 | as 10.4; scaled mapping required | excluded |
| 10.7 (2.2.3.10) | 000A0701 | as 10.4 | as 10.4 plus SCALEDMAP_DISABLE | excluded (Windows 10 does not confirm a 10.7-only offer; Windows 11 confirms it like 10.4, so 10.4 suffices) |

AVC444v2 (000F) is explicitly included in the AVC family governed by the flag-bearing sets in section 1.7; for 10.1 it is implied without a flag. The 10.x rows therefore include 000B/000E/000F when AVC is enabled; the capability-set descriptions additionally require YUV444 support and, from 10.4, mixed YUV420. Only set D (10.4, AVC enabled) can lead to them, and the runtime accepts 000B, 000E and 000F only after a CapsConfirm of a 10.x version whose confirmed flags do not contain AVC_DISABLED (8.1: 000B only with AVC420_ENABLED, as before).

**Observed (MS-RDPEGFX 2.2.3.7 does not state it):** Windows 10 and Windows 11 Pro confirm 10.4 with the offered flags and send AVC444v2 (000F) **only** when AVC_THINCLIENT (40) is offered without AVC_DISABLED: every WireToSurface1 of such a session is 000F. 10.2 and 10.4 offered with SMALL_CACHE alone, and 8.1, give ClearCodec (0008) + Progressive (0009); Windows never sent AVC420 (000B) or AVC444 (000E). AVC444 / AVC444v2 payload (2.2.4.5): `u32` (bits 0..29 `cbAvc420EncodedBitstream1`, bits 30..31 `LC`), then one or two AVC420 bitstreams (metablock + Annex B). LC 0: both present (stream 1 is `cbAvc420EncodedBitstream1` bytes, stream 2 is the rest); LC 1: luma view only (stream 1 is the rest); LC 2: chroma view only (stream 1 is the rest); LC 3 is invalid. The two views are one H.264 stream (2.2.4.5), the second a P picture of the stream the first started. The server checks that structure and both metablocks like AVC420; the browser combines the two views (public/rdp/codecs/avc444.js). The spec's `cbAvc420EncodedBitstream1 = 0` for LC 2 is not checked (FreeRDP ignores it too); AVC444v2 is 2.2.4.6 (same payload). 8.1's AVC420_ENABLED explicitly permits only 000B in addition to its non-AVC codecs (2.2.3.2). 10.1 has no small-cache flag and cannot meet our cache/AVC policy.


Flag meanings (2.2.3.1–10):

- THINCLIENT (01): 16 MiB cache and RemoteFX instead of Progressive. SMALL_CACHE (02) **only** limits cache to 16 MiB. With neither flag, 8/8.1 assume 100 MiB. Combining both is discouraged in 8.0; 8.1 explicitly permits SMALL_CACHE|AVC420_ENABLED|THINCLIENT.
- AVC420_ENABLED (10): enables YUV420 in 8.1, without disabling the other codecs.
- AVC_DISABLED (20): disables AVC in all modes in 10.x. Without it YUV444 support is required.
- AVC_THINCLIENT (40): prefers YUV444, mutually exclusive with AVC_DISABLED.
- SCALEDMAP_DISABLE (80): in 10.7 disables scaled output and scaled window mapping. In 10.5/10.6 there is no equivalent opt-out.
- 10.3 constrains cache implicitly to 16 MiB. A 16 MiB cache has at most 4096 variable-size slots (one-based indices 1..4096) (3.3.1.4); the runtime enforces 16 MiB / 4096 slots for every advertised set.

**Note on sets A and B:** they omit THINCLIENT, so both permit Progressive. A browser must implement every codec a set permits (Progressive, ClearCodec, RemoteFX and Alpha) before requesting it; set C would not make A/B safe for a browser without those decoders. The server accepts Progressive headers and keeps the legacy mode as the default request. No THINCLIENT set other than D is offered. Browser-message configuration produces A, and B (explicit H.264 request and successful browser probe) and D (as B, plus `browser.avc444.ok`; all of them only while `settings.webRdp.h264` is not false, rdp/WIRE.md). The runtime filters unsupported IPC set IDs, including C; an empty supported selection fails with CAPABILITIES_REJECTED/use-legacy before allocating state. Advertisements retain `GFX_CAPSETS_ALLOWED` order (B then A) after filtering by IPC IDs. Confirm must arrive once, with a data length of 4 and a version equal to an advertised version. Its flags must be a **subset** of the flags advertised for that version (`flags & ~advertised === 0`); a flag that was not offered is a protocol error. SMALL_CACHE (0x2) is advertised in every set and **must stay set**: a confirmation without it means a 100 MiB cache, which `GFX_CACHE_MAX_BYTES` (16 MiB) would end in the middle of the session, so it is refused at once with `RDP_ERROR_CAPABILITIES_REJECTED` and the `use-legacy` hint. Region counts above the browser decoders' caps (AVC420 `8192`, Progressive / RemoteFX `4096` rectangles) end the session with `RDP_ERROR_RESOURCE_LIMIT` and `use-legacy`. The server may switch off what was offered: Windows 10 confirms 8.1 with AVC420_ENABLED cleared (flags 0x2 for the offered 0x12) when it has no H.264 encoder. Consequences: the confirmed flags, not the offered ones, decide what the server accepts. Without AVC420_ENABLED in the confirmed 8.1 set the engine rejects every AVC420 WireToSurface1 as a protocol error (AVC444 and AVC444v2 are accepted only in a confirmed 10.x set without AVC_DISABLED), so the server must not send AVC420 and the browser must not expect it. The confirmed version and flags are reported to the browser in `rdp-connect.gfx` (`capsVersion`, `flags`), and the browser decides from those whether H.264 is in use.

## PDU matrix

**Common server→client set**, all ten versions (1.5.1, 2.2.2.1–19): WTS1 (0001), WTS2 (0002), DeleteEncodingContext (0003), SolidFill (0004), SurfaceToSurface (0005), SurfaceToCache (0006), CacheToSurface (0007), EvictCacheEntry (0008), CreateSurface (0009), DeleteSurface (000A), StartFrame (000B), EndFrame (000C), ResetGraphics (000E), MapSurfaceToOutput (000F), CapsConfirm (0013). CacheImportReply (0011) is conditional on optional persistent caching. The server never sends an offer and rejects unsolicited replies.

| Version | Additional server→client PDUs | Client→server PDUs |
|---|---|---|
| 8.0 | MapSurfaceToWindow (0015) only with Enhanced RemoteApp | CapsAdvertise (0012), FrameAcknowledge (000D); optional CacheImportOffer (0010) |
| 8.1 | same as 8.0 | same as 8.0 |
| 10.0 | same as 8.0 | same plus optional QoEFrameAcknowledge (0016) |
| 10.1 | same as 8.0 | same as 8.0; not listed in QoE requirement in 1.5.2 |
| 10.2 | same as 8.0 | as 10.0 |
| 10.3 | same as 8.0; may renegotiate by client advertisement (3.3.5.19) | as 10.0 |
| 10.4 | same as 10.3 | as 10.0 |
| 10.5 | scaled output (0017), scaled window (0018, with Enhanced RemoteApp) required | as 10.0 |
| 10.6 | same as 10.5 | as 10.0 |
| 10.7 | same as 10.5 unless SCALEDMAP_DISABLE | as 10.0 |

Enhanced RemoteApp and scaled mapping are not implemented. Those four mapping forms are rejected and never forwarded. Client-direction commands received from the server are protocol errors. Only the frozen `GFX_FORWARDED` list goes into WIRE.GFX, complete PDUs with zero header flags, after confirmation. CapsConfirm is consumed; other unrecognized commands are errors. No capability renegotiation is possible for A/B.

## State legality

Before confirmation: only one matching CapsConfirm; any other first PDU fails immediately, including before RDP activation. Except for the bounded resize restart described in **Pipeline restart around a resize** below, a peer Close of the graphics DVC after CapsConfirm terminates the session with `RdpError(RDP_ERROR_PROTOCOL, { detail: 0x00000004, phase: "session" })` (hex detail identifies the DVC Close command). Queued input is discarded and nothing further is forwarded. Outside that exception, a second graphics Create in the same RDP session is refused, including after a pre-confirm Close. Within the exception, `rdp-resize` resets the browser pipeline after the new CapsConfirm. Local session teardown simply releases resources. `io.gfxChannel()` runs on both open and close. ResetGraphics **does not** open a new generation or reset the engine ACK count.

| Operation | Outside frame | Inside frame | Preconditions / effect; specification |
|---|---|---|---|
| WTS1/WTS2, SolidFill, SurfaceToSurface, SurfaceToCache, CacheToSurface | forbidden | allowed | Live source/destination surfaces; in-bounds half-open rectangles and destination extents; valid pixel formats; occupied slot for cache reads. Sections 3.2.5.1/2/4–7 explicitly require a logical frame. |
| CreateSurface | allowed | allowed | New ID; positive bounded dimensions, XRGB8888/ARGB8888; count and aggregate pixels bounded. 3.2.5.9 does not restrict framing. |
| DeleteSurface | allowed | allowed | Live ID; remove surface mappings and associated contexts. 3.2.5.10, 3.3.1.1–3, 3.3.5.10. |
| MapSurfaceToOutput | allowed | allowed | Live surface; bounded output origin; map/remap independently of framing (3.2.5.15, 3.3.5.15). Output composition is clipped to desktop; a surface can exceed the output (e.g. codec padding). |
| MapSurfaceToWindow / scaled forms | framing unrestricted by spec | framing unrestricted by spec | Need relevant negotiated features, live surface and bounded mapped/target dimensions (2.2.2.20/22/23, 3.3.5.20/22/23); rejected because never negotiated. |
| DeleteEncodingContext | allowed | allowed | Live context on specified live surface; 3.2.5.3. |
| EvictCacheEntry | allowed | allowed | Occupied slot; release its byte cost; 3.2.5.8. Cache replacement updates byte cost atomically. |
| ResetGraphics | allowed | allowed | Valid desktop, monitor count ≤16, valid signed inclusive monitor rectangles and primary flags, fixed 340-byte PDU (2.2.2.14). Resize output via io.desktop; preserve surfaces, cache, contexts and current frame (3.3.5.14 only resizes output). |
| StartFrame | allowed | forbidden by WIRE | Save frameId; spec says SHOULD NOT nest (3.2.5.11); WIRE v1 makes this strict. |
| EndFrame | forbidden | allowed, matching ID | Spec says SHOULD match (3.2.5.12); WIRE v1 makes matching strict. Clear current frame; engine ledger owns ACK authorization and count. IDs compared for equality, including wraparound. |
| CacheImportReply | conditional on offer | conditional on offer | Never legal (no CacheImportOffer is sent). |

Large buffers are charged before allocation. DVC reassembly is shared with SVC/fast-path in REASSEMBLY_MAX_BYTES; ZGFX history and output use io.reserve. Decompressed messages awaiting activation are kept in a reserved FIFO, limited to REASSEMBLY_MAX_BYTES of allocated output capacity and GFX_QUEUE_MAX_MESSAGES entries; both limits are checked before output allocation. ClearCodec (aligned with FreeRDP where MS-RDPEGFX is silent): the server checks the composite structure — every nested length (residual, bands, subcodecs) fits its enclosing payload, counts and cache indices are within the spec ranges, glyph rules that the spec states as MUST are enforced, and residual/subcodec envelopes stay within the destination rectangle. It no longer checks band edges, V-Bar/short V-Bar references or V-Bar hits on empty entries against the destination or the cache contents (FreeRDP accepts these), and the sequence number restarts on ResetGraphics. Like FreeRDP, unknown composite flag bits are ignored and bytes after the declared composite layers are skipped (the reader stays bounded to the bitmap data). The browser decoder (public/rdp/codecs/clear.js) revalidates everything, keeps the caches, clips all painting to the destination rectangle and the surface, and turns any inconsistency into RDP_ERROR_CLIENT_DECODE. The server stores no decoded pixels. Output stops at engine credit and resumes through drain, including concatenated PDUs in one decompressed message. ACKs are emitted only by connection.gfxAck after ledger validation, never on receiving EndFrame.

## Pipeline restart around a resize

A server may close a confirmed RDPGFX channel and create it again (xrdp does so after every MS-RDPEDISP layout change, between
Deactivate-All and the new Demand Active). The engine accepts at most one restart per sent Display Control request, only while that request is still
outstanding and less than 3000 ms old, and only after the session has been active and reported connected once.
Deactivate-All and reactivation do not grant or extend this 3 s window. A second close, including a close of an
unconfirmed replacement pipeline, is not another restart opportunity for the same request. Outside this window it ends the session with
`RDP_ERROR_PROTOCOL (0x00000004)`. The new channel starts a new generation (frame ledger, `totalFramesDecoded`) and must be confirmed within
`GFX_CONFIRM_TIMEOUT_MS`, otherwise the session ends as without GFX. Once it is confirmed the engine posts `desktop` + `resize`
(IPC), i.e. `rdp-resize`: the browser replaces its GFX client. A RESETGRAPHICS on a surviving channel keeps surfaces and caches as
before.

In GFX mode, activation alone does not settle a Display Control request: the replacement pipeline must reach CapsConfirm,
or a surviving pipeline must apply ResetGraphics. Pending layouts wait while the pipeline is absent or unconfirmed, including
after the 3 s request timeout.
