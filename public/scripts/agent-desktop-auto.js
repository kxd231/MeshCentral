/**
* @description KVM Auto in the browser (the viewer side of Auto of the agent): the frame interval (command 5: 16 / 33 / 50 / 66 / 100 ms) chosen from what this viewer receives, when the agent does not
* choose it itself (an agent without Auto, JPEG, a second viewer). A full link is seen by the delay of the data (the times of the agent in the markers and frames; a probe `rtt` through the agent in a relay 1:1
* for JPEG without ACK), never by the bytes alone. decide() is a pure state machine with the parameters of kvm_auto of the agent;
* create(host) is the driver: it counts what arrives (note), closes a window of one second, asks decide() and sends the interval through host.send().
* One owner at a time (host.owner()): the viewer, the agent (the module only measures), nobody (frozen, off, unavailable). The module never touches the quality of the text at rest: it is given
* the interval only, the page repeats quality, scale and budget of the user in every command 5 (SendCompressionLevel of agent-desktop-0.0.2.js).
* Usable from a browser page (global AgentDesktopAuto) and from Node (require), where the tests drive a fake clock.
* @license Apache-2.0
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(root); }
    else { root.AgentDesktopAuto = factory(root); }
})((typeof self !== 'undefined') ? self : this, function (root) {
    'use strict';

    // ---- the parameters of kvm_auto (the agent): the same values, so that both sides behave alike ----
    var STEP_MS = [16, 33, 50, 66, 100], STEP_FPS = [60, 30, 20, 15, 10];
    var WINDOW_MS = 1000;           // KVM_AUTO_WINDOW_MS
    var MIN_MOTION_MS = 300;        // KVM_AUTO_MIN_MOTION_MS: a window with less motion is not evaluated
    var SLOT_MS = 100;              // KVM_AUTO_SLOT_MS
    var DOWN_WINDOWS = 2;           // KVM_AUTO_DOWN_WINDOWS
    var UP_WINDOWS = 4;             // KVM_AUTO_UP_WINDOWS: the first patience
    var UP_MAX = 120;               // KVM_AUTO_UP_MAX: the patience grows 4, 8, 16, 32, 64, 120 after a failed attempt
    var FAIL_MS = 10000;            // KVM_AUTO_FAIL_MS: a step down this soon after a step up is a failed attempt
    var STABLE_MS = 60000;          // KVM_AUTO_STABLE_MS: a step up that holds this long is a success, the patience is the first one again
    var MIN_CHANGE_MS = 2000;       // KVM_AUTO_MIN_CHANGE_MS
    var UP_AFTER_MS = 4000;         // KVM_AUTO_UP_AFTER_MS
    var STALE_MS = 30000;           // KVM_AUTO_STALE_MS: evaluated windows further apart do not make a streak
    var KEEP_PCT = 75;              // KVM_AUTO_KEEP_PCT: achieved / target below this
    var SAT_PCT = 85;               // KVM_AUTO_SAT_PCT: a step up only when the frames of the current step are made at this share
    // ---- what only the viewer has (design 3.1, 3.4) ----
    var LAG_DOWN_MS = 150, LAG_FULL_MS = 50, LAG_UP_MS = 50;   // the delay of the data over its minimum (L): above 150 ms the link queues; with fps under 75 % of the target already above 50 ms it is full; for a step up the P90 is under 50 ms
    var LINK_WAIT = 64;             // a step down because the data queue (lag, link) is not tried again sooner than this many evaluated windows: a link that queued at this step queues again at once (a link of 3 Mb/s: up after 5 s and 9 s,
                                    // each time down again, 5 changes in 23 s); the patience of a failed attempt doubles from there, to UP_MAX. A step down because the viewer does not keep up (decoder) keeps the patience of the agent (4, 8, 16 ...)
    var FAST_MS = 10000;            // after a step from the memory: one window is enough for a step down, down to Medium
    var MEMORY_MAX_AGE_MS = 10 * 60 * 1000, MEMORY_HOLD_MS = 10000, MEMORY_MIN_EVALS = 3;
    var PENDING_MS = 5000;          // 242 "not yet" (reason 0, 10, 11) is waited for this long, then it is as a fallback (N-c)
    var RHAT_BUCKET_MS = 250, RHAT_HORIZON_MS = 10000;      // the best rate seen (buckets of 250 ms, 10 s): only for the measures and for the time that a slow message takes. It is not a rule: the bytes alone do not tell a slow source from a full link
    var LAG_MIN_MS = 60000;         // the minimum of the delay is taken over this long (the probe of the agent empties the pipe every 10 s)
    var SERIES_GAP_MS = 250;        // messages closer than this are one series of motion
    var START_QUIET_MS = 200, START_MAX_MS = 5000;          // the first picture of a session is over after this silence, or this long (N-d)
    var HIDDEN_STEP = 4;            // a hidden tab: 100 ms
    var PROBE_GIVEUP = 3;           // probes (one a second) without an answer after which the path has no probe (a multiplexor drops them)
    var PROBE_DOWN_MS = 150, PROBE_UP_MS = 50;

    function stepOf(ms) { for (var i = 0; i < STEP_MS.length; i++) { if (STEP_MS[i] === ms) { return i; } } return -1; }
    // The fastest step that the display can show (design 3.1, N5): a period up to 26 ms shows 60, up to 42 ms 30, more 20
    function screenLimit(periodMs) { if (!(periodMs > 0)) { return 0; } return (periodMs <= 26) ? 0 : ((periodMs <= 42) ? 1 : 2); }
    // The step that matches the frames a viewer received per second (the takeover from the agent): the fastest one that is not faster than the rate seen
    function stepForFps(fps) { for (var i = 0; i < STEP_FPS.length; i++) { if (STEP_FPS[i] <= (fps * 1.1)) { return i; } } return STEP_FPS.length - 1; }

    // ---- the state machine ----
    function newState(step) {
        return { step: (step >= 0) ? step : 1, downStreak: 0, upStreak: 0, upNeed: UP_WINDOWS, haveUp: false, lastUpAt: 0, upStep: 0, haveChange: false, lastChangeAt: 0,
            haveEval: false, lastEvalAt: 0, evals: 0, fastUntil: 0, changes: 0, downs: 0, ups: 0 };
    }
    // A step that comes from the memory of the device: it is not an attempt upwards, and a step down is quick for a while
    function applyMemory(a, step, now) {
        a.step = step; a.fastUntil = now + FAST_MS; a.downStreak = 0; a.upStreak = 0; a.haveUp = false;
    }
    // w.maxDown: the slowest step a down may reach (a probe that never answered is only half proof: step 2).
    // w: { mode: 'ts' (H.264, JPEG with ACK: the delay L comes from the times of the agent) | 'probe' (JPEG without ACK in a relay 1:1: L' of the probe rtt) | 'none' (no measure of the link: Medium),
    //      motionMs, made (frames of the window, null: not known), lag (the median of L of the window, ms, null), lagUp (its P90), probe (the median of L' of the window), probeMax (its largest),
    //      behind (this viewer does not keep up), ovq (the decoder queue overflowed), frozen, limit (the fastest step the display shows) }.
    // → { step, changed, reason: 'screen' | 'link' | 'lag' | 'viewer' | 'back' | null }
    function decide(a, w, now) {
        var out = { step: a.step, changed: false, reason: null };
        var cap = (w.mode === 'none') ? Math.max(w.limit, 1) : w.limit;          // without a measure of the link not faster than Medium
        if (a.step < cap) {         // a ceiling from outside is not held back by the time between steps
            a.step = cap; a.downStreak = 0; a.upStreak = 0; a.haveUp = false; a.haveChange = true; a.lastChangeAt = now; a.changes++; a.downs++;
            out.step = a.step; out.changed = true; out.reason = 'screen'; return out;
        }
        if (a.haveUp && (a.step === a.upStep) && ((now - a.lastUpAt) >= STABLE_MS)) { a.upNeed = UP_WINDOWS; a.haveUp = false; }
        // not evaluated: the streaks stay; a probe that is not answered while data come is evidence of a queue whatever the motion (huge messages on a slow link are one a second or less)
        if (w.frozen || ((w.motionMs < MIN_MOTION_MS) && !((w.mode === 'probe') && (w.probe != null) && (w.probe > PROBE_DOWN_MS)))) { return out; }
        if (a.haveEval && ((now - a.lastEvalAt) > STALE_MS)) { a.downStreak = 0; a.upStreak = 0; }
        a.lastEvalAt = now; a.haveEval = true; a.evals++;
        var target = STEP_FPS[a.step], fps = (w.made == null) ? null : ((w.made * 1000) / w.motionMs);
        var fast = (now < a.fastUntil) && (a.step === 0);
        var behind = !!w.behind, full = false, lag = false, room = false;
        if (w.mode === 'ts') {
            full = (fps != null) && (fps < ((target * KEEP_PCT) / 100)) && (w.lag != null) && (w.lag > LAG_FULL_MS);      // the frames are not made and the data queues
            lag = (w.lag != null) && (w.lag > LAG_DOWN_MS);
            room = (fps != null) && (fps >= ((target * SAT_PCT) / 100)) && (w.lagUp != null) && (w.lagUp < LAG_UP_MS);       // the frames are made and the data does not queue
        } else if (w.mode === 'probe') {
            lag = (w.probe != null) && (w.probe > PROBE_DOWN_MS);
            room = (w.probeMax != null) && (w.probeMax < PROBE_UP_MS);        // the granularity of the frames is not seen: no fps
        } else { room = true; }
        var down = full || lag || behind;
        room = room && !down && (a.step > cap);
        if (down) { a.downStreak += w.ovq ? DOWN_WINDOWS : 1; a.upStreak = 0; }
        else { a.downStreak = 0; if (room) { a.upStreak++; } else { a.upStreak = 0; } }
        var needDown = (fast && (full || lag)) ? 1 : DOWN_WINDOWS;
        if ((a.downStreak >= needDown) && (a.step < ((w.maxDown != null) ? w.maxDown : (STEP_MS.length - 1))) && (!a.haveChange || ((now - a.lastChangeAt) >= MIN_CHANGE_MS) || (fast && (full || lag)))) {
            if (a.haveUp && ((now - a.lastUpAt) <= FAIL_MS)) { a.upNeed = Math.min(a.upNeed * 2, UP_MAX); }
            if (full || lag) { a.upNeed = Math.max(a.upNeed, LINK_WAIT); }
            a.haveUp = false; a.step++; a.downStreak = 0; a.upStreak = 0; a.fastUntil = 0;
            a.haveChange = true; a.lastChangeAt = now; a.changes++; a.downs++;
            out.step = a.step; out.changed = true; out.reason = full ? 'link' : (lag ? 'lag' : 'viewer');
            return out;
        }
        if (room && (a.upStreak >= a.upNeed) && (!a.haveChange || ((now - a.lastChangeAt) >= UP_AFTER_MS))) {
            a.step--; a.haveUp = true; a.lastUpAt = now; a.upStep = a.step; a.upStreak = 0; a.downStreak = 0;
            a.haveChange = true; a.lastChangeAt = now; a.changes++; a.ups++;
            out.step = a.step; out.changed = true; out.reason = 'back';
        }
        return out;
    }

    // ---- the driver ----
    // host: { now(), setTimeout, clearTimeout, raf(fn), cancelRaf(id), hidden() → bool, send(ms) → the command 5 with this interval,
    //         owner() → 'viewer' | 'agent' | 'frozen' | 'off' | 'unavailable', path() → 'h264' | 'jpeg-ack' | 'jpeg', sample() → { pending, ovQueue, queueHigh, queueOverflows } (counters of the viewer),
    //         proven() → true when an `rtt` was answered in this session at all (the one the transport sends at the connect), probe() → sends one `rtt` (a relay 1:1 answers it through the agent), isMux() → true for a multiplexing server (it drops `rtt`), the host calls c.probeSample(ms) for every answer,
    //         memGet(path) → { step, t } | null, memSet(path, step, t), changed(info), log(msg); now() is a monotonic clock (performance.now: a jump of the wall clock must not look like a delay), wall() (optional, else now()) the wall
    //         clock of the memory of the step }
    function create(host) {
        var now = function () { return host.now(); };
        var wall = function () { return host.wall ? host.wall() : host.now(); };
        var setT = function (fn, ms) { return (host.setTimeout || setTimeout)(fn, ms); };
        var clrT = function (h) { (host.clearTimeout || clearTimeout)(h); };
        var a = newState(1), c = { state: a };
        var timer = null, running = false;
        var winStart = 0, acc, buckets = {}, lagBins = [], lagWin = [], rhat = 0, lastSample = null, pendingPrev = 0, pendingUp = 0;
        var probeBins = [], probeWin = [], probeSent = 0, probeAnswered = 0, lastProbeAt = 0, probeOutSince = 0, probeSamples = [], measures = { u500: null, rhatKBs: 0 };
        var owner = 'off', path = 'jpeg', lastPath = null, ownerSince = 0, pendingSince = 0;
        var freezeUntil = 0, freezeWhy = null, firstAt = 0, lastNoteAt = 0, startOver = false, hiddenNow = false, hiddenRestore = -1;
        var period = 0, gaps = [], lastRaf = -1, rafId = null, rafLeft = 0, curMode = 'ts';
        var memoryApplied = false, heldSince = 0, heldStep = -1, heldEvals = 0, lastMeasuredFps = 0;
        var history = [], info = { owner: 'off', stepMs: STEP_MS[1], reason: null };
        function fresh() { return { bytes: 0, made: 0, markers: 0, frames: 0, msgs: 0, motion: 0, last: -1 }; }
        acc = fresh();
        function log(m) { if (host.log) { host.log(m); } }
        function note(t, ev, why) { history.push({ t: t, stepMs: STEP_MS[a.step], reason: why || ev }); if (history.length > 30) { history.shift(); } }
        function publish(why) {
            info = { owner: owner, stepMs: STEP_MS[a.step], reason: why || info.reason, path: path };
            if (host.changed) { try { host.changed(info); } catch (ex) { /* the page */ } }
        }
        function send(ms) { try { host.send(ms); } catch (ex) { log('auto: send ' + ex); } }

        // the display: the smallest gap of the last 12 frames of the browser, measured while data arrives (a short chain of requestAnimationFrame, never a loop in the quiet)
        function rafStep(t) {
            rafId = null;
            if (typeof t !== 'number') { t = now(); }
            if (lastRaf >= 0) { var d = t - lastRaf; if (d > 2) { gaps.push(d); if (gaps.length > 12) { gaps.shift(); } period = Math.min.apply(null, gaps); } }
            lastRaf = t;
            if (--rafLeft > 0) { rafId = host.raf(rafStep); } else { lastRaf = -1; }
        }
        function measureDisplay() { if ((rafId === null) && host.raf && (rafLeft <= 0)) { rafLeft = 13; lastRaf = -1; rafId = host.raf(rafStep); } }

        // ---- what arrives: kind 'frame' (243 with a picture), 'marker' (243 end of an iteration), 'data' (a tile, a copy); bytes of the message; ts of the agent (frames and markers), null otherwise ----
        c.note = function (kind, bytes, ts) {
            if (!running) { return; }
            var t = now();
            if (firstAt === 0) { firstAt = t; }
            lastNoteAt = t;
            acc.bytes += bytes; acc.msgs++;
            if (kind === 'frame') { acc.frames++; } else if (kind === 'marker') { acc.markers++; }
            var b = Math.floor(t / RHAT_BUCKET_MS); buckets[b] = (buckets[b] || 0) + bytes;
            // the time of motion: the gaps between the messages of a series (up to SERIES_GAP_MS), and for a series the time of one frame at the step (plus, for a message that took long to come, the time of its
            // transfer: the size over the best rate). The slots of 100 ms of the agent count a series of 20 frames over 660 ms as 800 ms, so that fps came out 20 % low against the 85 % of a step up
            var span = (rhat > 0) ? Math.min(2000, (bytes * 1000) / rhat) : 0;
            if ((acc.last >= 0) && ((t - acc.last) <= SERIES_GAP_MS)) { acc.motion += (t - acc.last); } else { acc.motion += Math.max(STEP_MS[a.step], span); }
            acc.last = t;
            if ((typeof ts === 'number') && (kind !== 'data')) { var d = ((((t >>> 0) - ts) | 0)); lagWin.push(d); var bi = Math.floor(t / 5000); var last = lagBins[lagBins.length - 1]; if (last && (last.bin === bi)) { if (d < last.min) { last.min = d; } } else { lagBins.push({ bin: bi, min: d }); } }
            measureDisplay();
        };
        // an event that moves a lot of data at once (a full picture, a refresh, a new screen size, an IDR, a queue overflow): the windows that hold it are not evaluated, for the time the data needs
        c.freeze = function (estBytes, why) {
            var t = now(), ms = (rhat > 0) ? Math.min(5000, Math.max(1000, (estBytes * 1000) / rhat)) : 2000;
            if ((t + ms) > freezeUntil) { freezeUntil = t + ms; freezeWhy = why || 'transfer'; }
        };
        // a new path (the video came or went, the veto, the agent took over or gave back): what was measured on the other one is not valid
        c.pathChanged = function () { buckets = {}; rhat = 0; lagBins = []; lagWin = []; probeBins = []; probeWin = []; probeSent = 0; probeAnswered = 0; lastProbeAt = 0; probeOutSince = 0; a.downStreak = 0; a.upStreak = 0; memoryApplied = false; heldSince = 0; };
        c.resend = function () { if (running) { send(STEP_MS[a.step]); } };
        c.step = function () { return a.step; };
        c.stepMs = function () { return STEP_MS[a.step]; };
        c.setStep = function (step, why) { if (step >= 0 && step < STEP_MS.length) { a.step = step; a.downStreak = 0; a.upStreak = 0; a.haveUp = false; note(now(), 'set', why || 'set'); publish(why); } };
        c.info = function () { return { on: running, owner: owner, stepMs: STEP_MS[a.step], reason: info.reason, path: path, changes: a.changes, downs: a.downs, ups: a.ups, periodMs: Math.round(period * 10) / 10, rhat: Math.round(rhat), fps: lastMeasuredFps, mode: curMode, measures: measures, probe: { sent: probeSent, answered: probeAnswered, samples: probeSamples.slice(-60) }, history: history.slice() }; };

        function minLag() { var m = null, t = Math.floor(now() / 5000); for (var i = 0; i < lagBins.length; i++) { if ((t - lagBins[i].bin) <= (LAG_MIN_MS / 5000) && ((m === null) || (lagBins[i].min < m))) { m = lagBins[i].min; } } return m; }
        function median(l) { if (l.length === 0) { return null; } l = l.slice().sort(function (x, y) { return x - y; }); return l[l.length >> 1]; }
        function pct(l, p) { if (l.length === 0) { return null; } l = l.slice().sort(function (x, y) { return x - y; }); return l[Math.min(l.length - 1, Math.floor(p * l.length))]; }
        function minProbe() { var m = null, t = Math.floor(now() / 5000); for (var i = 0; i < probeBins.length; i++) { if (((t - probeBins[i].bin) <= (LAG_MIN_MS / 5000)) && ((m === null) || (probeBins[i].min < m))) { m = probeBins[i].min; } } return m; }
        // an answer of the probe: the time that the `rtt` took through the agent (it waits behind the data that were queued on the way); the minimum of the last minute is the way without a queue
        c.probeSample = function (ms) {
            if (!running || !(ms >= 0)) { return; }
            var t = now(), bi = Math.floor(t / 5000), last = probeBins[probeBins.length - 1];
            if (last && (last.bin === bi)) { if (ms < last.min) { last.min = ms; } } else { probeBins.push({ bin: bi, min: ms }); }
            probeWin.push(ms); lastProbeAt = t; probeAnswered++; probeOutSince = 0; probeSamples.push([Math.round(t), ms]); if (probeSamples.length > 120) { probeSamples.shift(); }
        };

        // Who chooses now, and what that change needs (the takeover from the agent, the end of a freeze). Called every window and at every 242 of the agent: the agent can stop announcing Auto (caps bit 2)
        // in the middle of a session with the video on (stage 2 of its rate control), and the viewer then chooses at once
        function ownerStep(t) {
            var prevOwner = owner;
            owner = host.owner();
            path = host.path();
            if ((lastPath !== null) && (path !== lastPath)) { c.pathChanged(); }
            lastPath = path;
            // the owner changed
            if (owner !== prevOwner) {
                ownerSince = t;
                if ((prevOwner === 'agent') && (owner === 'viewer')) {       // the takeover: the slower of the step before and what was delivered while the agent drove; never faster than Medium after reason 9 (host.slowStart)
                    var s = Math.max(a.step, stepForFps(lastMeasuredFps || STEP_FPS[a.step]));
                    if (host.slowStart && host.slowStart()) { s = Math.max(s, 1); }
                    a.step = s; a.downStreak = 0; a.upStreak = 0; a.haveUp = false; freezeUntil = Math.max(freezeUntil, t + 2000); freezeWhy = 'takeover';
                    note(t, 'takeover', 'takeover'); send(STEP_MS[a.step]);
                } else if ((prevOwner === 'frozen') && (owner === 'viewer')) { freezeUntil = Math.max(freezeUntil, t + 2000); send(STEP_MS[a.step]); note(t, 'unfreeze', 'unfreeze'); }
                a.downStreak = 0; a.upStreak = 0;
                publish(owner);
            }
        }
        c.ownerNow = function () { if (running) { ownerStep(now()); } };

        function tick() {
            timer = null;
            if (!running) { return; }
            var t = now();
            ownerStep(t);
            // the window that ends now
            var motionMs = Math.min(WINDOW_MS, Math.round(acc.motion));
            // the best rate: the busiest bucket of the last RHAT_HORIZON_MS (not the one that is still filling)
            var curB = Math.floor(t / RHAT_BUCKET_MS), best = 0;
            for (var bk in buckets) { var bn = Number(bk); if (bn < (curB - (RHAT_HORIZON_MS / RHAT_BUCKET_MS))) { delete buckets[bk]; } else if ((bn < curB) && (buckets[bk] > best)) { best = buckets[bk]; } }
            if (best > 0) { rhat = Math.max(best * (1000 / RHAT_BUCKET_MS), 0); }
            var bytes = acc.bytes, made = (path === 'h264') ? acc.frames : ((path === 'jpeg-ack') ? acc.markers : null);
            // for the measures only (not a rule): the use of the link against the best rate seen
            var u = ((rhat > 0) && (motionMs > 0)) ? (bytes / (rhat * (motionMs / 1000))) : null; if (u != null && u > 1) { u = 1; }
            measures = { u: (u == null) ? null : Math.round(u * 100) / 100, rhatKBs: Math.round(rhat / 1024) };
            var lagMin = minLag(), lag = null, lagUp = null, m = median(lagWin), m90 = pct(lagWin, 0.9);
            if ((m !== null) && (lagMin !== null)) { lag = m - lagMin; lagUp = m90 - lagMin; }
            lagWin = []; lagBins = lagBins.filter(function (x) { return (Math.floor(t / 5000) - x.bin) <= (LAG_MIN_MS / 5000); });
            var fpsNow = (made != null && motionMs > 0) ? (made * 1000) / motionMs : 0;
            if (fpsNow > 0) { lastMeasuredFps = Math.round(fpsNow * 10) / 10; }
            // the first picture of the session
            if (!startOver && (firstAt > 0) && (((t - lastNoteAt) >= START_QUIET_MS) || ((t - firstAt) >= START_MAX_MS))) { startOver = true; }
            var sm = host.sample ? host.sample() : null, behind = false, ovq = false;
            if (sm) {
                if (lastSample) {
                    if ((sm.ovQueue || 0) > (lastSample.ovQueue || 0)) { ovq = true; behind = true; }
                    if ((sm.queueHigh || 0) > (lastSample.queueHigh || 0)) { behind = true; }
                    if ((sm.queueOverflows || 0) > (lastSample.queueOverflows || 0)) { behind = true; freezeUntil = Math.max(freezeUntil, t + 2000); freezeWhy = 'overflow'; }
                }
                var pend = sm.pending || 0;
                if ((pend > 20) && (pend > pendingPrev)) { pendingUp++; } else { pendingUp = 0; }
                pendingPrev = pend;
                if (pendingUp >= 2) { behind = true; }
                lastSample = { ovQueue: sm.ovQueue || 0, queueHigh: sm.queueHigh || 0, queueOverflows: sm.queueOverflows || 0 };
            }
            // the mode of this path: the times of the agent (H.264, JPEG with ACK), the probe `rtt` (JPEG without ACK in a relay 1:1: the agent answers it through the same socket as the data), or none
            var mode = 'ts', probe = null, probeMax = null, maxDown = null;
            if (path === 'jpeg') {
                var mux = !!(host.isMux && host.isMux());
                // the age of the probe that is not answered: a lower bound of L' (the answer waits behind the data that were queued on the way, on a slow link for many seconds)
                var age = (probeOutSince > 0) ? (t - probeOutSince) : 0;
                if (!mux && (owner === 'viewer') && host.probe) { host.probe(); probeSent++; if (probeOutSince === 0) { probeOutSince = t; } }
                mode = mux ? 'none' : 'probe';
                var pmin = minProbe(), lp = probeWin.map(function (x) { return x - (pmin === null ? 0 : pmin); });
                if (age > 0) { lp.push(age); }
                if (!mux && (lp.length > 0)) { probe = median(lp); probeMax = Math.max.apply(null, lp); }
                if (!mux && (probeAnswered === 0) && !(host.proven && host.proven())) { maxDown = 2; }       // a probe that never answered is only half proof (an agent that does not know `rtt` looks like this)
            }
            probeWin = []; probeBins = probeBins.filter(function (x) { return (Math.floor(t / 5000) - x.bin) <= (LAG_MIN_MS / 5000); });
            curMode = mode;
            // the tab: a hidden one gets the slowest step, and the step it had comes back with a pause
            var hid = !!(host.hidden && host.hidden());
            if ((owner === 'viewer') && hid && !hiddenNow) { hiddenNow = true; hiddenRestore = a.step; send(STEP_MS[HIDDEN_STEP]); note(t, 'hidden', 'hidden'); }
            else if (hiddenNow && !hid) { hiddenNow = false; if (owner === 'viewer') { send(STEP_MS[a.step]); } freezeUntil = Math.max(freezeUntil, t + 2000); freezeWhy = 'shown'; note(t, 'shown', 'shown'); }
            var frozen = hid || (owner !== 'viewer') || (t < freezeUntil) || (freezeUntil > winStart) || (!startOver && (firstAt > 0)) || (firstAt === 0);
            // the memory of the device, once the path is known (242 came)
            if ((owner === 'viewer') && !memoryApplied && (mode !== 'none') && host.memGet && host.ready && host.ready() && startOver) {
                memoryApplied = true;
                var mem = host.memGet(path);
                if (mem && (typeof mem.step === 'number') && (mem.step >= 0) && (mem.step < STEP_MS.length) && ((wall() - mem.t) <= MEMORY_MAX_AGE_MS) && (mem.t <= (wall() + 1000))) {
                    var st = Math.max(mem.step, screenLimit(period));
                    if (st !== a.step) { applyMemory(a, st, t); note(t, 'memory', 'start'); send(STEP_MS[a.step]); publish('start'); }
                }
            }
            if ((owner === 'viewer') && (firstAt > 0)) {
                var w = { mode: mode, motionMs: motionMs, made: made, lag: lag, lagUp: lagUp, probe: probe, probeMax: probeMax, maxDown: maxDown, behind: behind, ovq: ovq, frozen: frozen, limit: screenLimit(period) };
                var r = decide(a, w, t);
                if (r.changed) { note(t, 'step', r.reason); if (!hiddenNow) { send(STEP_MS[a.step]); } publish(r.reason); }
                // the step is worth remembering when it held for a while, over several evaluated windows
                if (a.step !== heldStep) { heldStep = a.step; heldSince = t; heldEvals = a.evals; }
                else if (host.memSet && (mode !== 'none') && !hid && !frozen && ((t - heldSince) >= MEMORY_HOLD_MS) && ((a.evals - heldEvals) >= MEMORY_MIN_EVALS)) { host.memSet(path, a.step, wall()); }
            }
            acc = fresh(); winStart = t;
            if (running) { timer = setT(tick, WINDOW_MS); }
        }
        c.start = function () {
            if (running) { return; }
            running = true; a = newState(1); c.state = a; var t = now(); winStart = t; acc = fresh(); firstAt = 0; lastNoteAt = 0; startOver = false; freezeUntil = 0; owner = 'off'; memoryApplied = false;
            lastSample = null; lastPath = null; probeBins = []; probeWin = []; probeSent = 0; probeAnswered = 0; lastProbeAt = 0; probeOutSince = 0; curMode = 'ts'; pendingPrev = 0; pendingUp = 0; hiddenNow = false; heldStep = -1; history = []; buckets = {}; rhat = 0; lagBins = []; lagWin = []; lastMeasuredFps = 0;
            timer = setT(tick, WINDOW_MS);
        };
        c.stop = function () { running = false; if (timer !== null) { clrT(timer); timer = null; } if (rafId !== null && host.cancelRaf) { host.cancelRaf(rafId); } rafId = null; rafLeft = 0; };
        c.running = function () { return running; };
        return c;
    }

    return { create: create, decide: decide, newState: newState, applyMemory: applyMemory, screenLimit: screenLimit, stepForFps: stepForFps,
        STEP_MS: STEP_MS, STEP_FPS: STEP_FPS, PENDING_MS: PENDING_MS, MEMORY_MAX_AGE_MS: MEMORY_MAX_AGE_MS, MEMORY_HOLD_MS: MEMORY_HOLD_MS, FAST_MS: FAST_MS,
        PARAMS: { WINDOW_MS: WINDOW_MS, MIN_MOTION_MS: MIN_MOTION_MS, SLOT_MS: SLOT_MS, DOWN_WINDOWS: DOWN_WINDOWS, UP_WINDOWS: UP_WINDOWS, UP_MAX: UP_MAX, FAIL_MS: FAIL_MS, STABLE_MS: STABLE_MS,
            MIN_CHANGE_MS: MIN_CHANGE_MS, UP_AFTER_MS: UP_AFTER_MS, STALE_MS: STALE_MS, KEEP_PCT: KEEP_PCT, SAT_PCT: SAT_PCT } };
});
