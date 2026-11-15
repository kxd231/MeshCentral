/**
* @description KVM H.264 in the remote desktop viewer: a WebCodecs VideoDecoder inside the ordered draw queue of agent-desktop-0.0.2.js
* @license Apache-2.0
*
* The viewer owns the queue and the negotiation (commands 240-242);
* this module decodes the picture of every accepted command 243 and paints it, in queue order and only inside the rectangles of the frame.
* It reuses scanNals, parseSps and parsePps of public/rdp/codecs/avc420.js (the contract of that file is not changed) and adds what the KVM stream
* needs on top: the VUI check, the profile rules, the decoder lifecycle, the watchdog and the error budget.
*
* Every queue operation of a frame (type 3) is settled exactly once: by the output of the decoder, or as "discarded" (it is consumed in order,
* nothing is painted) when the decoder instance it belongs to is reset, closed, fails, or the queue is dropped. Every VideoFrame is closed exactly once.
* Usable from a browser page (global AgentDesktopH264) and from Node (require), where the tests pass fakes of VideoDecoder and EncodedVideoChunk.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(root); }
    else { root.AgentDesktopH264 = factory(root); }
})((typeof self !== 'undefined') ? self : this, function (root) {
    'use strict';

    var PROFILES = [66, 77, 100];           // Constrained Baseline, Main, High: the only ones the protocol allows
    var WATCHDOG_MS = 500;                  // a frame at the head of the queue without output, while the decoder is idle (7.2)
    var SUPPORT_MAX_MS = 5000;              // isConfigSupported that does not answer by then: the decoder is not usable
    var MAX_DECODE_QUEUE = 8;               // decodeQueueSize above this is an overflow once it has stayed there for OVERFLOW_HOLD_MS, at once above MAX_DECODE_QUEUE_HARD
    var OVERFLOW_HOLD_MS = 250;             // a decoder that is behind for a moment (a stall of the page, a slow first picture) catches up by itself; one that is still behind after this is not coming back
    var MAX_DECODE_QUEUE_HARD = 32;         // the queue of chunks holds the data of the frames: it is not allowed to grow without limit while the hold time runs
    var MAX_READY_FRAMES = 4;               // decoded VideoFrames waiting in the queue (7.2, own video budget)
    var MAX_LIVE_FRAMES = 6;                // VideoFrames that are open at once (decoded and not yet closed, the ones the presenter holds included): above this the presenter draws what it holds (it is looked at when the decoder gives a picture, so 7 are open at that moment and a decoder that gives nothing is not helped: the presenter lets go at the next frame, the watchdog does the rest)
    var MAX_WAITING = 32;                   // frames that wait for isConfigSupported
    var ERROR_WINDOW_MS = 30000, ERROR_LIMIT = 3;
    var OP3_INTERVAL_MS = 1000;
    var MAX_CODED = 8192;
    var HARD_HEAD_MS = 3000;                // a frame at the head of the queue never waits longer than this, whatever the decoder says
    var OVERFLOW_LIMIT = 3;                 // overflows in ERROR_WINDOW_MS that switch the video off
    var MAX_PS_BYTES = 1024;                // one SPS or PPS NAL unit (the agent's are ~30 bytes)
    var MAX_HRD_CPB = 32;                   // cpb_cnt_minus1 + 1 (H.264 E.2.2: at most 32)
    var MAX_MBS = 36864;                    // macroblocks of a picture: MaxFS of level 5.2, above that the agent answers reason 7 (5.2)
    var MAX_REF_FRAMES = 1;                 // max_num_ref_frames (the agent sets MaxNumRefFrame = 1, 3.4)
    var MAX_WAITING_BYTES = 16 * 1024 * 1024;   // frames that wait for isConfigSupported
    var RESTART_MAX = 2, RESTART_WINDOW_MS = 1000;   // decoder (re)creations per second (a hostile agent could make one per frame)

    // ---- dependencies (late bound: the page loads the scripts in any order) ----
    function avcOf(o) {
        if (o && o.avc420) { return o.avc420; }
        if (root && root.RdpCodecs && root.RdpCodecs.avc420) { return root.RdpCodecs.avc420; }
        if ((typeof require === 'function') && (typeof module === 'object')) { return require('../rdp/codecs/avc420.js'); }
        return null;
    }

    function fail(msg) { var e = new Error(msg); e.name = 'H264StreamError'; return e; }
    function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
    function u32(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function hex2(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    // ---- SPS: what parseSps does not return (frame_mbs_only_flag and the VUI) ----
    function rbspOf(data, start, end) {
        var out = new Uint8Array(end - start), len = 0, zeros = 0;
        for (var i = start + 1; i < end; i++) {
            var v = data[i];
            if ((zeros >= 2) && (v === 3)) { zeros = 0; continue; }
            out[len++] = v; zeros = (v === 0) ? (zeros + 1) : 0;
        }
        return out.subarray(0, len);
    }
    function bitReader(buf) {
        var pos = 0;
        function bit() {
            if ((pos >> 3) >= buf.length) { throw fail('SPS truncated'); }
            var v = (buf[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v;
        }
        function bits(n) { var v = 0; for (var i = 0; i < n; i++) { v = (v * 2) + bit(); } return v; }
        function ue() { var z = 0; while (bit() === 0) { if (++z > 32) { throw fail('SPS exp-Golomb'); } } return (Math.pow(2, z) - 1) + bits(z); }
        function se() { var k = ue(); return (k & 1) ? ((k + 1) / 2) : -(k / 2); }
        return { bit: bit, bits: bits, ue: ue, se: se };
    }
    function skipHrd(r) {
        var cnt = r.ue(); r.bits(8);
        if (cnt >= MAX_HRD_CPB) { throw fail('cpb_cnt_minus1'); }
        for (var i = 0; i <= cnt; i++) { r.ue(); r.ue(); r.bit(); }
        r.bits(20);
    }
    // → { frameMbsOnly, vui: boolean, restriction: boolean, reorder: number | null, buffering: number | null }. Throws on a truncated SPS.
    function parseSpsExtra(data, start, end) {
        var r = bitReader(rbspOf(data, start, end));
        var profile = r.bits(8); r.bits(16); r.ue();
        if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
            var chroma = r.ue(); if (chroma === 3) { r.bit(); }
            r.ue(); r.ue(); r.bit();
            if (r.bit()) {
                var lists = (chroma !== 3) ? 8 : 12;
                for (var i = 0; i < lists; i++) {
                    if (!r.bit()) { continue; }
                    var last = 8, next = 8, size = (i < 6) ? 16 : 64;
                    for (var j = 0; j < size; j++) { if (next !== 0) { next = (last + r.se() + 256) % 256; } if (next !== 0) { last = next; } }
                }
            }
        }
        r.ue();
        var poc = r.ue();
        if (poc === 0) { r.ue(); } else if (poc === 1) { r.bit(); r.se(); r.se(); var c = r.ue(); if (c > 255) { throw fail('SPS poc cycle'); } for (var k = 0; k < c; k++) { r.se(); } }
        var refs = r.ue(); r.bit(); r.ue(); r.ue();
        var frameMbsOnly = r.bit(); if (!frameMbsOnly) { r.bit(); }
        r.bit();
        if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); }
        var out = { numRefFrames: refs, frameMbsOnly: frameMbsOnly === 1, vui: false, restriction: false, reorder: null, buffering: null };
        if (!r.bit()) { return out; }
        out.vui = true;
        if (r.bit()) { if (r.bits(8) === 255) { r.bits(32); } }
        if (r.bit()) { r.bit(); }
        if (r.bit()) { r.bits(3); r.bit(); if (r.bit()) { r.bits(24); } }
        if (r.bit()) { r.ue(); r.ue(); }
        if (r.bit()) { r.bits(32); r.bits(32); r.bit(); }
        var nal = r.bit(); if (nal) { skipHrd(r); }
        var vcl = r.bit(); if (vcl) { skipHrd(r); }
        if (nal || vcl) { r.bit(); }
        r.bit();
        if (r.bit()) { out.restriction = true; r.bit(); r.ue(); r.ue(); r.ue(); r.ue(); out.reorder = r.ue(); out.buffering = r.ue(); }
        return out;
    }

    // ---- command 243 (the caller has validated it: protocol 4.2 steps 1 to 10) ----
    // view: the inner command (starts with 243), size: its length N. → { seq, ts, flags, gen, codedW, codedH, marker, idr, rects: [{x, y, w, h}], data }
    function parseFrame(view, size) {
        var flags = view[12], nRects = u16(view, 18), rects = [];
        for (var i = 0; i < nRects; i++) { var o = 20 + (i * 8); rects.push({ x: u16(view, o), y: u16(view, o + 2), w: u16(view, o + 4), h: u16(view, o + 6) }); }
        return {
            seq: u32(view, 4), ts: u32(view, 8), flags: flags, gen: view[13], codedW: u16(view, 14), codedH: u16(view, 16),
            marker: (flags & 2) !== 0, idr: (flags & 1) !== 0, rects: rects, data: view.subarray(20 + (8 * nRects), size)
        };
    }

    // ---- the Annex B part of a frame ----
    // Skips AUD (9) and SEI (6) and every other NAL that is not a parameter set or a slice; counts the slices of a picture.
    // → { idr, spsNal, ppsNals, info } (info: the SPS of an IDR frame, validated). Throws an H264StreamError or the CodecError of avc420.
    function sameBytes(a, b) { if (a.length !== b.length) { return false; } for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } } return true; }

    // cur (optional): { sps: Uint8Array } the SPS bytes the decoder runs with; a non-IDR picture that carries an SPS must repeat it exactly (an SPS changes only on an IDR picture)
    function analyse(data, av, codedW, codedH, wantIdr, cur) {
        var nals = av.scanNals(data), sps = null, pps = [], idr = false, slices = 0, nonIdr = 0, firstSlice = -1;
        for (var i = 0; i < nals.length; i++) {
            var n = nals[i];
            switch (n.type) {
                case 7:
                    if ((n.end - n.start) > MAX_PS_BYTES) { throw fail('SPS too large'); }
                    if (sps === null) { sps = n; } else if (!sameBytes(data.subarray(n.start, n.end), data.subarray(sps.start, sps.end))) { throw fail('several different SPS'); }
                    break;
                case 8:
                    if (((n.end - n.start) > MAX_PS_BYTES) || (pps.length >= 4)) { throw fail('PPS too large or too many'); }
                    pps.push(n); break;
                case 5: idr = true; slices++; if (firstSlice < 0) { firstSlice = n.start; } break;
                case 1: nonIdr++; slices++; if (firstSlice < 0) { firstSlice = n.start; } break;
                case 2: case 3: case 4: throw fail('data partitioning');
                case 14: case 15: case 20: throw fail('SVC or MVC NAL unit');
                default: break;      // SEI, AUD, end of sequence, filler...
            }
        }
        if (slices === 0) { throw fail('no slice NAL unit'); }
        if (idr && (nonIdr > 0)) { throw fail('IDR and non-IDR slices in one picture'); }
        if (idr !== wantIdr) { throw fail('the IDR flag does not match the slices'); }
        var out = { idr: idr, info: null, spsBytes: null };
        if (!idr) {
            // parameter sets in a P picture: validated like those of an IDR picture; the SPS must be the running one
            if (sps !== null) {
                var bytes = Uint8Array.from(data.subarray(sps.start, sps.end));
                if ((cur === undefined) || (cur === null) || !sameBytes(bytes, cur.sps)) { throw fail('SPS outside an IDR picture that differs from the running one'); }
                checkSps(data, sps, av, codedW, codedH);
            }
            for (var k = 0; k < pps.length; k++) { var q = av.parsePps(data, pps[k].start, pps[k].end); if ((cur) && (cur.id !== undefined) && (q.spsId !== cur.id)) { throw fail('PPS refers to another SPS'); } }
            return out;
        }
        if ((sps === null) || (pps.length === 0) || (sps.start > firstSlice) || (pps[0].start > firstSlice)) { throw fail('IDR without SPS and PPS before the slices'); }
        var s = checkSps(data, sps, av, codedW, codedH);
        for (var j = 0; j < pps.length; j++) {
            var p = av.parsePps(data, pps[j].start, pps[j].end);
            if (p.spsId !== s.id) { throw fail('PPS refers to another SPS'); }
        }
        out.info = s;
        out.spsBytes = Uint8Array.from(data.subarray(sps.start, sps.end));
        return out;
    }

    // level_idc: the levels of the standard up to 5.2 (above that the agent answers reason 7, 5.2). 9 is level 1b of the High profile (Baseline and Main say 1b as 11 with constraint_set3)
    var LEVELS = [10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52];
    function validLevel(level, profile) { return (LEVELS.indexOf(level) >= 0) || ((level === 9) && (profile === 100)); }

    // The rules of 3.4 for an SPS; any parse error is an error of the stream (fail closed). → the SPS as parseSps returns it, plus vui, vuiOk
    function checkSps(data, sps, av, codedW, codedH) {
        var s = av.parseSps(data, sps.start, sps.end);
        if (PROFILES.indexOf(s.profile) < 0) { throw fail('profile ' + s.profile); }
        if ((s.profile === 66) && ((s.constraints & 0x40) === 0)) { throw fail('Baseline without constraint_set1 (FMO and ASO are not excluded)'); }
        if ((s.visibleX !== 0) || (s.visibleY !== 0) || (s.visibleWidth !== s.codedWidth) || (s.visibleHeight !== s.codedHeight)) { throw fail('SPS with frame cropping'); }
        if ((s.codedWidth !== codedW) || (s.codedHeight !== codedH) || (s.codedWidth > MAX_CODED) || (s.codedHeight > MAX_CODED)) { throw fail('SPS size does not match the frame'); }
        if (((s.codedWidth >> 4) * (s.codedHeight >> 4)) > MAX_MBS) { throw fail('picture larger than level 5.2'); }
        if (!validLevel(s.level, s.profile)) { throw fail('level_idc ' + s.level); }
        var x = parseSpsExtra(data, sps.start, sps.end);     // a truncated or malformed SPS throws
        if (!x.frameMbsOnly) { throw fail('interlaced SPS'); }
        if (x.numRefFrames > MAX_REF_FRAMES) { throw fail('max_num_ref_frames ' + x.numRefFrames); }
        s.vuiOk = x.restriction && (x.reorder === 0) && (x.buffering !== null) && (x.buffering <= 1);
        s.vui = x;
        return s;
    }

    // ---- capability probe: once per page; isConfigSupported once per (codec, size) ----
    var probeCache = null;
    function probeOnce(o) {
        if (probeCache === null) { probeCache = avcOf(o).Avc420Decoder.probe(o).then(function (r) { return !!(r && r.ok); }, function () { return false; }); }
        return probeCache;
    }

    // software: the retry after the errors of a decoder that the browser chose by itself (hardware): hardwareAcceleration 'prefer-software'
    function decoderConfig(codec, w, h, software) {
        var c = { codec: codec, codedWidth: w, codedHeight: h, optimizeForLatency: true, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
        if (software === true) { c.hardwareAcceleration = 'prefer-software'; }
        return c;
    }

    // Is the browser able to decode the stream the agent will send for a screen? → Promise<{ ok, flags, maxLevelIdc, maxW, maxH }> (flags: profile bits of 240 op 1)
    // The sizes are the padded screen size (protocol: coded). opts (tests): { VideoDecoder, EncodedVideoChunk, avc420, ... } as for Avc420Decoder.probe
    function detect(screenW, screenH, opts) {
        opts = opts || {};
        var VD = opts.VideoDecoder || ((typeof VideoDecoder !== 'undefined') ? VideoDecoder : null);
        var Chunk = opts.EncodedVideoChunk || ((typeof EncodedVideoChunk !== 'undefined') ? EncodedVideoChunk : null);
        var no = { ok: false, flags: 0, maxLevelIdc: 0, maxW: 0, maxH: 0 };
        if ((VD === null) || (Chunk === null) || (typeof VD.isConfigSupported !== 'function')) { return Promise.resolve(no); }
        var w = Math.ceil(screenW / 32) * 32, h = Math.ceil(screenH / 32) * 32;
        if ((w < 32) || (h < 32) || (w > MAX_CODED) || (h > MAX_CODED)) { return Promise.resolve(no); }
        var level = 52;      // asked for the highest level the protocol allows (5.2); the agent picks the smallest level that its picture needs
        var codecs = [['avc1.42c0', 1], ['avc1.4d00', 2], ['avc1.6400', 4]];
        return Promise.resolve().then(function () { return (opts.probe !== undefined) ? opts.probe : probeOnce(opts); }).then(function (probed) {
            if (!probed) { return no; }
            return Promise.all(codecs.map(function (c) {
                var cfg = decoderConfig(c[0] + hex2(level), w, h);
                return Promise.resolve().then(function () { return VD.isConfigSupported(cfg); }).then(function (r) { return (r && r.supported) ? c[1] : 0; }, function () { return 0; });
            })).then(function (bits) {
                var flags = bits[0] | bits[1] | bits[2];
                return flags ? { ok: true, flags: flags, maxLevelIdc: level, maxW: w, maxH: h } : no;
            });
        }, function () { return no; });
    }

    // ---- the page: the option "H.264 (video)", what the player does with a recorded command ----
    var ENCODING = 264;     // value of the Encoding setting (agentencoding) that stands for H.264; 1 = JPEG, 2 = PNG

    // Can this browser show H.264 video at all? → Promise<boolean>. The probe runs once per page (the same one the viewer uses). opts: as for detect
    function available(opts) {
        return detect(1920, 1088, opts).then(function (r) { return !!(r && r.ok); }, function () { return false; });
    }

    // What the Encoding setting means for one session. usable: the browser can decode it and the server allows it. → { h264, type }, type is the picture type of
    // command 5 (video always travels with JPEG tiles). A saved 264 that cannot be used is JPEG, the saved value itself is not touched.
    function sessionEncoding(setting, usable) {
        var n = parseInt(setting, 10);
        if (n === ENCODING) { return { h264: (usable === true), type: 1 }; }
        return { h264: false, type: (n === 2) ? 2 : 1 };
    }

    // Puts a viewer (agent-desktop-0.0.2.js object) into the mode the setting asks for and returns the picture type to give to SendCompressionLevel
    function applyEncoding(m, setting, usable) {
        var e = sessionEncoding(setting, usable);
        if (m && (typeof m.SetH264 === 'function')) { m.SetH264(e.h264); }
        return e.type;
    }

    // A block of a recording (device to user) of the desktop protocol: the command number, its size and the bytes of the command, or null when the size does not fit.
    // view: the bytes of the block. A JUMBO wrapper (27, 8, N) is taken off. The multiplexor pads the wrapped command with 0 to 7 bytes (D-18): for 243 the bytes behind
    // the N bytes of the command are ignored; for any other wrapped command only a padding of 1 to 7 bytes is (exactly 8 more is the old copy of the header). Older recordings are read as before (a copy of the 8 byte header in front of the command is dropped).
    function splitRecordedCommand(view) {
        if (!view || (view.length < 4)) { return null; }
        var cmd = u16(view, 0), size = u16(view, 2), jumbo = false;
        if ((cmd === 27) && (size === 8)) {
            if (view.length < 10) { return null; }
            cmd = u16(view, 8); size = u32(view, 4); view = view.slice(8); jumbo = true;
        }
        if (jumbo && (cmd === 243)) {
            if (view.length < size) { return null; }
            if (view.length > size) { view = view.slice(0, size); }
        } else if ((size + 8) === view.length) { view = view.slice(8); }
        else if (jumbo && (view.length > size) && (view.length < (size + 8))) { view = view.slice(0, size); }     // padding of 1 to 7 bytes of a wrapped tile in a recording of the multiplexor
        return (size === view.length) ? { cmd: cmd, size: size, view: view } : null;
    }

    // The recording player feeds one block after the other. While the decoder is busy (obj.VideoBusy() of the viewer: queue of the decoder or of decoded pictures full) the next
    // block waits (protocol 7.5), and so does the block after RESTART_MAX decoder creations within a second. A decoder that stays busy for FEED_MAX_WAIT_MS is not waited for any longer: the watchdog of the decoder has dealt with it by then.
    // st: { since: 0 } kept by the caller. → milliseconds to wait before the next block (0: feed it now)
    var FEED_POLL_MS = 10, FEED_MAX_WAIT_MS = 5000;
    function feedDelay(m, st, nowMs) {
        var rw = (m && (typeof m.VideoRestartWait === 'function')) ? m.VideoRestartWait() : 0;     // decoders are created at most RESTART_MAX per second in a recording too
        if (rw > 0) { return rw; }
        if (m && (typeof m.VideoBusy === 'function') && m.VideoBusy()) {
            if (!st.since) { st.since = nowMs; }
            if ((nowMs - st.since) < FEED_MAX_WAIT_MS) { return FEED_POLL_MS; }
        }
        st.since = 0;
        return 0;
    }

    // Seek in a recording (protocol 7.5). mcrec.js may give an index entry the pointer of the last key frame before it (extra metadata indexIdr, one value per entry of indexes).
    // The player then decodes every block from that key frame to the pointer of the entry, so that the moving areas are right at the target and not up to a key frame interval old.
    // The recording is untrusted data: a missing, malformed or too distant pointer, or an entry that lies outside the file, gives null (the seek of an older recording: pictures wait for the next key frame).
    // base, size (optional): the place of the first data block and the size of the file; with them an entry that ends behind the end of the file is refused too.
    // → { from, to }: offsets relative to the first data block, like the pointers of the index
    var SEEK_REPLAY_MAX_BYTES = 64 * 1024 * 1024;
    function seekSpan(meta, n, base, size) {
        if (!meta || !Array.isArray(meta.indexes) || !Array.isArray(meta.indexIdr)) { return null; }
        var e = meta.indexes[n], from = meta.indexIdr[n];
        if (!Array.isArray(e) || (typeof e[0] !== 'number') || (typeof from !== 'number') || !isFinite(from) || (from < 0) || (from >= e[0]) || ((e[0] - from) > SEEK_REPLAY_MAX_BYTES)) { return null; }
        if ((typeof size === 'number') && !((typeof base === 'number') && (base >= 0) && ((base + e[0]) <= size))) { return null; }
        return { from: from, to: e[0] };
    }

    // Feeds the blocks in [from, to) one after the other and tells when it is done. h: { readAt(ptr, cb(type, flags, time, data)) (type < 0: the block cannot be read; the callback may come at once),
    // feed(type, flags, time, data), delay() -> milliseconds to wait before the next block (feedDelay: the decoder has room and may be created), later(fn, ms),
    // alive() -> false when the seek was given up (nothing is fed after that), done(ok) }. Blocks of the user and blocks that are not data are skipped.
    // A loop, not a recursion: a recording whose blocks are all in memory answers at once, and thousands of blocks without video must not grow the stack. Every REPLAY_YIELD blocks the loop gives the page the turn (later(fn, 0)).
    var REPLAY_YIELD = 256;
    function replayBlocks(h, from, to) {
        var ptr = from, run = 0;
        function step() {
            for (;;) {
                if (!h.alive()) { return; }
                if (ptr >= to) { h.done(true); return; }
                var d = h.delay();
                if (d > 0) { h.later(step, d); return; }
                if (++run >= REPLAY_YIELD) { run = 0; h.later(step, 0); return; }
                var inside = true, res = 0;                       // res: 1 the loop goes on, 2 it ended (a block that cannot be read)
                h.readAt(ptr, function (type, flags, time, data) {
                    if (!h.alive()) { res = 2; return; }
                    if ((type < 0) || (typeof data !== 'string')) { res = 2; h.done(false); return; }
                    ptr += 16 + data.length;
                    if ((type === 2) && ((flags & 2) === 0)) { h.feed(type, flags, time, data); }
                    res = 1;
                    if (!inside) { step(); }
                });
                inside = false;
                if (res !== 1) { return; }                         // ended, or the answer comes later and goes on by itself
            }
        }
        step();
    }

    // ---- the decoder ----
    // host: { player() → bool, now(), setTimeout, clearTimeout, hidden() → bool, sendOp3(flags), sendOp2(), wake(), changed(), head() → the op at the head of the queue,
    //         rotX(x, y), rotY(x, y), log(msg), presenter() → the presenter or null, tick() → ms of a monotonic clock (the one of the presenter),
    //         tune() → false for the presentation switch (?kvmpresent=0, PresentMode off): then none of the behaviour below applies,
    //         softwareGet() → bool, softwareSet(bool): the memory of the tab for the software decoder }; opts (tests): { VideoDecoder, EncodedVideoChunk, avc420 }
    function create(host, opts) {
        opts = opts || {};
        var av = avcOf(opts);
        var VD = opts.VideoDecoder || ((typeof VideoDecoder !== 'undefined') ? VideoDecoder : null);
        var Chunk = opts.EncodedVideoChunk || ((typeof EncodedVideoChunk !== 'undefined') ? EncodedVideoChunk : null);
        var setT = function (fn, ms) { return (host.setTimeout || setTimeout)(fn, ms); };
        var clrT = function (h) { (host.clearTimeout || clearTimeout)(h); };
        var now = function () { return host.now ? host.now() : Date.now(); };
        var isPlayer = function () { return !!(host.player && host.player()); };
        var log = function (m) { if (host.log) { host.log(m); } };
        var tuned = function () { return !host.tune || (host.tune() !== false); };
        var tick = function () { return host.tick ? host.tick() : now(); };

        var v = {
            curGen: null, needIdr: true, expectedGen: null,
            disabled: false,                 // JPEG for the rest of the connection (3 errors, unsupported stream)
            why: null,                       // 'errors' | 'unsupported' while disabled
            software: false,                 // the decoder runs with hardwareAcceleration 'prefer-software' (after the errors of the one the browser chose, or as the tab remembers)
            degraded: false,                 // the SPS has no usable VUI (7.2): the watchdog carries the last picture of a burst
            stats: { accepted: 0, discarded: 0, decoded: 0, painted: 0, errors: 0, streamErrors: 0, watchdogs: 0, overflows: 0, restartLimited: 0, resets: 0, op3: 0, starts: 0, supportChecks: 0, gaps: 0,
                ovQueue: 0, ovReady: 0, ovReadyTile: 0, ovReadyOther: 0, ovWait: 0, queueHigh: 0, queueHighMs: 0, softwareRetries: 0, softwareDropped: 0, maxLive: 0, liveFlushes: 0 }
        };
        var vd = null, cfg = null;               // decoder instance and { codec, w, h } it is configured for
        var live = new Set();                    // ops of frames not yet consumed or dropped by the queue
        var inflight = new Map();                // timestamp (seq) → op, submitted to the current decoder, no output yet
        var waiting = [];                        // { f, op, key } in order, while isConfigSupported is pending
        var starting = null;                     // { token, cfg, t0 } while a generation is being started
        var token = 0;
        var ready = 0;                           // ops that hold a decoded VideoFrame, and the pictures the presenter holds (held)
        var held = 0;                            // of them: consumed pictures that wait in the presenter for their frame of the browser
        var support = new Map();                 // 'codec/WxH' → { state: 'pending' | 'ok' | 'no', promise }
        var errors = [];                         // times of decoder errors and watchdog actions
        var videoOff = false;                    // the last 242 said video = 0
        var wdOp = null, wdTimer = null, wdSince = 0;
        var waitingBytes = 0;                    // bytes of the frames in waiting
        var overflows = [], starts = [];         // times of overflows and of decoder creations
        var dqSince = -1, dqTimer = null;        // decodeQueueSize above the limit since this time (-1: not above), and the timer that looks again when the hold time is over
        v.software = tuned() && !isPlayer() && !!(host.softwareGet && host.softwareGet());
        var softwareFromMemory = v.software;      // the software decoder is only what the tab remembers, this session has not shown that the one of the browser fails
        var op3Flags = 0, op3Last = -1e12, op3Timer = null;

        function released(op) {
            if (op.frame !== null) {
                var f = op.frame; op.frame = null; ready--;
                try { f.close(); } catch (ex) { /* already closed by the browser */ }
            }
        }

        // The operation will never get a picture: it is consumed in order and paints nothing
        function settleDiscarded(op) {
            if (op.st === 3) { return; }
            if ((op.st === 0) && (inflight.get(op.ts) === op)) { inflight.delete(op.ts); }
            released(op);
            if (op.st !== 2) { op.st = 2; v.stats.discarded++; }
        }

        function newOp(f) {
            var op = { t: 3, st: 0, bytes: f.data.length, px: 0, img: null, frame: null, dropped: false, seq: f.seq, ts: f.seq, rects: f.rects, codedW: f.codedW, codedH: f.codedH, pos: null, ackTag: null, recv: tick() };
            live.add(op);
            return op;
        }

        // ---- 240 op 3: at most once a second, requests that fall inside the second are merged and sent at its end (10) ----
        function sendOp3Now() {
            op3Timer = null;
            var flags = op3Flags; op3Flags = 0;
            if ((flags === 0) || v.disabled || isPlayer() || !host.sendOp3) { return; }
            op3Last = now(); v.stats.op3++;
            host.sendOp3(flags);
        }
        function op3(flags) {
            if (v.disabled || isPlayer() || !host.sendOp3) { return; }
            op3Flags |= flags;
            var wait = (op3Last + OP3_INTERVAL_MS) - now();
            if (wait <= 0) { if (op3Timer !== null) { clrT(op3Timer); } sendOp3Now(); return; }
            if (op3Timer === null) { op3Timer = setT(sendOp3Now, wait); }
        }

        // ---- the decoder instance ----
        function dqClear() {
            if (dqSince >= 0) { var ms = now() - dqSince; if (ms > v.stats.queueHighMs) { v.stats.queueHighMs = ms; } dqSince = -1; }
            if (dqTimer !== null) { clrT(dqTimer); dqTimer = null; }
        }
        function closeDecoder() {
            dqClear();
            var d = vd; vd = null; cfg = null;
            if (d !== null) { try { if (d.state !== 'closed') { d.close(); } } catch (ex) { /* nothing to do */ } }
            inflight.forEach(function (op) { settleDiscarded(op); });
            inflight.clear();
        }

        // The decoder and everything that waits for it is gone; the next IDR starts again
        function dropStream() {
            token++; starting = null;
            var w = waiting; waiting = []; waitingBytes = 0;
            closeDecoder();
            for (var i = 0; i < w.length; i++) { settleDiscarded(w[i].op); }
            if (wdTimer !== null) { clrT(wdTimer); wdTimer = null; } wdOp = null;
            v.needIdr = true;
            v.stats.resets++;
        }

        function idleCheck() {
            if (videoOff && (live.size === 0) && (vd !== null)) { closeDecoder(); v.curGen = null; v.needIdr = true; }
        }

        function giveUp(why) {
            if (v.disabled) { return; }
            v.disabled = true; v.why = 'errors';
            log('KVM H.264 off: ' + why);
            // the software decoder that the memory of the tab asked for did not carry the video either (too slow, or it fails): the next session of the tab starts with the choice of the browser again
            if (v.software && host.softwareSet) { try { host.softwareSet(false); } catch (ex) { /* no storage */ } }
            dropStream();
            if (!isPlayer() && host.sendOp2) { host.sendOp2(); }
            if (host.changed) { host.changed(); }
            if (host.wake) { host.wake(); }
        }

        // A decoder error or a watchdog action. Not for the player (it has nobody to ask and falls back to the next IDR), not for a reclaimed codec of a hidden tab.
        // hw: the error comes from the decoder (not from a frame that failed the validation): the software decoder is tried once before the video is given up
        function countError(hw) {
            v.stats.errors++;
            if (isPlayer()) { return false; }
            var t = now(); errors.push(t);
            while ((errors.length > 0) && (errors[0] <= (t - ERROR_WINDOW_MS))) { errors.shift(); }
            if (errors.length >= ERROR_LIMIT) {
                if ((hw === true) && trySoftware(ERROR_LIMIT + ' decoder errors in ' + (ERROR_WINDOW_MS / 1000) + ' s')) { return false; }
                giveUp(ERROR_LIMIT + ' decoder errors in ' + (ERROR_WINDOW_MS / 1000) + ' s'); return true;
            }
            return false;
        }

        // A decoder that the browser chose by itself (it prefers the hardware one) can take the configuration and fail at decode(), which isConfigSupported does not tell. Once per tab (the tab remembers it)
        // the same stream goes to the software decoder, with a new error budget, before the video is given up for JPEG. Not for the player, not in the mode without the presenter.
        function trySoftware(why) {
            if (v.software || isPlayer() || !tuned()) { return false; }
            v.software = true; softwareFromMemory = false; v.stats.softwareRetries++; errors = [];
            log('KVM H.264: software decoder after ' + why);
            if (host.softwareSet) { try { host.softwareSet(true); } catch (ex) { /* no storage */ } }
            return true;
        }

        // The software decoder that only the memory of the tab asked for (an earlier session, perhaps a browser that has none) is refused: once back to the choice of the browser, and the memory is forgotten.
        // A decoder that failed in this session is not taken back.
        function tryHardware(why) {
            if (!v.software || !softwareFromMemory || isPlayer() || !tuned()) { return false; }
            v.software = false; softwareFromMemory = false; v.stats.softwareDropped++; errors = [];
            log('KVM H.264: the decoder of the browser again, the software one is not usable (' + why + ')');
            if (host.softwareSet) { try { host.softwareSet(false); } catch (ex) { /* no storage */ } }
            return true;
        }
        function otherDecoder(why) { return tryHardware(why) || trySoftware(why); }

        // The stream or the decoder broke: back to the next IDR, op 3 (flags 3), error budget
        function streamBroken(why, counted, hw) {
            log('KVM H.264 ' + why);
            dropStream();
            if (counted && countError(hw)) { return; }
            op3(3);
            if (host.wake) { host.wake(); }
        }

        // A frame that cannot be decoded (validation, SPS, a stray slice): the decoder itself is fine, but the pictures after it are not. Back to the next IDR.
        function softBreak(why, counted) {
            log('KVM H.264 ' + why);
            v.needIdr = true;
            if (counted && countError()) { return; }
            op3(3);
        }

        function onDecoderError(d, e) {
            if (d !== vd) { return; }
            if ((e != null) && (e.name === 'NotSupportedError')) {     // configure() failed asynchronously (Chrome reports it through error)
                if (otherDecoder('decoder: ' + e.name)) { streamBroken('decoder: ' + e.name + ', the other decoder is tried', false); return; }
                unsupported('decoder: ' + e.name); return;
            }
            var quota = (e != null) && (e.name === 'QuotaExceededError');
            var reclaimedHidden = quota && host.hidden && host.hidden();
            streamBroken('decoder error ' + ((e && e.name) || ''), !reclaimedHidden, true);
        }

        function onOutput(d, frame) {
            var op = (d === vd) ? inflight.get(frame.timestamp) : undefined;
            if ((op === undefined) || (op.st !== 0)) { try { frame.close(); } catch (ex) { /* closed */ } return; }
            inflight.delete(op.ts);
            if (((frame.displayWidth || frame.codedWidth) !== op.codedW) || ((frame.displayHeight || frame.codedHeight) !== op.codedH)) {
                try { frame.close(); } catch (ex) { /* closed */ }
                v.stats.streamErrors++;
                streamBroken('decoded picture is not the size of the frame', true, true);
                return;
            }
            op.frame = frame; op.st = 1; ready++;
            if (ready > v.stats.maxLive) { v.stats.maxLive = ready; }
            // The pictures the presenter holds are open VideoFrames too; a decoder with a small pool of output buffers stops when too many are held, so they are drawn (and closed) first
            if (!isPlayer() && (held > 0) && (ready > MAX_LIVE_FRAMES) && tuned() && host.presenter) {
                var pr = host.presenter();
                if (pr) { v.stats.liveFlushes++; pr.flush(); }
            }
            if (!isPlayer() && ((ready - held) > MAX_READY_FRAMES)) {
                // What stands at the head of the queue tells why the pictures pile up behind it: a tile (or CopyRect) of JPEG that is still being decoded, or something else
                var hd = host.head ? host.head() : null;
                v.stats[((hd !== null) && (hd.t !== 3) && (hd.t !== 0) && (hd.st === 0)) ? 'ovReadyTile' : 'ovReadyOther']++;
                overflow('decoded frames', 'ovReady'); return;
            }
            if (!isPlayer()) { dqCheck(); }
            if (host.wake) { host.wake(); }
        }

        // decodeQueueSize above MAX_DECODE_QUEUE is an overflow when it stays there for OVERFLOW_HOLD_MS (looked at after every decode(), after every output and when the hold time is over);
        // without the presentation switch at once, as before. Far above the limit (MAX_DECODE_QUEUE_HARD) at once in any case.
        function dqCheck() {
            if (vd === null) { dqClear(); return; }
            var n = vd.decodeQueueSize;
            if (n <= MAX_DECODE_QUEUE) { dqClear(); return; }
            if (!tuned() || (n > MAX_DECODE_QUEUE_HARD)) { overflow('decodeQueueSize ' + n, 'ovQueue'); return; }
            var t = now();
            if (dqSince < 0) { dqSince = t; v.stats.queueHigh++; }
            if ((t - dqSince) >= OVERFLOW_HOLD_MS) { overflow('decodeQueueSize ' + n + ' for ' + (t - dqSince) + ' ms', 'ovQueue'); return; }
            if (dqTimer === null) { dqTimer = setT(function () { dqTimer = null; dqCheck(); }, Math.max(1, OVERFLOW_HOLD_MS - (t - dqSince))); }
        }

        // decodeQueueSize above the limit, or too many decoded frames in the queue: only the video operations go, the tiles stay (7.2, no cmd 6)
        function overflow(why, kind) {
            v.stats.overflows++; if (kind) { v.stats[kind]++; }
            log('KVM H.264 overflow: ' + why);
            live.forEach(function (op) { settleDiscarded(op); });
            dropStream();
            // The player has nobody to ask and no counter: it goes on from the next IDR (its feed is slowed by busy(), so this is rare)
            if (isPlayer()) { if (host.wake) { host.wake(); } return; }
            // A client that cannot keep up would loop (overflow, IDR, overflow) while the agent sees quick ACKs for the dropped positions: 3 in 30 s switch the video off
            var t = now(); overflows.push(t);
            while ((overflows.length > 0) && (overflows[0] <= (t - ERROR_WINDOW_MS))) { overflows.shift(); }
            if (overflows.length >= OVERFLOW_LIMIT) { giveUp(OVERFLOW_LIMIT + ' overflows in ' + (ERROR_WINDOW_MS / 1000) + ' s'); return; }
            op3(3);
            if (host.wake) { host.wake(); }
        }

        function unsupported(why) {
            log('KVM H.264 not usable: ' + why);
            v.disabled = true; v.why = 'unsupported';
            if (v.software && host.softwareSet) { try { host.softwareSet(false); } catch (ex) { /* no storage */ } }      // the tab does not remember a decoder that did not work
            dropStream();
            live.forEach(function (op) { settleDiscarded(op); });
            if (!isPlayer() && host.sendOp2) { host.sendOp2(); }
            if (host.changed) { host.changed(); }
            if (host.wake) { host.wake(); }
        }

        function configure(c) {
            var d = null;
            try {
                d = new VD({ output: function (frame) { onOutput(d, frame); }, error: function (e) { onDecoderError(d, e); } });
                d.configure(decoderConfig(c.codec, c.w, c.h, v.software));
            } catch (ex) {
                if (d !== null) { try { d.close(); } catch (e2) { /* closed */ } }
                if (otherDecoder('configure: ' + ((ex && ex.name) || ex))) { return configure(c); }
                unsupported('configure: ' + ((ex && ex.name) || ex));
                return false;
            }
            vd = d; cfg = c;
            return true;
        }

        function decodeNow(f, op, key) {
            if ((vd === null) || (op.st !== 0)) { settleDiscarded(op); return; }
            if (inflight.has(op.ts)) { settleDiscarded(inflight.get(op.ts)); }     // the same timestamp again (an IDR that jumped): the old one cannot be told apart
            inflight.set(op.ts, op);
            var d = vd;
            try { d.decode(new Chunk({ type: key ? 'key' : 'delta', timestamp: op.ts, data: f.data })); }
            catch (ex) { onDecoderError(d, ex); return; }
            v.stats.decoded++;
            if (!isPlayer()) { dqCheck(); }
        }

        function startResolved(tk) {
            if ((tk !== token) || (starting === null)) { return; }
            var st = starting, s = support.get(st.key);
            if (s.state !== 'ok') { unsupported('H.264 ' + st.cfg.codec + ' ' + st.cfg.w + 'x' + st.cfg.h + ' is not supported by this browser'); return; }
            starting = null;
            if (!configure(st.cfg)) { return; }
            var w = waiting; waiting = []; waitingBytes = 0;
            for (var i = 0; i < w.length; i++) { decodeNow(w[i].f, w[i].op, w[i].key); if (vd === null) { break; } }
        }

        // The first IDR of a generation: the decoder is (re)configured from its SPS; isConfigSupported asks the browser once per (codec, size)
        // At most RESTART_MAX decoder creations per second. Live, a creation over the limit is refused (the stream goes on from the next IDR). The player has nobody to ask and
        // must not lose the picture, so it is never refused here: it is slowed in front of the block instead (v.restartWait, used by feedDelay), which keeps the same rate for a
        // recording that a hostile agent filled with IDRs of changing generations. A seek of the user builds a new object (empty history) and feeds its blocks without feedDelay.
        function pruneStarts(t) { while ((starts.length > 0) && (starts[0] <= (t - RESTART_WINDOW_MS))) { starts.shift(); } }
        function restartAllowed() {
            var t = now();
            pruneStarts(t);
            if (!isPlayer() && (starts.length >= RESTART_MAX)) { return false; }
            starts.push(t);
            return true;
        }

        function startGeneration(f, op, c, degraded) {
            token++;
            var tk = token;
            closeDecoder();
            var oldWaiting = waiting; waiting = []; waitingBytes = 0;
            for (var i = 0; i < oldWaiting.length; i++) { settleDiscarded(oldWaiting[i].op); }
            v.curGen = f.gen; v.needIdr = false; v.expectedGen = null; v.degraded = degraded;
            // The IDR that restarts the decoder is the answer to the requests that wait to be sent (merged over the second after the last op 3): their bit IDR is done, the bit repair is not (the pictures
            // that were discarded until this IDR changed regions that nobody painted again). Without this a second IDR of 100 KB followed the first one.
            op3Flags &= ~1;
            v.stats.starts++;
            var key = c.codec + '/' + c.w + 'x' + c.h;
            var s = support.get(key);
            if (!s) {
                s = { state: 'pending', promise: null };
                support.set(key, s);
                v.stats.supportChecks++;
                s.promise = Promise.resolve().then(function () { return VD.isConfigSupported(decoderConfig(c.codec, c.w, c.h)); }).then(
                    function (r) { s.state = (r && r.supported) ? 'ok' : 'no'; },
                    function () { s.state = 'no'; });
            }
            starting = { token: tk, cfg: c, key: key, t0: now() };
            waiting.push({ f: f, op: op, key: true }); waitingBytes += f.data.length;
            if (s.state === 'pending') { s.promise.then(function () { startResolved(tk); }); }
            else { startResolved(tk); }
        }

        // ---- watchdog (7.2) ----
        function watchdogFire() {
            wdTimer = null;
            var op = wdOp;
            if ((op === null) || (op.st !== 0) || !live.has(op) || (host.head && (host.head() !== op))) { wdOp = null; return; }
            var busy = false;
            if (starting !== null) { busy = (now() - starting.t0) < SUPPORT_MAX_MS; if (!busy) { unsupported('isConfigSupported did not answer'); return; } }
            else if ((vd !== null) && (vd.decodeQueueSize > 0)) {
                busy = (now() - wdSince) < HARD_HEAD_MS;      // a busy decoder is waited for, but not forever: a hung one never calls error
            }
            if (busy) { wdTimer = setT(watchdogFire, WATCHDOG_MS); return; }
            v.stats.watchdogs++;
            wdOp = null;
            streamBroken('no output for ' + WATCHDOG_MS + ' ms at the head of the queue' + (v.degraded ? ' (SPS without VUI)' : ''), true, true);
        }

        // ---- the interface to the viewer ----
        // 242 (valid) from the agent
        v.onState = function (st) {
            videoOff = !((st.video === 1) && (st.ack === 1));
            if (!videoOff) {
                // The agent repeats its current state in several situations; only a new generation needs an IDR
                if (st.gen !== v.curGen) { v.needIdr = true; v.expectedGen = st.gen; }
            }
            idleCheck();
        };

        // 243 frame (not a marker) that the viewer accepted for decoding. gap: its seq does not follow the last one. → the op for the queue (t3)
        v.accept = function (f, gap) {
            var op = newOp(f);
            v.stats.accepted++;
            if (v.disabled || (VD === null) || (Chunk === null)) { settleDiscarded(op); return op; }
            if (f.idr === false && (v.expectedGen !== null) && (f.gen !== v.expectedGen)) { settleDiscarded(op); return op; }
            if (gap && !f.idr) {
                v.stats.gaps++;
                v.needIdr = true; op3(3);
                settleDiscarded(op); return op;
            }
            if (f.idr) {
                var a;
                try { a = analyse(f.data, av, f.codedW, f.codedH, true); }
                catch (ex) { v.stats.streamErrors++; softBreak('bad IDR: ' + (ex && ex.message), true); settleDiscarded(op); return op; }
                var c = { codec: a.info.codec, w: a.info.codedWidth, h: a.info.codedHeight, sps: a.spsBytes, id: a.info.id };
                if ((f.gen === v.curGen) && !v.needIdr && ((vd !== null) || (starting !== null))) {
                    var cur = (starting !== null) ? starting.cfg : cfg;
                    if ((cur === null) || (c.codec !== cur.codec) || (c.w !== cur.w) || (c.h !== cur.h)) {
                        v.stats.streamErrors++; softBreak('another SPS in the same generation', true); settleDiscarded(op); return op;
                    }
                    submit(f, op, true);
                    return op;
                }
                if (!restartAllowed()) { v.stats.restartLimited++; softBreak('the decoder is restarted too often', false); settleDiscarded(op); return op; }   // not an error: a burst of size changes does this (N2)
                startGeneration(f, op, c, !a.info.vuiOk);
                return op;
            }
            if ((f.gen !== v.curGen) || v.needIdr) {
                v.needIdr = true; op3(3);
                settleDiscarded(op); return op;
            }
            try { analyse(f.data, av, f.codedW, f.codedH, false, (starting !== null) ? starting.cfg : cfg); }
            catch (ex) { v.stats.streamErrors++; softBreak('bad frame: ' + (ex && ex.message), true); settleDiscarded(op); return op; }
            submit(f, op, false);
            return op;
        };

        function submit(f, op, key) {
            if (starting !== null) {
                if ((waiting.length >= MAX_WAITING) || ((waitingBytes + f.data.length) > MAX_WAITING_BYTES)) { settleDiscarded(op); overflow('frames waiting for isConfigSupported', 'ovWait'); return; }
                waiting.push({ f: f, op: op, key: key }); waitingBytes += f.data.length;
                return;
            }
            decodeNow(f, op, key);
        }

        // A position that is not usable (a frame that failed validation, a seq gap on a marker) while video is on
        v.gap = function () { v.stats.gaps++; v.needIdr = true; op3(3); };
        v.streamError = function (why) {
            v.stats.streamErrors++;
            if (v.disabled) { return; }
            softBreak('invalid frame: ' + why, true);
        };

        // The queue consumes the op: paints it when it holds a picture, then closes the picture. → true when something was painted
        // With a presenter the op is consumed and acknowledged at once, as before, but the drawing waits for the next frame of the browser: the presenter owns the picture then
        v.consume = function (op, ctx) {
            live.delete(op);
            var painted = false;
            try {
                if ((op.st === 1) && (op.frame !== null) && (ctx != null)) {
                    var pr = host.presenter ? host.presenter() : null;
                    if (pr) { handOver(pr, ctx, op); } else { paint(ctx, op.frame, op.rects, op.codedW, op.codedH); }
                    painted = true; v.stats.painted++;
                }
            } finally {
                released(op);
                op.st = 3;
            }
            idleCheck();
            return painted;
        };
        // The queue dropped the op
        v.dropped = function (op) {
            live.delete(op);
            op.dropped = true;
            settleDiscarded(op);
            idleCheck();
        };

        function paint(ctx, frame, rects, codedW, codedH) {
            var rx = host.rotX, ry = host.rotY, i, r;
            ctx.save();
            try {
                ctx.beginPath();
                for (i = 0; i < rects.length; i++) { r = rects[i]; ctx.rect(rx(r.x, r.y), ry(r.x, r.y), r.w, r.h); }
                ctx.clip();
                ctx.drawImage(frame, 0, 0, codedW, codedH, rx(0, 0), ry(0, 0), codedW, codedH);
            } finally { ctx.restore(); }
        }

        // The picture of a consumed op goes to the presenter, which draws it (inside the rectangles of its frame, in order) and closes it, or closes it unpainted when it is discarded
        function handOver(pr, ctx, op) {
            var f = op.frame, rects = op.rects, w = op.codedW, h = op.codedH, recv = op.recv;
            op.frame = null; held++;            // the picture stays in `ready` (the limit of live VideoFrames) until it is drawn or dropped
            var done = function () { held--; ready--; try { f.close(); } catch (ex) { /* closed */ } };
            pr.submit(function () { try { paint(ctx, f, rects, w, h); } finally { done(); } }, done, true, 0, recv);
        }

        // The head of the queue changed (called after every drain): arms the watchdog for a frame that waits for its picture
        v.headChanged = function (op) {
            if ((op !== null) && (op.t === 3) && (op.st === 0)) {
                if (wdOp === op) { return; }
                if (wdTimer !== null) { clrT(wdTimer); }
                wdOp = op; wdSince = now(); wdTimer = setT(watchdogFire, WATCHDOG_MS);
            } else if (wdOp !== null) {
                if (wdTimer !== null) { clrT(wdTimer); wdTimer = null; }
                wdOp = null;
            }
        };

        // cmd 7 with a new size (the queue is dropped already): the decoder goes, the next IDR (of the new generation) restarts it. lastSeq stays (the viewer's).
        v.screenChanged = function () {
            dropStream();
            v.curGen = null; v.expectedGen = null; v.needIdr = true;
        };

        // A new connection, or the end of one: everything starts from scratch
        v.reset = function () {
            live.forEach(function (op) { settleDiscarded(op); });
            live.clear();
            dropStream();
            v.curGen = null; v.expectedGen = null; v.needIdr = true; v.disabled = false; v.why = null; v.degraded = false;
            errors = []; videoOff = false;
            if (op3Timer !== null) { clrT(op3Timer); op3Timer = null; }
            op3Flags = 0; op3Last = -1e12;
            support.forEach(function (s, k) { if (s.state !== 'ok') { support.delete(k); } });
        };
        v.close = function () { v.reset(); };

        // Canvas damage that is not a lost decoder: tiles of the video are sent again as JPEG (7.3). flags 2 repair, 3 repair and IDR
        v.repair = function (flags) { op3(flags || 2); };

        // The player feeds blocks faster than a slow decoder takes them: true while the decoder or the picture queue is full (7.5, back pressure)
        // The player: milliseconds until a decoder may be created again (0: now). feedDelay waits this long in front of the next block (7.5)
        v.restartWait = function () {
            if (!isPlayer()) { return 0; }
            var t = now();
            pruneStarts(t);
            return (starts.length < RESTART_MAX) ? 0 : Math.max(1, (starts[starts.length - RESTART_MAX] + RESTART_WINDOW_MS) - t);
        };
        v.busy = function () { return (ready >= MAX_READY_FRAMES) || ((vd !== null) && (vd.decodeQueueSize >= MAX_DECODE_QUEUE)) || (waiting.length >= MAX_WAITING); };
        v.info = function () { return { curGen: v.curGen, needIdr: v.needIdr, expectedGen: v.expectedGen, disabled: v.disabled, why: v.why, degraded: v.degraded, live: live.size, inflight: inflight.size, waiting: waiting.length, ready: ready, held: held, software: v.software, configured: (cfg === null) ? null : { codec: cfg.codec, w: cfg.w, h: cfg.h }, errors: errors.length }; };
        return v;
    }

    // ---- presentation of the pictures ----
    // The decoder hands out pictures when the stream delivers them, with the jitter of the network and of the decoder; the display takes one picture per frame of the browser. Two pictures that land
    // in one display interval show only the second, and the next interval has none (on a 60 Hz display 15 % of the pictures of a 60 pictures/s video were never seen). The presenter draws video
    // pictures in requestAnimationFrame, one per frame, and keeps the surplus for the next frame: no picture is dropped, and when more pictures wait than the target allows the older ones are drawn in the
    // same frame (all of them are drawn, in order, so no region of an older picture is lost; the display shows the last). That is the only way a picture is "trimmed": never by dropping its rectangles.
    // The target follows the queue of the last HISTORY_MS (after the rule of a frame pacer): while the queue was short (at most one picture at the start of a frame) at least once, a burst drains by itself and
    // up to LOOSE pictures may stay behind (1 by default, see PRES_LOOSE); when it was never short for the whole window the surplus is lasting and the queue is cut back to TIGHT. A display that shows a frame every SLOW_MS or more takes every picture.
    // Anything drawn behind a waiting picture (JPEG tiles, CopyRect) waits in the same line, so the order of drawing is the order of the queue. Without a waiting picture a tile is drawn at once.
    // The meter counts what the display gets: pictures replaced by a later one of the same frame, the time from the arrival of a picture to its frame, the time of paint(), long animation frames.
    // host: { raf(fn) → id, cancelRaf(id), setTimeout, clearTimeout, hidden() → bool, now() → ms (monotonic, optional), loaf(fn(entry)) → stop function or null (optional), log(msg) }
    // o: { backlog (a number: the fixed target, no history), loose (1), tight (0), historyMs (500), stallMs (100), maxVideo (4; 3 with a fixed target), slowMs (19), maxBehind, maxBehindPx }
    var PRES_LOOSE = 1, PRES_TIGHT = 0, PRES_HISTORY_MS = 500, PRES_SAMPLES = 512, PRES_SLOW_MS = 19;
    // PRES_LOOSE 1 (up to 2 pictures may wait) on recorded arrivals of a laptop it equals the fixed backlog (1.27 lost presentations / s, 11.8 ms added) and, unlike it, cuts a
    // lasting surplus (60.5 pictures / s on 59.94 Hz: 13.3 -> 7.7 ms). 2 (up to 3 may wait) gained 0.17 lost / s on `video` for +2.4 ms, which one session cannot show, and +8.6 ms on `burst`; it stays selectable
    // (?kvmpresentloose=2, localStorage kvmPresentLoose, the measurement tools) until a measurement shows a gain of 0.3 / s for at most +5 ms.
    // A display whose frame is longer than this takes every picture at once (target 0). The pictures of the agent come at most every 16.7 ms (60 / s): a display slower than ~53 Hz gets more than one
    // picture per frame on average, so a picture kept back cannot be shown in a frame that would stay empty (the queue never drains) and only adds delay. 19 ms puts 50 Hz (20 ms) and 48 Hz (20.8 ms) in,
    // and 60 Hz (16.7 ms) and faster out; the measured period is the smallest of the last frames (a stall of the page does not make a 60 Hz display slow). In a simulation (60 pictures/s, a 50 Hz grid) the added
    // delay is 0 ms against 26 ms with the target (16 ms at the fixed backlog 1), for 1 % fewer presentations. The earlier value (22 ms) left 50 Hz and 48 Hz with the target.
    function createPresenter(host, o) {
        o = o || {};
        var fixed = (o.backlog >= 0), fixedLeft = fixed ? o.backlog : 1, tight = (o.tight >= 0) ? o.tight : PRES_TIGHT, loose = (o.loose >= 0) ? o.loose : PRES_LOOSE, historyMs = o.historyMs || PRES_HISTORY_MS;
        var stallMs = o.stallMs || 100, maxVideoOf = function () { return o.maxVideo || (fixed ? 3 : Math.max(3, loose + 2)); };
        var slowMs = o.slowMs || PRES_SLOW_MS, maxBehind = o.maxBehind || 64, maxBehindPx = o.maxBehindPx || (1 << 19);
        var q = [], nVideo = 0, nBehind = 0, pxBehind = 0, rafId = null, timer = null, stalled = false;
        // The period of the frames of the browser: the smallest of the last PERIODS gaps between consecutive frames (frames asked for by the frame before). One long frame (a hiccup, a stall) lengthens single
        // gaps only; a display that really shows a frame every 33 ms gives only gaps of 33 ms. It is measured in every mode, so that a display that gets faster is noticed.
        var PERIODS = 12, gaps = [], period = 0, lastT = -1, chained = false;
        var histT = [], histN = [], chainT0 = 0;        // the queue at the start of the frames of this chain (a frame that nothing asked for starts a new chain: the queue was empty before it)
        var stats = { submitted: 0, immediate: 0, queued: 0, frames: 0, extra: 0, stalls: 0, flushed: 0, discarded: 0, maxQueue: 0, behindFlushes: 0, slowFrames: 0, slowMs: 0, periodMs: 0,
            looseFrames: 0, tightFrames: 0, drawn: 0, replaced: 0, recvSumMs: 0, recvMaxMs: 0, paintSumMs: 0, paintMaxMs: 0, loafN: 0, loafMs: 0, loafBlockMs: 0, loafMaxMs: 0 };
        var p = { stats: stats };
        var setT = function (fn, ms) { return (host.setTimeout || setTimeout)(fn, ms); };
        var clrT = function (h) { (host.clearTimeout || clearTimeout)(h); };
        var clock = function () { return host.now ? host.now() : (((typeof performance === 'object') && performance && performance.now) ? performance.now() : Date.now()); };
        var recvS = new Array(PRES_SAMPLES), paintS = new Array(PRES_SAMPLES), nS = 0, loafStop = null, loafTried = false, loafEver = false;

        function run(fn) { try { fn(); } catch (ex) { if (host.log) { host.log('presenter: ' + (ex && ex.message)); } } }
        function usable() { return (typeof host.raf === 'function') && !stalled && !(host.hidden && host.hidden()); }
        function arm(fromFrame) {
            if (rafId === null) { rafId = host.raf(onFrame); chained = (fromFrame === true); }
            if (timer === null) { timer = setT(onStall, stallMs); }
        }
        function disarm() {
            if (timer !== null) { clrT(timer); timer = null; }
            if ((rafId !== null) && host.cancelRaf) { host.cancelRaf(rafId); }
            rafId = null; chained = false; histT.length = 0; histN.length = 0;
            stalled = false;            // the probe frame that would have ended the stall is gone: the next picture asks for a frame again
        }
        // Draws one item; a video picture is measured (time since it arrived, time of paint()) and counted
        function drawItem(it, at) {
            if (!it.video) { run(it.draw); return; }
            var a = clock();
            run(it.draw);
            var b = clock(), r = (it.recv > 0) ? (at - it.recv) : -1, d = b - a;
            stats.drawn++;
            if (r >= 0) { stats.recvSumMs += r; if (r > stats.recvMaxMs) { stats.recvMaxMs = r; } }
            stats.paintSumMs += d; if (d > stats.paintMaxMs) { stats.paintMaxMs = d; }
            recvS[nS % PRES_SAMPLES] = r; paintS[nS % PRES_SAMPLES] = d; nS++;
        }
        // The queue at the start of this frame, against the window of the last historyMs: how many pictures may stay behind after it
        function target(now, wasChained, len) {
            if (!wasChained) { histT.length = 0; histN.length = 0; chainT0 = now; }
            histT.push(now); histN.push(len);
            while ((histT.length > 1) && (histT[0] < (now - historyMs))) { histT.shift(); histN.shift(); }
            var min = 1e9; for (var i = 0; i < histN.length; i++) { if (histN[i] < min) { min = histN[i]; } }
            return (((now - chainT0) >= historyMs) && (min >= 2)) ? tight : loose;
        }
        function onFrame(t) {
            rafId = null;
            if (timer !== null) { clrT(timer); timer = null; }
            stalled = false;
            var at = clock(), slowDt = 0;
            if (typeof t === 'number') {
                if (chained && (lastT >= 0)) {
                    var dt = t - lastT;
                    if (dt > 2) {
                        gaps.push(dt); if (gaps.length > PERIODS) { gaps.shift(); }
                        period = Math.min.apply(null, gaps); stats.periodMs = Math.round(period * 10) / 10;
                        slowDt = dt;
                    }
                }
                lastT = t;
            }
            var wasChained = chained;
            chained = false;
            // a display that shows a frame every PRES_SLOW_MS or more (50 Hz and below, 30 Hz power saving) takes every waiting picture: keeping one back would only delay it
            var slow = (period > slowMs), left;
            if (slow) { left = 0; histT.length = 0; histN.length = 0; }
            else if (fixed) { left = fixedLeft; }
            else { left = target((typeof t === 'number') ? t : at, wasChained, nVideo); if (left === loose) { stats.looseFrames++; } else { stats.tightFrames++; } }
            var allow = Math.max(1, nVideo - left), n = 0, it;
            stats.frames++; if (slow) { stats.slowFrames++; if (wasChained) { stats.slowMs += slowDt; } }
            while (q.length > 0) {
                it = q[0];
                if (it.video) { if (n >= allow) { break; } n++; nVideo--; } else { nBehind--; pxBehind -= it.cost; }
                q.shift(); drawItem(it, at);
            }
            if (n > 1) { stats.extra += n - 1; stats.replaced += n - 1; }
            if (q.length > 0) { arm(true); }
            else if (slow && (n > 0) && (rafId === null)) { rafId = host.raf(onFrame); chained = true; }   // slow: ask for one more frame (no stall timer) to keep measuring; it can only get faster than it is
        }
        // The browser gave no frame for stallMs (a tab in the background, a window nobody sees): draw everything and draw at once until a frame comes again
        function onStall() {
            timer = null;
            stats.stalls++; stalled = true;
            p.flush();
            if (rafId === null) { rafId = host.raf(onFrame); chained = false; }
        }
        // Long animation frames of the page (where the browser has the API): they say whether the main thread, not the arrival of the pictures, is what costs frames
        function loafStart() {
            if (loafTried) { return; }
            loafTried = true;
            if (typeof host.loaf !== 'function') { return; }
            try {
                loafStop = host.loaf(function (e) {
                    if (loafStop === null) { return; }       // closed (an entry that was already on its way)
                    var d = +e.duration || 0, bl = +e.blockingDuration || 0;
                    stats.loafN++; stats.loafMs += d; stats.loafBlockMs += bl; if (d > stats.loafMaxMs) { stats.loafMaxMs = d; }
                });
            } catch (ex) { loafStop = null; }
            if (loafStop) { loafEver = true; }
        }

        // draw: function (), drop: function () (the item leaves unpainted), video: a picture that takes a frame of the browser, cost: pixels of a tile or CopyRect (it is drawn behind a picture),
        // recv: the time the picture arrived in the viewer (the clock of host.now), for the meter
        p.submit = function (draw, drop, video, cost, recv) {
            stats.submitted++;
            loafStart();
            if (!usable()) { p.flush(); stats.immediate++; drawItem({ draw: draw, video: video === true, recv: recv }, clock()); return; }
            if (!video && (q.length === 0)) { stats.immediate++; run(draw); return; }
            q.push({ draw: draw, drop: drop, video: video === true, cost: cost || 0, recv: recv });
            if (video === true) { nVideo++; } else { nBehind++; pxBehind += (cost || 0); }
            stats.queued++;
            if (q.length > stats.maxQueue) { stats.maxQueue = q.length; }
            // too many pictures at once (a decoder that was stuck), or a refresh behind a picture (it must not become one long callback of the frame): back to drawing at once
            if (nVideo > maxVideoOf()) { p.flush(); return; }
            if ((nBehind > maxBehind) || (pxBehind > maxBehindPx)) { stats.behindFlushes++; p.flush(); return; }
            arm(false);
        };
        // true while something waits: whatever is drawn now must take its place behind it
        p.busy = function () { return q.length > 0; };
        p.pending = function () { return q.length; };
        p.period = function () { return period; };
        // draws everything that waits, in order (the canvas is about to be read or changed, or the page cannot show frames)
        p.flush = function () {
            var it, k = 0, at = clock();
            if (q.length > 0) { stats.flushed++; }
            while (q.length > 0) { it = q.shift(); if (it.video) { k++; } drawItem(it, at); }
            if (k > 1) { stats.replaced += k - 1; }
            nVideo = 0; nBehind = 0; pxBehind = 0;
            if (timer !== null) { clrT(timer); timer = null; }
        };
        // lets everything that waits go unpainted (the screen it belongs to is gone)
        p.discard = function () {
            var it;
            while (q.length > 0) { it = q.shift(); stats.discarded++; run(it.drop); }
            nVideo = 0; nBehind = 0; pxBehind = 0;
            disarm();
        };
        // The fixed target (one picture may stay behind, no history) or the adaptive one (the default); switchable while the viewer runs (the A/B of the measurement)
        p.setFixed = function (f) { f = (f === true); if (f !== fixed) { fixed = f; histT.length = 0; histN.length = 0; } };
        // Stops the observer of the long animation frames (the viewer is closed for good); a later picture starts it again
        p.close = function () { if (loafStop) { try { loafStop(); } catch (ex) { /* gone */ } } loafStop = null; loafTried = false; };
        // The meter of the last PRES_SAMPLES pictures: arrival → drawn in the frame of the browser (the display shows it at the end of that frame, about one period later), paint() and the long animation
        // frames since the first picture (null: the browser does not have the API or never had an observer here; the numbers stay after close(), active says whether it still observes). Percentiles: nearest rank.
        p.meter = function () {
            var n = Math.min(nS, PRES_SAMPLES), r = [], d = [], i;
            for (i = 0; i < n; i++) { if (recvS[i] >= 0) { r.push(recvS[i]); } d.push(paintS[i]); }
            var pct = function (a, f) { if (a.length === 0) { return null; } a = a.slice().sort(function (x, y) { return x - y; }); return Math.round(a[Math.min(a.length - 1, Math.ceil(f * a.length) - 1)] * 10) / 10; };
            var avg = function (a) { return (a.length === 0) ? null : Math.round((a.reduce(function (x, y) { return x + y; }, 0) / a.length) * 10) / 10; };
            return {
                samples: n, recvMeanMs: avg(r), recvP95Ms: pct(r, 0.95), recvMaxMs: pct(r, 1), paintMeanMs: avg(d), paintP95Ms: pct(d, 0.95), paintMaxMs: pct(d, 1),
                loaf: loafEver ? { n: stats.loafN, ms: Math.round(stats.loafMs), blockingMs: Math.round(stats.loafBlockMs), maxMs: Math.round(stats.loafMaxMs), active: loafStop !== null } : null,
                periodMs: stats.periodMs, mode: fixed ? 'fixed' : 'adaptive', loose: loose, tight: tight
            };
        };
        return p;
    }

    return { create: create, createPresenter: createPresenter, PRES_SLOW_MS: PRES_SLOW_MS, PRES_LOOSE: PRES_LOOSE, PRES_TIGHT: PRES_TIGHT, PRES_HISTORY_MS: PRES_HISTORY_MS, detect: detect, available: available, sessionEncoding: sessionEncoding, applyEncoding: applyEncoding, splitRecordedCommand: splitRecordedCommand, feedDelay: feedDelay, seekSpan: seekSpan, replayBlocks: replayBlocks, ENCODING: ENCODING, parseFrame: parseFrame, validLevel: validLevel, analyse: analyse, parseSpsExtra: parseSpsExtra, decoderConfig: decoderConfig, PROFILES: PROFILES, WATCHDOG_MS: WATCHDOG_MS };
});
