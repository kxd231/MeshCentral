/** 
* @description Remote Desktop
* @author Ylian Saint-Hilaire
* @version v0.0.2g
*/

// Polyfill Uint8Array.slice() for IE
if (!Uint8Array.prototype.slice) { Object.defineProperty(Uint8Array.prototype, 'slice', { value: function (begin, end) { return new Uint8Array(Array.prototype.slice.call(this, begin, end)); } }); }

function isWindowsBrowser() {
    return navigator && !!(/win/i).exec(navigator.platform);
}

// Construct a MeshServer object
var CreateAgentRemoteDesktop = function (canvasid, scrolldiv) {
    var obj = {}
    obj.CanvasId = canvasid;
    if (typeof canvasid === 'string') obj.CanvasId = Q(canvasid);
    obj.Canvas = obj.CanvasId.getContext('2d');
    obj.scrolldiv = scrolldiv;
    obj.State = 0;
    obj.PendingOperations = [];
    obj.tilesReceived = 0;
    obj.TilesDrawn = 0;
    obj.KillDraw = 0;
    obj.ipad = false;
    obj.tabletKeyboardVisible = false;
    obj.LastX = 0;
    obj.LastY = 0;
    obj.touchenabled = 0;
    obj.submenuoffset = 0;
    obj.touchtimer = null;
    obj.TouchArray = {};
    obj.connectmode = 0; // 0 = HTTP, 1 = WebSocket, 2 = WebRTC
    obj.connectioncount = 0;
    obj.rotation = 0;
    obj.protocol = 2; // KVM
    obj.debugmode = 0;
    obj.firstUpKeys = [];
    obj.stopInput = false;
    obj.localKeyMap = true;
    obj.remoteKeyMap = false; // If false, the remote keyboard mapping is not used.
    obj.pressedKeys = [];
    obj._altGrArmed = false;       // Windows AltGr detection
    obj._altGrTimeout = 0;
    obj._altGrDeferredDown = false; // a ControlLeft keydown is held back pending AltGr detection
    obj.isWindowsBrowser = isWindowsBrowser();

    obj.sessionid = 0;
    obj.username;
    obj.oldie = false;
    obj.ImageType = 1; // 1 = JPEG, 2 = PNG, 3 = TIFF, 4 = WebP
    obj.CompressionLevel = 50;
    obj.ScalingLevel = 1024;
    obj.FrameRateTimer = 100;
    obj.BandwidthBudget = null;                 // bandwidth limit for the agent in units of 100 kbit/s (0 = no limit); null = never set, the command then has no budget field
    obj.SwapMouse = false;
    obj.UseExtendedKeyFlag = true;
    obj.FirstDraw = false;
    obj.KeepPictureOnResize = false;            // set by a screen size message, used by the next onResize
    obj.kcanvas = null;

    // Ordered draw queue. Every operation that draws on the canvas for the remote stream (tiles, CopyRect) is queued in arrival order,
    // decoded asynchronously and applied strictly in that order. A screen size change drops everything that is queued.
    obj.UseImageBitmap = true;                  // false forces the old data-URL + Image decoder
    obj.MaxQueuedOps = 8192;                    // queued operations (decoding, ready or waiting behind the head)
    obj.MaxQueuedBytes = 64 * 1024 * 1024;      // compressed tile bytes of the queued operations
    obj.MaxDecodedPixels = 32 * 1024 * 1024;    // decoded pixels held by the queue (behind a head that is still decoding, or deferred by the draw slice)
    obj.DrawBudgetMs = 8;                       // time slice for applying operations in one task, 0 = unlimited
    obj.Epoch = 0;                              // incremented by every drop of the queue
    obj.QueuedBytes = 0;
    obj.DecodedPixels = 0;
    obj.QueueOverflows = 0;
    obj.bitmapFailures = 0;

    // H.264 video (commands 240-243, public/scripts/agent-desktop-h264.js). false: this viewer never asks for video. The visible option (agentencoding=264)
    // sets it with SetH264(true). Selecting video implies the end-to-end ACK (op 1 carries it) and a JPEG/WebP picture type for the tiles around the video.
    obj.H264Enabled = false;
    obj.H264Options = null;                     // overrides for the decoder module (tests: fakes of VideoDecoder and EncodedVideoChunk, probe result)
    var h264 = null;                            // the decoder of the module, created when the first frame needs it

    // Viewer ACK. A multiplexing server that offers it ("kvmAck":1 in its metadata) gets a request; after its confirmation the
    // client tags every tile and screen frame received from the websocket with (epoch, seq) and acknowledges, cumulatively and at most every
    // 20 ms, the last tag whose queue position has been consumed (drawn, failed or dropped). The server uses this to keep a bounded window.
    // All of this is bound to one connection: nothing is sent on a later socket without a fresh offer and confirmation.
    obj.KvmAckSupported = true;
    obj.KvmAckEnabled = true;                   // false: never ask
    obj.KvmAckStats = { requests: 0, acks: 0, offs: 0, ons: 0, desyncs: 0 };
    var ka = { transport: null, socket: null, requested: false, active: false, permanent: false, activation: 0, epoch: 0, seq: 0, done: null,
        sentE: 0, sentS: 0, lastSend: 0, paceTimer: null, retryTimer: null, retryAt: 0, rerequests: 0, visListener: null };

    // Optional statistics for the page (the "FPS / bandwidth" option of the Tools panel). Nothing runs until StatsEnable(true), except the
    // counter DrawSeq that the draw path increments. A frame is a display refresh (requestAnimationFrame) in which at least one tile or CopyRect
    // was drawn: the protocol has no end-of-frame marker. Bandwidth is the data received by the transport (parent.BytesIn).
    obj.DrawSeq = 0;
    var st = { on: false, raf: null, seq: 0, frames: 0, samples: [] };
    function statsNow() { return ((typeof performance == 'object') && performance.now) ? performance.now() : Date.now(); }
    function statsTick() {
        if (!st.on) return;
        if (obj.DrawSeq !== st.seq) { st.seq = obj.DrawSeq; st.frames++; }
        st.raf = requestAnimationFrame(statsTick);
    }
    obj.StatsEnable = function (on) {
        on = !!on;
        if (on === st.on) return;
        st.on = on; st.samples = [];
        if (st.raf != null) { try { cancelAnimationFrame(st.raf); } catch (ex) { } st.raf = null; }
        if (on && (typeof requestAnimationFrame == 'function')) { st.seq = obj.DrawSeq; st.frames = 0; st.raf = requestAnimationFrame(statsTick); }
    }
    // Take a sample and return the rates over the last ~2 seconds, or null while there is only one sample. Call it about once a second.
    obj.StatsSample = function () {
        if (!st.on) return null;
        var now = statsNow(), s = st.samples;
        s.push({ t: now, frames: st.frames, bytes: ((obj.parent != null) && obj.parent.BytesIn) || 0 });
        while ((s.length > 2) && ((now - s[1].t) >= 2000)) { s.shift(); }
        if (s.length < 2) return null;
        var a = s[0], b = s[s.length - 1], dt = (b.t - a.t) / 1000;
        if (dt <= 0) return null;
        return { fps: (b.frames - a.frames) / dt, bytesPerSec: (b.bytes - a.bytes) / dt, seconds: dt, codec: obj.ActiveCodec(), hidden: ((typeof document == 'object') && (document != null) && (document.visibilityState === 'hidden')), auto: obj.AutoBrief() };
    }

    // Remote user mouse and keyboard lock
    obj.onRemoteInputLockChanged = null;
    obj.RemoteInputLock = null;

    // Remote keyboard state
    obj.onKeyboardStateChanged = null;
    obj.KeyboardState = 0; // 1 = NumLock, 2 = ScrollLock, 4 = CapsLock

    obj.ScreenWidth = 960;
    obj.ScreenHeight = 701;
    obj.width = 960;
    obj.height = 960;

    obj.displays = null;
    obj.selectedDisplay = null;

    obj.onScreenSizeChange = null;
    obj.onMessage = null;
    obj.onConnectCountChanged = null;
    obj.onDebugMessage = null;
    obj.onTouchEnabledChanged = null;
    obj.onDisplayinfo = null;
    obj.accumulator = null;

    var xMouseCursorActive = true;
    var xMouseCursorCurrent = 'default';
    obj.mouseCursorActive = function (x) { if (xMouseCursorActive == x) return; xMouseCursorActive = x; obj.CanvasId.style.cursor = ((x == true) ? xMouseCursorCurrent : 'default'); }
    var mouseCursors = ['default', 'progress', 'crosshair', 'pointer', 'help', 'text', 'no-drop', 'move', 'nesw-resize', 'ns-resize', 'nwse-resize', 'w-resize', 'alias', 'wait', 'none', 'not-allowed', 'col-resize', 'row-resize', 'copy', 'zoom-in', 'zoom-out'];

    obj.Start = function () {
        obj.State = 0;
        obj.accumulator = null;
        obj.KvmAckReset(); // before the drop: tags of the old connection must not produce ACKs
        streamReset();     // same for the positions of the end-to-end stream ACK
        obj.DropPendingOperations();
        presentDiscard();
        clearOverflowRefresh();
    }

    obj.Stop = function () {
        obj.StatsEnable(false);
        obj.KvmAckReset();
        streamReset();
        obj.DropPendingOperations();
        autoStop();
        presentClose();     // the end of a session: the observer of the long animation frames goes too (a new connection of the page makes a new viewer object, the old one must not stay observed)
        clearOverflowRefresh();
        obj.setRotation(0);
        obj.UnGrabKeyInput();
        obj.UnGrabMouseInput();
        obj.touchenabled = 0;
        if (obj.onScreenSizeChange != null) { obj.onScreenSizeChange(obj, obj.ScreenWidth, obj.ScreenHeight, obj.CanvasId); }
        obj.Canvas.clearRect(0, 0, obj.CanvasId.width, obj.CanvasId.height);
    }

    obj.xxStateChange = function (newstate) {
        if (obj.State == newstate) return;
        obj.State = newstate;
        obj.CanvasId.style.cursor = 'default';
        //console.log('xxStateChange', newstate);
        switch (newstate) {
            case 0: {
                // Disconnect
                obj.Stop();
                break;
            }
            case 3: {
                // Websocket connected
                autoSync();
                break;
            }
        }
    }

    obj.send = function (x) {
        if (obj.debugmode > 2) { console.log('KSend(' + x.length + '): ' + rstr2hex(x)); }
        if (obj.parent != null) { obj.parent.send(x); }
    }

    // KVM Control.
    // Routines for processing incoming packets from the AJAX server, and handling individual messages.
    obj.ProcessPictureMsg = function (data, X, Y) {
        // data = tile payload without the command header: X (2), Y (2), then the encoded image (JPEG, PNG or WebP).
        var bytes = data.subarray(4);
        var op = { t: 2, st: 0, x: X, y: Y, img: null, bytes: bytes.byteLength, px: 0, dropped: false }; // st: 0 = decoding, 1 = ready, 2 = failed
        obj.tilesReceived++;
        if (!enqueueOperation(op)) return null;
        decodeTile(op, bytes);
        return op; // decoding always completes asynchronously, so the caller can still attach its ACK tag
    }

    // The image type from the first bytes of the tile, or '' when it is not recognised (the browser then sniffs the content).
    obj.TileMimeType = function (b) {
        if ((b.length >= 3) && (b[0] == 0xFF) && (b[1] == 0xD8)) return 'image/jpeg';
        if ((b.length >= 8) && (b[0] == 0x89) && (b[1] == 0x50) && (b[2] == 0x4E) && (b[3] == 0x47)) return 'image/png';
        if ((b.length >= 12) && (b[0] == 0x52) && (b[1] == 0x49) && (b[2] == 0x46) && (b[3] == 0x46) && (b[8] == 0x57) && (b[9] == 0x45) && (b[10] == 0x42) && (b[11] == 0x50)) return 'image/webp';
        return '';
    }

    // Budgets only apply to a live session: without a channel to the agent (the recording player, WebM export) a dropped queue could not be
    // refreshed, and the player feeds data faster than it decodes, so there the queue is unbounded and lossless like the old client.
    function budgetsApply() { return (obj.parent != null); }

    // Queue an operation at the tail. A queue that outgrows its budget is dropped as a whole and a full refresh is requested,
    // which is what a viewer that cannot keep up needs; the operation that did not fit is part of the dropped stream.
    function enqueueOperation(op) {
        var q = obj.PendingOperations;
        if (budgetsApply() && ((q.length >= obj.MaxQueuedOps) || ((obj.QueuedBytes + op.bytes) > obj.MaxQueuedBytes))) { queueOverflow(); return false; }
        q.push(op);
        obj.QueuedBytes += op.bytes;
        return true;
    }

    // A refresh is requested at most once a second; one that falls inside that second is delayed, not skipped, because the second drop may
    // have thrown away the tiles of the first refresh and the agent only resends what changed.
    var lastOverflowRefresh = 0, refreshTimer = null;
    function overflowRefresh() {
        var wait = 1000 - (Date.now() - lastOverflowRefresh);
        if (wait <= 0) { lastOverflowRefresh = Date.now(); obj.SendRefresh(); return; }
        if (refreshTimer == null) { refreshTimer = setTimeout(function () { refreshTimer = null; lastOverflowRefresh = Date.now(); obj.SendRefresh(); }, wait); }
    }
    function clearOverflowRefresh() { if (refreshTimer != null) { clearTimeout(refreshTimer); refreshTimer = null; } }
    function queueOverflow() {
        obj.QueueOverflows++;
        autoFreeze(600000, 'overflow');
        if (obj.debugmode > 0) { console.log('KVM draw queue overflow, dropping ' + obj.PendingOperations.length + ' operations'); }
        obj.DropPendingOperations();
        overflowRefresh();
    }

    function decodeTile(op, bytes) {
        var mime = obj.TileMimeType(bytes);
        if (obj.UseImageBitmap && (typeof createImageBitmap == 'function') && (typeof Blob == 'function')) {
            var p = null;
            try { p = createImageBitmap(new Blob([bytes], { type: mime })); } catch (ex) { p = null; }
            if (p && (typeof p.then == 'function')) {
                p.then(function (bmp) { obj.bitmapFailures = 0; tileDecoded(op, bmp); }, function () {
                    // One tile that createImageBitmap refuses gets a second chance through Image. It counts against the bitmap decoder only when
                    // Image then decodes the same tile (the content is fine, the decoder is not); 8 such tiles in a row switch the decoder off.
                    if (op.dropped) return;
                    decodeTileViaImage(op, bytes, mime, true);
                });
                return;
            }
        }
        decodeTileViaImage(op, bytes, mime);
    }

    // The original decoder: bytes -> binary string -> base64 -> data URL -> Image.
    function decodeTileViaImage(op, bytes, mime, afterBitmapFailure) {
        var tile = new Image(), ptr = 0, strs = [];
        // String.fromCharCode.apply() can't handle very large argument count, so we have to split like this.
        while ((bytes.byteLength - ptr) > 50000) { strs.push(String.fromCharCode.apply(null, bytes.subarray(ptr, ptr + 50000))); ptr += 50000; }
        strs.push(String.fromCharCode.apply(null, (ptr > 0) ? bytes.subarray(ptr) : bytes));
        tile.onload = function () { if (afterBitmapFailure && (++obj.bitmapFailures >= 8)) { obj.UseImageBitmap = false; } tileDecoded(op, tile); }
        tile.onerror = function () { console.log('DecodeTileError'); tileFailed(op); }
        tile.src = 'data:' + (mime || 'image/jpeg') + ';base64,' + btoa(strs.join(''));
    }

    function releaseImage(img) { if (img && (typeof img.close == 'function')) { try { img.close(); } catch (ex) { } } }

    function tileDecoded(op, img) {
        if (op.dropped) { releaseImage(img); return; } // The screen was reset or the session stopped while the tile was decoding.
        op.img = img; op.st = 1; op.px = (img.width * img.height) || 0;
        obj.DecodedPixels += op.px;
        drainOperations();
        if (budgetsApply() && (obj.DecodedPixels > obj.MaxDecodedPixels)) { queueOverflow(); }
    }

    function tileFailed(op) {
        if (op.dropped) return;
        op.st = 2; // Stays in the queue as a no-op so that the operations behind it are not stuck.
        drainOperations();
    }

    var drainTimer = null, draining = false;
    function drainOperations() {
        if (draining) return;
        draining = true;
        var start = ((typeof performance == 'object') && performance.now) ? performance.now() : Date.now();
        try {
            while (obj.DoPendingOperations()) {
                if (obj.DrawBudgetMs > 0) {
                    var now = ((typeof performance == 'object') && performance.now) ? performance.now() : Date.now();
                    if (((now - start) > obj.DrawBudgetMs) && (obj.PendingOperations.length > 0) && (obj.PendingOperations[0].st != 0)) {
                        // Give the browser a turn (input, painting) and continue with the rest.
                        if (drainTimer == null) { drainTimer = setTimeout(function () { drainTimer = null; drainOperations(); }, 0); }
                        break;
                    }
                }
            }
        } finally { draining = false; }
        h264HeadCheck();
    }

    // Apply the operation at the head of the queue if it is complete. Returns true if an operation was consumed.
    obj.DoPendingOperations = function () {
        var q = obj.PendingOperations;
        if ((q.length == 0) || (q[0].st == 0)) return false;
        var op = q.shift();
        if (op.t == 0) { if (op.pos) { streamDone(op.pos); } kvmAckDone(op.ackTag); return true; } // an ACK marker: nothing to draw, not a tile
        if (op.t == 3) { return consumeVideo(op); }
        obj.QueuedBytes -= op.bytes;
        if (op.st == 1) { obj.DecodedPixels -= op.px; }
        obj.TilesDrawn++;
        if (obj.onPreDrawImage != null) { try { obj.onPreDrawImage(); } catch (ex) { console.log(ex); } } // Notify that we are about to draw on the canvas.
        if ((op.st == 1) && (obj.Canvas != null) && (obj.State != 0)) {
            try {
                if ((presenter != null) && (obj.PresentMode === 'off')) { presenter.flush(); }
                if ((presenter != null) && presenter.busy()) { presentBehind(op); } // video pictures wait for their frame: this draw keeps its place behind them
                else if (op.t == 2) { obj.Canvas.drawImage(op.img, obj.rotX(op.x, op.y), obj.rotY(op.x, op.y)); }
                else if (op.t == 1) { drawCopyRect(op); }
                obj.DrawSeq++;
            } catch (ex) { console.log('KVM draw error', ex); }
        }
        releaseImage(op.img); op.img = null;
        if (op.ackTag) { kvmAckDone(op.ackTag); }
        return true;
    }

    // Drop everything that is queued: pending decodes are ignored when they finish and decoded bitmaps are released.
    obj.DropPendingOperations = function () {
        var q = obj.PendingOperations, lastTag = null, lastPos = null;
        for (var i = 0; i < q.length; i++) {
            q[i].dropped = true;
            if (q[i].t == 3) { if (h264 != null) { h264.dropped(q[i]); } } else { releaseImage(q[i].img); q[i].img = null; }
            if (q[i].ackTag) { lastTag = q[i].ackTag; } if (q[i].pos) { lastPos = q[i].pos; }
        }
        q.length = 0;
        if (lastPos != null) { streamDone(lastPos); } // a dropped position counts as consumed (protocol 7.4): the agent's window must not wait for it
        if (lastTag != null) { kvmAckDone(lastTag); } // dropped operations have left the queue too
        obj.QueuedBytes = 0;
        obj.DecodedPixels = 0;
        obj.tilesReceived = obj.TilesDrawn = obj.KillDraw = 0; // the counters describe the queue, which is empty now
        obj.Epoch++;
        if (drainTimer != null) { clearTimeout(drainTimer); drainTimer = null; }
        h264HeadCheck();
    }

    // ---- H.264 video in the draw queue (the decoder is in agent-desktop-h264.js) ----
    function h264Module() { return ((typeof AgentDesktopH264 == 'object') && (AgentDesktopH264 != null)) ? AgentDesktopH264 : null; }
    function h264Host() {
        return {
            player: function () { return (obj.parent == null); },
            now: function () { return svNow(); },
            setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
            clearTimeout: function (h) { clearTimeout(h); },
            hidden: function () { return !kvmAckVisible(); },
            presenter: function () { return presentGet(); },
            tick: function () { return presentNow(); },
            tune: function () { return !presentOff(); },        // the presentation switch also switches off what goes with it in the decoder (the hold time of the overflow, the software retry)
            softwareGet: function () { try { return (typeof sessionStorage == 'object') && (sessionStorage != null) && (sessionStorage.getItem('kvmH264Software') === '1'); } catch (ex) { return false; } },
            softwareSet: function (on) { try { if ((typeof sessionStorage == 'object') && (sessionStorage != null)) { if (on) { sessionStorage.setItem('kvmH264Software', '1'); } else { sessionStorage.removeItem('kvmH264Software'); } } } catch (ex) { } },
            sendOp3: function (flags) { if (svBound()) { sv.stats.op3++; svSend240(3, flags); } },
            sendOp2: function () { if (svBound()) { sv.stats.op2++; svSend240(2, 0); } },
            wake: function () { drainOperations(); },
            changed: function () { videoStatusNotify(); },
            head: function () { var q = obj.PendingOperations; return (q.length > 0) ? q[0] : null; },
            rotX: function (x, y) { return obj.rotX(x, y); },
            rotY: function (x, y) { return obj.rotY(x, y); },
            log: function (m) { if (obj.debugmode > 0) { console.log(m); } }
        };
    }
    function h264Get() {
        if (h264 == null) { var m = h264Module(); if (m == null) { return null; } h264 = m.create(h264Host(), obj.H264Options); }
        return h264;
    }
    function h264HeadCheck() { if (h264 != null) { var q = obj.PendingOperations; h264.headChanged((q.length > 0) ? q[0] : null); } }
    // Frames are decoded when this viewer asked for video and the agent says it is on; the player decodes whatever the recording holds (7.5)
    function h264Want() {
        if (h264Module() == null) { return false; }
        if (obj.parent == null) { return true; }
        return (obj.H264Enabled === true) && ((h264 == null) || !h264.disabled) && (sv.state != null) && (sv.state.video === 1) && (sv.state.ack === 1);
    }
    function h264Repair(flags) { if ((h264 != null) && h264Want()) { h264.repair(flags); } }

    // Presentation of the decoded pictures (createPresenter in agent-desktop-h264.js): one video picture per frame of the browser, the surplus waits for the next frame, the target of the
    // queue follows the last 0.5 s. Only for a live viewer (the recording player draws as fast as it decodes). Off with ?kvmpresent=0 in the address of the page, with localStorage kvmPresent = '0', or with
    // obj.PresentMode = 'off': then the viewer is what it was without the presenter (the decoder too: no hold time of the overflow, no software retry). 'fixed' (?kvmpresent=fixed, localStorage 'fixed') is
    // the presenter with a fixed target (one picture may stay behind, no history), for the comparison.
    obj.PresentMode = 'queue';                  // 'queue' (default), 'fixed' or 'off' (draw when the picture is consumed, as before)
    var presenter = null, presentDecided = false;
    var presentUser = null, presentLooseUser = null;     // what the address of the page and localStorage say, read once ('' nothing, '0' off, 'fixed'); the loose target of the presenter (0-3, -1 nothing)
    function presentSwitch() {
        if (obj.PresentMode === 'off') { return '0'; }
        if (obj.PresentMode === 'fixed') { return 'fixed'; }
        if (presentUser == null) {
            presentUser = '';
            try { if ((typeof urlargs == 'object') && (urlargs != null) && (urlargs.kvmpresent != null)) { var u = String(urlargs.kvmpresent); if ((u === '0') || (u === 'fixed')) { presentUser = u; } } } catch (ex) { }
            try { if ((presentUser === '') && (typeof localStorage == 'object') && (localStorage != null)) { var l = localStorage.getItem('kvmPresent'); if ((l === '0') || (l === 'fixed')) { presentUser = l; } } } catch (ex) { }
        }
        return presentUser;
    }
    // ?kvmpresentloose=N / localStorage kvmPresentLoose = 'N' (0 to 3): how many pictures stay behind a frame of the browser when the queue has been short; for the comparison of the targets, nothing changes without it
    function presentLoose() {
        if (presentLooseUser == null) {
            presentLooseUser = -1;
            var pick = function (v) { v = String(v); if (/^[0-3]$/.test(v)) { presentLooseUser = parseInt(v, 10); return true; } return false; };
            try { if ((typeof urlargs == 'object') && (urlargs != null) && (urlargs.kvmpresentloose != null) && pick(urlargs.kvmpresentloose)) { return presentLooseUser; } } catch (ex) { }
            try { if ((typeof localStorage == 'object') && (localStorage != null)) { var l = localStorage.getItem('kvmPresentLoose'); if (l != null) { pick(l); } } } catch (ex) { }
        }
        return presentLooseUser;
    }
    function presentOff() { return presentSwitch() === '0'; }
    function presentNow() { return ((typeof performance == 'object') && (performance != null) && performance.now) ? performance.now() : Date.now(); }
    // Long animation frames of the page, where the browser reports them (Chrome 123+); otherwise nothing is observed. → a function that stops the observer, or null
    function presentLoaf(cb) {
        try {
            if ((typeof PerformanceObserver != 'function') || !PerformanceObserver.supportedEntryTypes || (PerformanceObserver.supportedEntryTypes.indexOf('long-animation-frame') < 0)) { return null; }
            var po = new PerformanceObserver(function (list) { var l = list.getEntries(); for (var i = 0; i < l.length; i++) { cb(l[i]); } });
            po.observe({ type: 'long-animation-frame', buffered: false });
            return function () { po.disconnect(); };
        } catch (ex) { return null; }
    }
    function presentGet() {
        if (obj.parent == null) { return null; }
        if (presentOff()) { if (presenter != null) { presenter.flush(); } return null; }   // also in the middle of a session: what waits is drawn, later pictures are drawn at once
        if ((presenter == null) && !presentDecided) {
            presentDecided = true;
            var m = h264Module();
            if ((m == null) || (typeof m.createPresenter != 'function') || (typeof requestAnimationFrame != 'function') || presentOff()) { return null; }
            presenter = m.createPresenter({
                raf: function (fn) { return requestAnimationFrame(fn); },
                cancelRaf: function (id) { if (typeof cancelAnimationFrame == 'function') { cancelAnimationFrame(id); } },
                setTimeout: function (fn, ms) { return setTimeout(fn, ms); }, clearTimeout: function (h) { clearTimeout(h); },
                hidden: function () { return !kvmAckVisible(); },
                now: function () { return presentNow(); },
                loaf: function (cb) { return presentLoaf(cb); },
                log: function (msg) { if (obj.debugmode > 0) { console.log(msg); } }
            }, (presentLoose() >= 0) ? { loose: presentLoose() } : {});
        }
        if (presenter != null) { presenter.setFixed(presentSwitch() === 'fixed'); }     // the mode may be changed while the viewer runs (the A/B of the measurement)
        return presenter;
    }
    // Pictures waiting for their frame must be on the canvas before anything else touches it (resize, rotation, a snapshot), and must not outlive the screen they belong to
    function presentFlush() { if (presenter != null) { presenter.flush(); } }
    function presentDiscard() { if (presenter != null) { presenter.discard(); } }
    function presentClose() { if (presenter != null) { presenter.discard(); presenter.close(); } }
    // A tile or a CopyRect consumed while video pictures wait: it is drawn after them, at their frame (the bitmap of a tile is closed after the draw, and by op.img = null the queue does not close it earlier)
    function presentBehind(op) {
        var img = op.img, t = op.t, c = obj.Canvas, x = (t == 2) ? obj.rotX(op.x, op.y) : 0, y = (t == 2) ? obj.rotY(op.x, op.y) : 0, cost = (t == 2) ? (op.px || 0) : ((op.w * op.h) || 0);
        op.img = null;
        presenter.submit(function () { try { if (t == 2) { c.drawImage(img, x, y); } else if (t == 1) { drawCopyRect(op); } } finally { releaseImage(img); } },
            function () { releaseImage(img); }, false, cost);
    }
    // What the page and the tests can read: counters of the presenter, null when it was never needed
    // meter: what the display gets : arrival → frame, paint(), long animation frames of the page (null where the browser has no such API)
    obj.PresentState = function () { return (presenter == null) ? null : { pending: presenter.pending(), mode: (presentSwitch() === '0') ? 'off' : (presentSwitch() || 'queue'), stats: JSON.parse(JSON.stringify(presenter.stats)), meter: presenter.meter() }; }

    // ---- Auto in the browser (public/scripts/agent-desktop-auto.js) ----
    // The frame rate "Auto": the interval of command 5 is chosen by the module of Auto from what this viewer receives, when the agent does not choose it itself (an agent without Auto, JPEG, a second
    // viewer). One owner at a time: the viewer, or the agent (Auto of the agent: 242 with caps bit 2 and video on, after our op 1 with bit 3; it overrides command 5, the interval then only is the spare),
    // or nobody (a second viewer of a relay 1:1: frozen). This object is the only owner of FrameRateTimer while Auto is chosen; the pages call SetFrameRate / SendCompressionLevel and never put 'auto' there.
    obj.AutoMode = false;               // the user chose Auto
    obj.AutoBlocked = null;             // a reason (the page knows it, e.g. 'viewonly' in a relay 1:1) why Auto cannot work here: then it is shown as unavailable and the step is Medium
    obj.AutoDeviceKey = 'x';            // the key of the device for the memory of the step (the page gives the node id)
    obj.AutoAck = 'auto';               // 'auto': the ACK of JPEG (op 4) is asked for while Auto is chosen and stays to the end of the connection; 'off': never; 'on': always (?kvmautoack=0|1, localStorage kvmAutoAck, read once)
    obj.onAutoChange = null;            // function (viewer, info) when the owner or the step changes
    // The clock of Auto is monotonic (N3): a step of the wall clock (NTP, a resumed VM) must not look like a delay of 150 ms. The probe `rtt` carries the wall time (the transport reads it back); the time of sending is kept here
    function autoMono() { return ((typeof performance == 'object') && (performance != null) && performance.now) ? performance.now() : Date.now(); }
    var autoProbeSent = {}, autoProbeKeys = [];
    // the answer of the transport (wall clock) in the time of the monotonic clock; null for an answer of a probe that is not ours (the transport sends its own every 10 s)
    function autoProbeMs(ms) {
        var k = Date.now() - ms;
        for (var d = 0; d <= 3; d++) { for (var sg = -1; sg <= 1; sg += 2) { var key = k + (d * sg); if (autoProbeSent[key] !== undefined) { var r = autoMono() - autoProbeSent[key]; delete autoProbeSent[key]; return r; } } }
        return null;
    }
    var autoCtl = null, autoRun = false, autoR9At = -1e12, autoLastOwner = 'off', autoPendingSince = 0, autoUsers = null, autoLastMd = null, autoAckRead = null;
    function autoModule() { return ((typeof AgentDesktopAuto == 'object') && (AgentDesktopAuto != null)) ? AgentDesktopAuto : null; }
    function autoOff() {                // ?kvmauto=0 or localStorage kvmAuto = '0': the choice is Medium
        try { if ((typeof urlargs == 'object') && (urlargs != null) && (String(urlargs.kvmauto) === '0')) { return true; } } catch (ex) { }
        try { if ((typeof localStorage == 'object') && (localStorage != null) && (localStorage.getItem('kvmAuto') === '0')) { return true; } } catch (ex) { }
        return false;
    }
    function autoAvailable() { return (autoModule() != null) && (obj.parent != null) && (obj.AutoBlocked == null) && !autoOff(); }
    function autoWantsBit() { return (obj.AutoMode === true) && autoAvailable(); }
    function autoAckMode() {
        if (autoAckRead == null) {
            autoAckRead = obj.AutoAck;
            try { if ((typeof urlargs == 'object') && (urlargs != null) && (urlargs.kvmautoack != null)) { var u = String(urlargs.kvmautoack); if (u === '0') { autoAckRead = 'off'; } else if (u === '1') { autoAckRead = 'on'; } } else if ((typeof localStorage == 'object') && (localStorage != null)) { var l = localStorage.getItem('kvmAutoAck'); if (l === '0') { autoAckRead = 'off'; } else if (l === '1') { autoAckRead = 'on'; } } } catch (ex) { }
        }
        return autoAckRead;
    }
    function autoAckWanted() { var m = autoAckMode(); return (m === 'on') || ((m !== 'off') && autoWantsBit()); }
    function autoUsersOf(md) { var n = 0; if ((md != null) && (md.users != null) && (typeof md.users == 'object')) { for (var k in md.users) { n += (parseInt(md.users[k]) || 1); } } return n; }
    // A multiplexing server says so in its metadata (kvmAck, startTime); the agent of a relay 1:1 never does
    function autoIsMux(md) { return (md != null) && ((md.kvmAck != null) || (md.startTime != null)); }
    // Who chooses the interval now (design 4)
    function autoOwner() {
        var o;
        if (!obj.AutoMode) { o = 'off'; }
        else if (!autoAvailable()) { o = 'unavailable'; }
        else {
            autoMetaCheck();
            var md = obj.parent.metadata, users = autoUsersOf(md), vs = obj.VideoStatus();
            if (!autoIsMux(md) && (users > 1)) { o = 'frozen'; }
            else if ((vs.state === 'on') && (sv.state != null) && ((sv.state.caps & 4) !== 0) && sv.op1Auto) { o = 'agent'; }
            else if ((vs.state === 'pending') && (sv.state != null) && ((autoLastOwner === 'agent') || (autoLastOwner === 'viewer'))) {     // "not yet" (reason 0, 10, 11): the owner does not change, for 5 s
                if (autoPendingSince === 0) { autoPendingSince = svNow(); }
                o = ((svNow() - autoPendingSince) < autoModule().PENDING_MS) ? autoLastOwner : 'viewer';
            } else { o = 'viewer'; }
            if (vs.state !== 'pending') { autoPendingSince = 0; }
        }
        autoLastOwner = o;
        return o;
    }
    function autoPath() { if (obj.VideoStatus().state === 'on') { return 'h264'; } return ((sv.state != null) && (sv.state.ack === 1)) ? 'jpeg-ack' : 'jpeg'; }
    function autoMemKey(path) { return 'kvmAutoStep:' + obj.AutoDeviceKey + ':' + path; }
    function autoHost() {
        return {
            now: autoMono,
            setTimeout: function (fn, ms) { return setTimeout(fn, ms); }, clearTimeout: function (h) { clearTimeout(h); },
            raf: function (fn) { return (typeof requestAnimationFrame == 'function') ? requestAnimationFrame(fn) : null; },
            cancelRaf: function (id) { if (typeof cancelAnimationFrame == 'function') { cancelAnimationFrame(id); } },
            hidden: function () { return !kvmAckVisible(); },
            send: function (ms) { obj.FrameRateTimer = ms; if (obj.State == 3) { sendCompression(); } },
            owner: autoOwner, path: autoPath, wall: function () { return Date.now(); },
            probe: function () { var p = obj.parent; if ((p != null) && (typeof p.sendCtrlMsg == 'function')) { var w = Date.now(); autoProbeSent[w] = autoMono(); autoProbeKeys.push(w); if (autoProbeKeys.length > 30) { delete autoProbeSent[autoProbeKeys.shift()]; } p.sendCtrlMsg(JSON.stringify({ ctrlChannel: 102938, type: 'rtt', time: w })); } },
            proven: function () { return (obj.parent != null) && (obj.parent.latency != null) && (obj.parent.latency.current >= 0); },
            isMux: function () { return (obj.parent != null) && (autoIsMux(obj.parent.metadata) || (obj.parent.webRtcActive === true)); },       // no probe path: a multiplexor drops `rtt`, and with WebRTC the data go by the data channel, an answer through the socket does not wait behind them (N1)
            ready: function () { return (sv.state != null) && ((sv.state.ack === 1) || (sv.state.video === 1)); },
            slowStart: function () { return (svNow() - autoR9At) < 120000; },
            sample: function () { var vs = (h264 != null) ? h264.stats : null; return { pending: obj.PendingOperations.length, ovQueue: vs ? vs.ovQueue : 0, queueHigh: vs ? vs.queueHigh : 0, queueOverflows: obj.QueueOverflows }; },
            memGet: function (path) { try { var v = JSON.parse(localStorage.getItem(autoMemKey(path))); return ((v != null) && (typeof v.step == 'number') && (typeof v.t == 'number')) ? v : null; } catch (ex) { return null; } },
            memSet: function (path, step, t) { try { localStorage.setItem(autoMemKey(path), JSON.stringify({ step: step, t: t })); } catch (ex) { } },
            changed: function (info) { autoNotify(info); },
            log: function (m) { if (obj.debugmode > 0) { console.log(m); } }
        };
    }
    function autoNotify(info) { if (obj.onAutoChange != null) { try { obj.onAutoChange(obj, info); } catch (ex) { console.log(ex); } } }
    function autoSetMode(on) {
        on = (on === true);
        if (obj.AutoMode === on) { return; }
        obj.AutoMode = on;
        if (on) { obj.FrameRateTimer = 33; }                 // Auto starts with Medium (the step of the memory comes after the 242)
        autoSync();
        autoNotify({ owner: autoOwner(), stepMs: obj.FrameRateTimer });
    }
    // Starts or stops the module and asks the agent again (op 1 bit 3, op 4) when what the request says has changed
    function autoSync() {
        if ((obj.State == 3) && (obj.parent != null)) {
            if (autoWantsBit()) {
                if (autoCtl == null) { autoCtl = autoModule().create(autoHost()); }
                if (!autoCtl.running()) { autoCtl.start(); autoRun = true; }
                autoLatency(true);
            } else { autoStopCtl(); }
        } else { autoStopCtl(); }
        if (svBound() && (sv.screenW !== 0) && (obj.parent.protocol == 2)) {
            if (((sv.want === 1) && (sv.op1Auto !== autoWantsBit())) || ((sv.want === 0) && streamAckWanted())) { streamRequest(); }
        }
    }
    function autoStopCtl() { autoRun = false; if ((autoCtl != null) && autoCtl.running()) { autoCtl.stop(); } autoLatency(false); }
    // The answers of the probe `rtt` (a relay 1:1 sends them back through the agent): the transport calls latency.callback, which the page uses for its own readout; the module is put in front of it and gives it back
    var autoLatencyWrap = null, autoLatencyPrev = null;
    function autoLatency(on) {
        var l = (obj.parent != null) ? obj.parent.latency : null;
        if (l == null) { return; }
        if (on && (autoLatencyWrap == null)) {
            autoLatencyPrev = l.callback;
            autoLatencyWrap = function (ms) { if ((autoCtl != null) && autoCtl.running()) { var pm = autoProbeMs(ms); if (pm !== null) { autoCtl.probeSample(pm); } } if (autoLatencyPrev != null) { return autoLatencyPrev.apply(this, arguments); } };
            l.callback = autoLatencyWrap;
        } else if (!on && (autoLatencyWrap != null)) { if (l.callback === autoLatencyWrap) { l.callback = autoLatencyPrev; } autoLatencyWrap = null; autoLatencyPrev = null; }
    }
    function autoStop() {
        autoStopCtl();
        autoUsers = null; autoLastMd = null; autoLastOwner = 'off'; autoPendingSince = 0;
    }
    // The number of viewers changed (metadata of the multiplexor, or of the agent in a relay 1:1): the interval that the agent follows may no longer be the one of this viewer. In a multiplexor every
    // change sends the step again; in a relay 1:1 the module does it when it is let go (2 to 1); a viewer in a fixed mode sends its interval again when a viewer left (the multiplexor keeps the
    // shortest one: the one of the viewer that left would stay).
    function autoMetaCheck() {
        if ((obj.parent == null) || (obj.State != 3)) { return; }
        var md = obj.parent.metadata;
        if (md === autoLastMd) { return; }
        autoLastMd = md;
        var n = autoUsersOf(md), was = autoUsers;
        autoUsers = n;
        if ((was == null) || (n === was)) { return; }
        if (obj.AutoMode && (autoCtl != null) && autoCtl.running()) { if (autoIsMux(md)) { autoCtl.resend(); } }
        else if ((n < was) && !obj.AutoMode) { sendCompression(); }
    }
    function autoNote(cmd, size, view) {
        if (cmd === 243) {
            var ts = (view[8] * 0x1000000) + (view[9] << 16) + (view[10] << 8) + view[11], flags = view[12];
            if ((flags & 2) !== 0) { autoCtl.note('marker', size, ts); }
            else { if ((flags & 1) !== 0) { autoCtl.freeze(size, 'idr'); } autoCtl.note('frame', size, ts); }
        } else if ((cmd === 3) || (cmd === 4)) { autoCtl.note('data', size, null); }
    }
    function autoFreeze(bytes, why) { if (autoRun && (autoCtl != null)) { autoCtl.freeze(bytes, why); } }
    // What the page and the tests can read
    obj.AutoState = function () {
        var i = (autoCtl != null) ? autoCtl.info() : null;
        return { on: obj.AutoMode, owner: obj.AutoMode ? autoLastOwner : 'off', blocked: obj.AutoBlocked, available: autoAvailable(), stepMs: obj.FrameRateTimer, reason: i ? i.reason : null, path: i ? i.path : null,
            mode: i ? i.mode : null, measures: i ? i.measures : null, probe: i ? i.probe : null, changes: i ? i.changes : 0, downs: i ? i.downs : 0, ups: i ? i.ups : 0, periodMs: i ? i.periodMs : 0, fps: i ? i.fps : 0, history: i ? i.history : [], ack: autoAckMode(), users: autoUsers };
    }
    // The readout of the page: who chooses, and the step (null when Auto is not chosen)
    obj.AutoBrief = function () {
        if (!obj.AutoMode) { return null; }
        var st = obj.AutoState();
        return { owner: st.owner, stepMs: st.stepMs, fpsTarget: Math.round(1000 / st.stepMs), available: st.available, mode: st.mode };
    }

    // The video operation (t3) is consumed in queue order: painted inside the rectangles of its frame when it holds a picture, then released
    function consumeVideo(op) {
        obj.QueuedBytes -= op.bytes;
        obj.TilesDrawn++;
        if (obj.onPreDrawImage != null) { try { obj.onPreDrawImage(); } catch (ex) { console.log(ex); } }
        try {
            if (h264.consume(op, ((op.st == 1) && (obj.Canvas != null) && (obj.State != 0)) ? obj.Canvas : null)) { obj.DrawSeq++; }
        } catch (ex) { console.log('KVM draw error', ex); }
        if (op.pos) { streamDone(op.pos); }
        kvmAckDone(op.ackTag);
        return true;
    }

    // Stops the decoder of this viewer for good (the recording player calls it before it replaces the object on restart)
    obj.VideoClose = function () { presentClose(); if (h264 != null) { h264.close(); } }
    // State of the video path for the page and for tests
    obj.VideoState = function () { return (h264 == null) ? null : { info: h264.info(), stats: h264.stats }; }
    // The recording player feeds blocks into ProcessBinaryCommand as fast as the timeline allows; it waits while this is true (protocol 7.5, back pressure)
    obj.VideoBusy = function () { return (h264 != null) && h264.busy(); }
    // The player also waits while decoders were created too often (a recording of a hostile agent): milliseconds until the next creation is allowed, 0 live and when none is due
    obj.VideoRestartWait = function () { return (h264 == null) ? 0 : h264.restartWait(); }
    // What the page tells the user about the video of this session. state: 'off' (the option is not selected), 'pending' (asked, no answer yet), 'on', 'fallback' (JPEG instead of
    // the video the user asked for). why, for a fallback: 'browser' (this browser cannot decode it), 'agent' (the agent does not know video), 'errors' / 'unsupported' (the decoder
    // gave up), 'veto' (another viewer has the device), 'r1' ... 'r9' (reason of the last 242 of the agent, protocol 3.3).
    obj.onVideoStatusChange = null;     // function (viewer, status), called when state or why change
    obj.VideoStatus = function () {
        if ((obj.parent == null) || (obj.H264Enabled !== true)) { return { state: 'off', why: null }; }
        if (h264Module() == null) { return { state: 'fallback', why: 'browser' }; }
        if ((h264 != null) && h264.disabled) { return { state: 'fallback', why: h264.why || 'errors' }; }
        var s = sv.state, cap = h264Caps[sv.screenW + 'x' + sv.screenH];
        if ((s != null) && (s.video === 1) && (s.ack === 1)) { return { state: 'on', why: null }; }
        if ((cap !== undefined) && !cap.ok) { return { state: 'fallback', why: 'browser' }; }
        if (s == null) { return sv.timedOut ? { state: 'fallback', why: 'agent' } : { state: 'pending', why: null }; }
        // The agent answered (0, 1, 0) to the request for the ACK alone that follows a refusal of the video (reason 6, a server switch): the reason stays
        if ((sv.want === 4) && (s.video === 0) && (s.reason === 0)) { return { state: 'fallback', why: 'r6' }; }
        if ((s.reason === 0) || (s.reason === 10) || (s.reason === 11)) { return { state: 'pending', why: null }; }
        return { state: 'fallback', why: (s.reason === 5) ? 'veto' : ('r' + s.reason) };
    }
    var vsLast = 'off/';
    function videoStatusNotify() {
        var v = obj.VideoStatus(), k = v.state + '/' + (v.why || '');
        if (k === vsLast) { return; }
        vsLast = k;
        if (obj.onVideoStatusChange != null) { try { obj.onVideoStatusChange(obj, v); } catch (ex) { console.log(ex); } }
    }
    // The picture format in use, for the readout: H.264 only while the agent really sends video to this viewer
    obj.ActiveCodec = function () { return (obj.VideoStatus().state === 'on') ? 'H.264' : (({ 1: 'JPEG', 2: 'PNG', 3: 'TIFF', 4: 'WebP' })[obj.ImageType] || 'JPEG'); }
    // The option "H.264 (video)": on asks for video (op 1) when the first screen size is known, off asks the agent to stop it (op 2) and keeps the ACK
    obj.SetH264 = function (on) {
        on = (on === true);
        if (obj.H264Enabled === on) { return; }
        obj.H264Enabled = on;
        videoStatusNotify();
        if (!svBound() || (sv.screenW === 0) || (obj.parent.protocol != 2)) { return; }
        if (on) { sv.requested = true; streamRequest(); }
        else if ((sv.state != null) && (sv.state.video === 1)) { sv.stats.op2++; sv.want = 4; svSend240(2, 0); }
    }

    // ---- Viewer ACK ----

    function kvmAckNext(x) { return (x >= 0xFFFFFFFF) ? 1 : (x + 1); }
    function kvmAckBound() { return (ka.socket != null) && (obj.parent != null) && (obj.parent === ka.transport) && (obj.parent.socket === ka.socket) && (ka.socket.readyState === 1); }
    function kvmAckClearTimers() {
        if (ka.paceTimer != null) { clearTimeout(ka.paceTimer); ka.paceTimer = null; }
        if (ka.retryTimer != null) { clearTimeout(ka.retryTimer); ka.retryTimer = null; }
        if ((ka.visListener != null) && (typeof document == 'object') && document.removeEventListener) { document.removeEventListener('visibilitychange', ka.visListener); }
        ka.visListener = null;
    }
    function kvmAckVisible() { return (typeof document != 'object') || (document == null) || (document.visibilityState !== 'hidden'); }
    function kvmAckSendRequest() {
        if (!kvmAckBound()) { obj.KvmAckReset(); return; }
        ka.requested = true;
        obj.KvmAckStats.requests++;
        ka.transport.sendCtrlMsg('{"ctrlChannel":"102938","type":"kvmack","op":"req","v":1}');
    }

    // Everything about ACK belongs to one connection; the transport and the module call this on every start and stop.
    obj.KvmAckReset = function () {
        kvmAckClearTimers();
        ka.activation++; // tags still attached to queued operations become stale
        ka.transport = null; ka.socket = null; ka.requested = false; ka.active = false; ka.permanent = false;
        ka.done = null; ka.sentE = 0; ka.sentS = 0; ka.lastSend = 0; ka.rerequests = 0; ka.retryAt = 0;
    }

    // The transport saw "kvmAck":1 in the server's metadata, on socket `socket`. This binds ACK to that connection and sends the request.
    obj.KvmAckOffered = function (transport, socket) {
        if ((obj.KvmAckEnabled === false) || ((typeof urlargs == 'object') && (urlargs != null) && (urlargs.kvmack == '0'))) return;
        if ((ka.socket != null) || ka.requested || ka.active || ka.permanent) return; // already bound to this connection
        if ((transport == null) || (transport !== obj.parent) || (transport.protocol != 2) || (transport.State != 3) || transport.webRtcActive) return;
        if ((socket == null) || (socket !== transport.socket) || (socket.readyState !== 1)) return;
        ka.transport = transport; ka.socket = socket;
        kvmAckSendRequest();
    }

    // A "kvmack" control message from the server, received on `socket`
    obj.KvmAckControl = function (msg, socket) {
        if ((msg == null) || (msg.v !== 1) || (socket == null) || (socket !== ka.socket) || !kvmAckBound()) return;
        if (msg.op === 'on') {
            var e = msg.epoch, q = msg.seq;
            if (!ka.requested || ka.active) return;
            if ((typeof e != 'number') || !Number.isInteger(e) || (e < 1) || (e > 0xFFFFFFFF)) return;
            if ((typeof q != 'number') || !Number.isInteger(q) || (q < 0) || (q > 0xFFFFFFFF)) return;
            ka.requested = false; ka.active = true; ka.activation++;
            ka.epoch = e; ka.seq = q; ka.done = null; ka.sentE = 0; ka.sentS = 0;
            obj.KvmAckStats.ons++;
        } else if (msg.op === 'off') {
            ka.active = false; ka.requested = false;
            if (ka.paceTimer != null) { clearTimeout(ka.paceTimer); ka.paceTimer = null; }
            obj.KvmAckStats.offs++;
            if ((msg.reason === 'timeout') && !ka.permanent && (ka.rerequests < 3)) {
                // Ask again after the server's cooldown (30 s from its "off"), when the page is visible and the connection is the same
                if (ka.retryTimer != null) { clearTimeout(ka.retryTimer); }
                ka.retryAt = Date.now() + 31000;
                ka.retryTimer = setTimeout(kvmAckRetry, 31000);
            } else {
                ka.permanent = true;
                kvmAckClearTimers();
            }
        }
    }

    function kvmAckRetry() {
        ka.retryTimer = null;
        if (!kvmAckBound() || ka.permanent || ka.active || ka.requested || (ka.rerequests >= 3)) return;
        if (kvmAckVisible()) { ka.rerequests++; kvmAckSendRequest(); return; }
        if ((ka.visListener == null) && (typeof document == 'object') && document.addEventListener) {
            ka.visListener = function () {
                if (!kvmAckVisible() || (Date.now() < ka.retryAt)) return;
                document.removeEventListener('visibilitychange', ka.visListener);
                ka.visListener = null;
                kvmAckRetry();
            };
            document.addEventListener('visibilitychange', ka.visListener);
        }
    }

    // The transport's accumulator started while ACK was on: the count may no longer match the server's, so stop acknowledging for good
    obj.KvmAckLocalDesync = function () {
        if (!ka.active) return;
        ka.active = false; ka.permanent = true;
        obj.KvmAckStats.desyncs++;
        kvmAckClearTimers();
        if (kvmAckBound()) { ka.transport.sendCtrlMsg('{"ctrlChannel":"102938","type":"kvmack","op":"off","v":1,"reason":"desync"}'); }
    }

    // Tag of the next counted frame, or null. The multiplexor counts every entry of its image list: tiles (3), screen sizes (7), video frames and markers (243)
    // and the video state (242) that it queues for one viewer. A 242 that the multiplexor makes up itself (caps bit 7) is not in the list and is not counted.
    function kvmAckTag(cmd, fromWire, view) {
        if ((fromWire !== true) || !ka.active || ((cmd != 3) && (cmd != 7) && (cmd != 243) && (cmd != 242))) return null;
        if ((cmd == 242) && (view != null) && (view.length > 14) && ((view[14] & 0x80) != 0)) return null;
        if (cmd == 7) { ka.epoch = kvmAckNext(ka.epoch); ka.seq = 0; } // a screen frame opens a new epoch
        ka.seq = kvmAckNext(ka.seq);
        return { a: ka.activation, e: ka.epoch, s: ka.seq };
    }

    // A counted frame that produced no queue operation (screen size, refused tile) still has a queue position: a marker.
    // A marker at the tail is replaced, not added (nothing lies between them), and markers count against the operation budget.
    function kvmAckMarker(tag) {
        var q = obj.PendingOperations, tail = (q.length > 0) ? q[q.length - 1] : null;
        if ((tail != null) && (tail.t === 0) && !tail.dropped) { tail.ackTag = tag; return; }
        if (q.length >= obj.MaxQueuedOps) { queueOverflow(); }
        q.push({ t: 0, st: 1, bytes: 0, px: 0, img: null, ackTag: tag, pos: null, dropped: false });
        drainOperations();
    }

    function kvmAckDone(tag) {
        if ((tag == null) || !ka.active || (tag.a !== ka.activation)) return;
        ka.done = tag;
        kvmAckMaybeSend();
    }

    function kvmAckMaybeSend() {
        if (!ka.active || (ka.done == null) || ((ka.done.e === ka.sentE) && (ka.done.s === ka.sentS))) return;
        var wait = (ka.lastSend + 20) - Date.now();
        if (wait > 0) { if (ka.paceTimer == null) { ka.paceTimer = setTimeout(function () { ka.paceTimer = null; kvmAckMaybeSend(); }, wait); } return; }
        if (!kvmAckBound()) { obj.KvmAckReset(); return; }
        var e = ka.done.e, s = ka.done.s, b = new Uint8Array(12);
        b[0] = 0x4B; b[1] = 0x41; b[2] = 0; b[3] = 12;
        b[4] = (e >>> 24) & 255; b[5] = (e >>> 16) & 255; b[6] = (e >>> 8) & 255; b[7] = e & 255;
        b[8] = (s >>> 24) & 255; b[9] = (s >>> 16) & 255; b[10] = (s >>> 8) & 255; b[11] = s & 255;
        ka.sentE = e; ka.sentS = s; ka.lastSend = Date.now();
        obj.KvmAckStats.acks++;
        ka.transport.send(b);
    }

    // ---- End-to-end stream ACK and video state (commands 240-243) ----
    // The agent announces what it can do with command 242 (VIDEO_STATE). After the first screen size this viewer asks for the end-to-end ACK (240 op 4,
    // JPEG picture as before). Every position of the agent's stream (a video frame or a marker, command 243) is queued behind the tiles that came before it;
    // when the queue has consumed it, a 241 (STREAM_ACK) goes back, at most every 20 ms, always for the newest consumed position. This module has no H.264
    // decoder unless this viewer asked for video (H264Enabled) and the module agent-desktop-h264.js is loaded: then a 243 frame is a video operation (t3) of
    // the draw queue, decoded on arrival and painted in order, otherwise it is consumed and never drawn, and it is acknowledged like a marker. The recording
    // player has no channel to the agent (obj.parent == null), sends nothing and decodes what the recording holds.
    var SV_MAX_FRAME = 8 * 1024 * 1024;
    var sv = { activation: 0, want: 0, requested: false, state: null, waitTimer: null, timedOut: false, reqTimer: null, lastReq: 0, retryTimer: null, retryAt: 0, retries: 0, visListener: null,
        lastSeq: null, done: null, sentSeq: 0, sentTs: 0, lastSend: 0, paceTimer: null, lastStrayOp2: 0, screenW: 0, screenH: 0, op1W: 0, op1H: 0,
        stats: { requests: 0, states: 0, rejected: 0, lastReject: null, rejects: {}, positions: 0, markers: 0, frames: 0, stray: 0, gaps: 0, acks: 0, op2: 0, op3: 0 } };
    // The end-to-end ACK is off by default until it has been measured : the viewer asks for it (240 op 4) only when StreamAckEnabled is true or, while it is null,
    // when the page was opened with ?streamack=1 (development and measurement). false: never (the thumbnails of the multi-desktop view set this). The video option
    // (H264Enabled) asks with op 1, which brings the ACK with it, unless StreamAckEnabled is false.
    obj.StreamAckEnabled = null;
    obj.StreamStats = sv.stats;
    // What the agent announced last (announced is false before the first valid 242) and the viewer's side of the negotiation.
    obj.StreamState = function () {
        var s = sv.state;
        return { announced: (s != null), video: (s != null) && (s.video === 1), ack: (s != null) && (s.ack === 1), reason: (s != null) ? s.reason : null, gen: (s != null) ? s.gen : null, caps: (s != null) ? s.caps : 0,
            profile: (s != null) ? s.profile : 0, level: (s != null) ? s.level : 0, codedW: (s != null) ? s.codedW : 0, codedH: (s != null) ? s.codedH : 0,
            requested: sv.want, timedOut: sv.timedOut, retries: sv.retries, lastSeq: sv.lastSeq };
    }

    function svNow() { return Date.now(); }
    function svU16(b, o) { return (b[o] << 8) | b[o + 1]; }
    function svU32(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    function svNext(x) { return (x >= 0xFFFFFFFF) ? 1 : (x + 1); }
    function svReject(code) { sv.stats.rejected++; sv.stats.lastReject = code; sv.stats.rejects[code] = (sv.stats.rejects[code] || 0) + 1; }

    // 242 (protocol 4.1). Returns null or the rejection code. view is the command as the transport hands it over, size is its size field.
    function svCheck242(view, size) {
        if (view.length < 4) { return 'TRUNCATED'; }
        if (size !== 16) { return 'BAD_SIZE'; }
        if (view.length < 16) { return 'TRUNCATED'; }
        if (view.length > 16) { return 'BAD_SIZE'; }
        if (view[4] !== 1) { return 'BAD_VERSION'; }
        if ((view[5] > 1) || (view[6] > 1) || ((view[5] === 1) && (view[6] === 0))) { return 'BAD_FIELD'; }
        return null;
    }

    // 243 (protocol 4.2, steps 2 to 10; the transport has already unwrapped MNG_JUMBO, so view is the inner command and size is its length N).
    function svCheck243(view, size) {
        if (size > SV_MAX_FRAME) { return 'FRAME_TOO_BIG'; }
        if (size < 20) { return 'BAD_SIZE'; }
        if (view.length < size) { return 'TRUNCATED'; }
        if (svU16(view, 0) !== 243) { return 'NOT_243'; }
        if (svU32(view, 4) === 0) { return 'BAD_SEQ'; }
        var flags = view[12], codedW = svU16(view, 14), codedH = svU16(view, 16), nRects = svU16(view, 18);
        if ((flags & 3) === 3) { return 'BAD_MARKER'; }
        if ((flags & 2) !== 0) { return ((size !== 20) || (nRects !== 0) || (codedW !== 0) || (codedH !== 0)) ? 'BAD_MARKER' : null; }
        if ((nRects < 1) || (nRects > 256)) { return 'BAD_RECT_COUNT'; }
        if ((20 + (8 * nRects)) > size) { return 'TRUNCATED'; }
        var sw = sv.screenW, sh = sv.screenH;
        if ((sw === 0) || (sh === 0)) { return 'NO_SCREEN'; }
        var pw = Math.ceil(sw / 32) * 32, ph = Math.ceil(sh / 32) * 32;
        if ((codedW !== pw) || (codedH !== ph) || (codedW < 32) || (codedH < 32) || (codedW > 8192) || (codedH > 8192)) { return 'CODED_SIZE'; }
        for (var i = 0; i < nRects; i++) {
            var o = 20 + (i * 8), x = svU16(view, o), y = svU16(view, o + 2), w = svU16(view, o + 4), h = svU16(view, o + 6);
            if ((w < 1) || (h < 1) || ((x + w) > sw) || ((y + h) > sh)) { return 'BAD_RECT'; }
        }
        if ((size - 20 - (8 * nRects)) < 5) { return 'NO_PAYLOAD'; }
        return null;
    }
    obj.StreamCheck242 = svCheck242;
    obj.StreamCheck243 = function (view, size, screenW, screenH) { var w = sv.screenW, h = sv.screenH; sv.screenW = screenW; sv.screenH = screenH; try { return svCheck243(view, size); } finally { sv.screenW = w; sv.screenH = h; } }

    function svClearTimers() {
        if (sv.paceTimer != null) { clearTimeout(sv.paceTimer); sv.paceTimer = null; }
        if (sv.waitTimer != null) { clearTimeout(sv.waitTimer); sv.waitTimer = null; }
        if (sv.reqTimer != null) { clearTimeout(sv.reqTimer); sv.reqTimer = null; }
        if (sv.retryTimer != null) { clearTimeout(sv.retryTimer); sv.retryTimer = null; }
        if ((sv.visListener != null) && (typeof document == 'object') && document.removeEventListener) { document.removeEventListener('visibilitychange', sv.visListener); }
        sv.visListener = null;
    }

    // Everything here belongs to one connection; the module calls this on every start and stop
    function streamReset() {
        svClearTimers();
        sv.activation++; // positions still queued become stale
        sv.want = 0; sv.requested = false; sv.op1Auto = false; sv.state = null; sv.timedOut = false; sv.lastReq = 0; sv.retryAt = 0; sv.retries = 0;
        sv.lastSeq = null; sv.done = null; sv.sentSeq = 0; sv.sentTs = 0; sv.lastSend = 0; sv.lastStrayOp2 = 0; sv.screenW = 0; sv.screenH = 0; sv.op1W = 0; sv.op1H = 0;
        if (h264 != null) { h264.reset(); }
        videoStatusNotify();
    }

    // The channel to the agent: a live transport that is connected (the player, which has none, never sends)
    function svBound() { return (obj.parent != null) && (obj.State == 3) && (typeof obj.parent.send == 'function'); }

    function svSend240(op, flags) {
        var b = new Uint8Array(16);
        b[1] = 240; b[3] = 16; b[4] = 1; b[5] = op; b[6] = flags || 0; // limits and the reserved word stay 0 for ops 2, 3 and 4
        obj.parent.send(b);
    }

    // 240 op 4: only the ACK, the picture stays JPEG. Asked once after the first screen size, again after 242 with reason 10 or 11 and after reason 9.
    function streamAckWanted() {
        if (obj.StreamAckEnabled === false) return false;
        if (obj.StreamAckEnabled === true) return true;
        if (obj.H264Enabled === true) return true;
        if (autoAckWanted()) return true;       // Auto in the browser: the markers carry the time of the agent, and its window of ACK keeps the queue short; it stays to the end of the connection
        return (typeof urlargs == 'object') && (urlargs != null) && (urlargs.streamack == '1');
    }

    // What the browser can decode for the screen: undefined while the check runs (it asks again when it is done), then { ok, flags, maxLevelIdc, maxW, maxH }
    var h264Caps = {}, h264CapsPending = {};
    function h264CapsFor(w, h) {
        var key = w + 'x' + h;
        if (h264Caps[key] !== undefined) { return h264Caps[key]; }
        if (!h264CapsPending[key]) {
            h264CapsPending[key] = true;
            var act = sv.activation, done = function (r) { h264Caps[key] = r; delete h264CapsPending[key]; if (act === sv.activation) { streamRequest(); videoStatusNotify(); } };
            h264Module().detect(w, h, obj.H264Options).then(done, function () { done({ ok: false, flags: 0, maxLevelIdc: 0, maxW: 0, maxH: 0 }); });
        }
        return undefined;
    }

    // 240 op 1 (video and ACK) when H.264 is selected and the browser can decode it, else op 4 (ACK only) when that is wanted; ackOnly forces op 4
    function streamRequest(ackOnly) {
        if ((obj.StreamAckEnabled === false) || !svBound() || (obj.parent.protocol != 2)) return;
        var cap = null;
        if ((ackOnly !== true) && (obj.H264Enabled === true) && (h264Module() != null) && ((h264 == null) || !h264.disabled)) {
            cap = h264CapsFor(sv.screenW, sv.screenH);
            if (cap === undefined) return;
        }
        var video = (cap != null) && cap.ok;
        if (!video && !streamAckWanted()) return;
        sv.want = video ? 1 : 4; sv.lastReq = svNow();
        sv.stats.requests++;
        if (video) {
            var b = new Uint8Array(16);
            sv.op1Auto = autoWantsBit();      // bit 3: the viewer chose Auto (Auto of the agent); in every op 1, also after reason 10 / 11 and 9, or the agent falls back to a fixed rate
            b[1] = 240; b[3] = 16; b[4] = 1; b[5] = 1; b[6] = cap.flags | (sv.op1Auto ? 8 : 0); b[7] = cap.maxLevelIdc;
            b[8] = cap.maxW >> 8; b[9] = cap.maxW & 255; b[10] = cap.maxH >> 8; b[11] = cap.maxH & 255;
            sv.op1W = cap.maxW; sv.op1H = cap.maxH;
            obj.parent.send(b);
        } else { svSend240(4, 0); }
        if ((sv.state == null) && (sv.waitTimer == null)) {
            // An agent that does not know the protocol never answers: after 3 s the viewer stays with JPEG. A later 242 is still taken (it starts the state machine).
            sv.waitTimer = setTimeout(function () { sv.waitTimer = null; if (sv.state == null) { sv.timedOut = true; videoStatusNotify(); } }, 3000);
        }
    }

    // 242 reason 10 or 11 must be answered with the request again; at most every 250 ms, so that a broken agent cannot make this a flood
    function streamRequestSoon() {
        var wait = (sv.lastReq + 250) - svNow();
        if (wait <= 0) { streamRequest(); return; }
        if (sv.reqTimer == null) { sv.reqTimer = setTimeout(function () { sv.reqTimer = null; streamRequest(); }, wait); }
    }

    // After reason 9 (no ACK for 15 s): ask again after 30 s when the page is visible, at most 3 times; when it is hidden, after it is shown
    function streamRetry() {
        sv.retryTimer = null;
        if (!svBound() || (sv.want === 0) || (sv.retries >= 3) || ((sv.state != null) && (sv.state.ack === 1))) return;
        if (kvmAckVisible()) { sv.retries++; streamRequest(); return; }
        if ((sv.visListener == null) && (typeof document == 'object') && document.addEventListener) {
            sv.visListener = function () {
                if (!kvmAckVisible() || (svNow() < sv.retryAt)) return;
                document.removeEventListener('visibilitychange', sv.visListener);
                sv.visListener = null;
                streamRetry();
            };
            document.addEventListener('visibilitychange', sv.visListener);
        }
    }

    // 242 from the agent (or, in a recording, from the file)
    function streamState(view, size) {
        var err = svCheck242(view, size);
        if (err != null) { svReject(err); return; }
        var st = { video: view[5], ack: view[6], reason: view[7], profile: view[8], level: view[9], codedW: svU16(view, 10), codedH: svU16(view, 12), caps: view[14] & 0x7F, gen: view[15] };
        sv.state = st; sv.stats.states++; sv.timedOut = false;
        if (st.reason === 9) { autoR9At = svNow(); }
        if (autoRun && (autoCtl != null)) { autoCtl.ownerNow(); }     // the owner of the interval is looked at with every 242 (caps bit 2 may be gone with the video on): the viewer takes over at once
        sv.lastSeq = null; // a new child process counts from 1 again
        if (sv.waitTimer != null) { clearTimeout(sv.waitTimer); sv.waitTimer = null; }
        if ((h264Module() != null) && ((obj.parent == null) || (obj.H264Enabled === true) || (h264 != null))) { h264Get().onState(st); } // needIdr and expectedGen belong to the decoder (7.1)
        if (st.ack === 0) { sv.done = null; if (sv.paceTimer != null) { clearTimeout(sv.paceTimer); sv.paceTimer = null; } }
        if (obj.parent == null) return; // a recording: the state is only recorded
        videoStatusNotify();
        if ((st.reason === 6) && (sv.want === 1) && (st.ack === 0) && streamAckWanted()) { streamRequest(true); } // video refused by a switch, the ACK is still wanted
        else if (((st.reason === 10) || (st.reason === 11)) && (sv.want !== 0)) { streamRequestSoon(); }
        else if (st.reason === 9) {
            if ((sv.retryTimer == null) && (sv.retries < 3)) { sv.retryAt = svNow() + 30000; sv.retryTimer = setTimeout(streamRetry, 30000); }
        }
    }

    // A queue position of the stream. It is a marker operation in the draw queue (t0) that is consumed when everything before it has been drawn or dropped.
    // A marker at the tail takes the newer position and the newer ACK tag (both are cumulative, nothing lies between them).
    function streamPosition(seq, ts, tag) {
        var q = obj.PendingOperations, tail = (q.length > 0) ? q[q.length - 1] : null;
        var pos = { seq: seq, ts: ts, rx: svNow(), a: sv.activation, q: 0 };
        sv.stats.positions++;
        if ((tail != null) && (tail.t === 0) && !tail.dropped) { tail.pos = pos; if (tag != null) { tail.ackTag = tag; } return; }
        if (budgetsApply() && (q.length >= obj.MaxQueuedOps)) { queueOverflow(); }
        q.push({ t: 0, st: 1, bytes: 0, px: 0, img: null, ackTag: tag, pos: pos, dropped: false });
        drainOperations();
    }

    // 243. Returns the ACK tag when this function did not attach it to a queue operation (a refused frame has no position).
    function streamFrame(view, size, tag) {
        var err = svCheck243(view, size);
        if (err != null) { svReject(err); if (h264Want()) { h264Get().streamError(err); } return tag; }
        var seq = svU32(view, 4), ts = svU32(view, 8), flags = view[12];
        var gap = (sv.lastSeq !== null) && ((flags & 1) === 0) && (seq !== svNext(sv.lastSeq));
        if (gap) { sv.stats.gaps++; } // without a decoder it is only counted
        sv.lastSeq = seq;
        var want = h264Want();
        if ((flags & 2) !== 0) { sv.stats.markers++; if (gap && want) { h264Get().gap(); } streamPosition(seq, ts, tag); return null; }
        sv.stats.frames++;
        if (!want) {
            // A frame nobody decodes: its position is consumed. When the last 242 said video = 0 this viewer has not asked for it:
            // a sender that keeps on sending is asked to stop with 240 op 2, at most every 5 s. A frame while video = 1 but this viewer does not want video
            // belongs to somebody else's request: it is only consumed (op 2 would switch the video off for that viewer).
            if ((sv.state == null) || (sv.state.video === 0)) {
                sv.stats.stray++;
                if (svBound() && ((svNow() - sv.lastStrayOp2) >= 5000)) { sv.lastStrayOp2 = svNow(); sv.stats.op2++; svSend240(2, 0); }
            }
            streamPosition(seq, ts, tag);
            return null;
        }
        // The first frame after a screen size opens the canvas like the first tile does (the queue is empty or holds only markers then)
        if (obj.FirstDraw) { obj.onResize(); }
        var video = h264Get(), op = video.accept(h264Module().parseFrame(view, size), gap);
        op.pos = { seq: seq, ts: ts, rx: svNow(), a: sv.activation, q: 0 };
        op.ackTag = tag;
        sv.stats.positions++;
        var q = obj.PendingOperations;
        // the compressed bytes of the frame count against MaxQueuedBytes like those of a tile (they are held until the frame is consumed)
        if (budgetsApply() && ((q.length >= obj.MaxQueuedOps) || ((obj.QueuedBytes + op.bytes) > obj.MaxQueuedBytes))) { queueOverflow(); }
        q.push(op);
        obj.QueuedBytes += op.bytes;
        drainOperations();
        return null;
    }

    // A position has left the draw queue (consumed or dropped)
    function streamDone(pos) {
        if ((pos == null) || (pos.a !== sv.activation)) return;
        pos.q = Math.max(0, Math.min(65535, svNow() - pos.rx));
        sv.done = pos;
        streamAckMaybeSend();
    }

    // 241: the newest consumed position, not more often than every 20 ms, only while the agent's last 242 said ack = 1
    function streamAckMaybeSend() {
        var d = sv.done;
        if ((d == null) || (sv.state == null) || (sv.state.ack !== 1) || ((d.seq === sv.sentSeq) && (d.ts === sv.sentTs))) return;
        var wait = (sv.lastSend + 20) - svNow();
        if (wait > 0) { if (sv.paceTimer == null) { sv.paceTimer = setTimeout(function () { sv.paceTimer = null; streamAckMaybeSend(); }, wait); } return; }
        if (!svBound()) return;
        var b = new Uint8Array(16);
        b[1] = 241; b[3] = 16;
        b[4] = (d.seq >>> 24) & 255; b[5] = (d.seq >>> 16) & 255; b[6] = (d.seq >>> 8) & 255; b[7] = d.seq & 255;
        b[8] = (d.ts >>> 24) & 255; b[9] = (d.ts >>> 16) & 255; b[10] = (d.ts >>> 8) & 255; b[11] = d.ts & 255;
        b[12] = (d.q >>> 8) & 255; b[13] = d.q & 255;
        b[15] = kvmAckVisible() ? 0 : 1; // flags bit 0: the page is hidden
        sv.sentSeq = d.seq; sv.sentTs = d.ts; sv.lastSend = svNow();
        sv.stats.acks++;
        obj.parent.send(b);
    }

    // The first cmd 7 opens the negotiation
    function streamScreen(width, height) {
        sv.screenW = width; sv.screenH = height;
        if (!sv.requested) { sv.requested = true; streamRequest(); }
        else if ((sv.want === 1) && ((Math.ceil(width / 32) * 32 > sv.op1W) || (Math.ceil(height / 32) * 32 > sv.op1H))) { streamRequest(); } // a larger screen than the limits of the request: ask again (agent: reason 7)
    }

    // CopyRect: 6 big-endian 16 bit values, SX SY DX DY WIDTH HEIGHT, in the coordinates of the remote screen. It is queued like a tile.
    obj.ProcessCopyRectMsg = function (d) {
        if (d.length < 12) return;
        var v = (typeof d == 'string') ? function (i) { return ((d.charCodeAt(i) & 0xFF) << 8) + (d.charCodeAt(i + 1) & 0xFF); } : function (i) { return (d[i] << 8) + d[i + 1]; };
        var op = { t: 1, st: 1, sx: v(0), sy: v(2), dx: v(4), dy: v(6), w: v(8), h: v(10), img: null, bytes: 0, px: 0, dropped: false };
        obj.tilesReceived++;
        if (!enqueueOperation(op)) return null;
        drainOperations();
        return op;
    }

    // The canvas rectangle (x, y, w, h) in canvas pixels of a rectangle of the remote screen, for the current rotation.
    obj.rotRect = function (x, y, w, h) {
        var cw = obj.Canvas.canvas.width, ch = obj.Canvas.canvas.height, ax, ay, bx, by;
        switch (obj.rotation) {
            case 1: ax = cw - y; ay = x; bx = cw - (y + h); by = x + w; break;
            case 2: ax = cw - x; ay = ch - y; bx = cw - (x + w); by = ch - (y + h); break;
            case 3: ax = y; ay = ch - x; bx = y + h; by = ch - (x + w); break;
            default: ax = x; ay = y; bx = x + w; by = y + h; break;
        }
        return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
    }

    function drawCopyRect(op) {
        var c = obj.Canvas, cv = c.canvas;
        if ((cv.width == 0) || (cv.height == 0) || (op.w == 0) || (op.h == 0)) return;
        if (obj.rotation == 0) { c.drawImage(cv, op.sx, op.sy, op.w, op.h, op.dx, op.dy, op.w, op.h); return; }
        // The canvas holds the rotated picture and the context carries the rotation, so copy in canvas pixels with an identity transform.
        var s = obj.rotRect(op.sx, op.sy, op.w, op.h), d = obj.rotRect(op.dx, op.dy, op.w, op.h);
        c.save();
        try { c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(cv, s.x, s.y, s.w, s.h, d.x, d.y, s.w, s.h); } finally { c.restore(); }
    }

    obj.SendUnPause = function () {
        if (obj.debugmode > 1) { console.log('SendUnPause'); }
        //obj.xxStateChange(3);
        obj.send(String.fromCharCode(0x00, 0x08, 0x00, 0x05, 0x00));
    }

    obj.SendPause = function () {
        if (obj.debugmode > 1) { console.log('SendPause'); }
        //obj.xxStateChange(2);
        obj.send(String.fromCharCode(0x00, 0x08, 0x00, 0x05, 0x01));
    }

    // Command 5 is 10 bytes (type, level, scaling, frame interval) or, with a bandwidth budget, 12 (plus the budget as u16, units of 100 kbit/s, 0 = no limit).
    // A budget given once is kept for later calls without one (the resend after a screen size change); a session that never gave one sends 10 bytes
    // as before (the thumbnails of the multi desktop view). Agents that do not know the budget ignore the extra bytes.
    obj.SendCompressionLevel = function (type, level, scaling, frametimer, budget) { // Type: 1 = JPEG, 2 = PNG, 3 = TIFF, 4 = WebP
        if ((obj.H264Enabled === true) && (type != 1) && (type != 4)) { type = 1; } // video needs the adaptive JPEG/WebP path of the agent for the sharpening (protocol 5.4)
        obj.ImageType = type;
        if (level) { obj.CompressionLevel = level; }
        if (scaling) { obj.ScalingLevel = scaling; }
        if (frametimer) { obj.SetFrameRate(frametimer); }       // a number of ms or 'auto' (Auto in the browser: the module of Auto owns the interval)
        if ((budget != null) && (budget !== '') && !isNaN(parseInt(budget))) { obj.BandwidthBudget = Math.max(0, Math.min(65535, parseInt(budget))); }
        sendCompression();
    }
    // The command 5 with what is kept of the user's choice: type, quality, scale, budget, and the interval (the step of Auto while it is the owner of it). Auto only changes the interval
    function sendCompression() {
        var type = obj.ImageType, withBudget = (obj.BandwidthBudget != null);
        function command(frameInterval) {
            return String.fromCharCode(0x00, 0x05, 0x00, withBudget ? 0x0C : 0x0A, type, obj.CompressionLevel) + obj.shortToStr(obj.ScalingLevel) + obj.shortToStr(frameInterval) + (withBudget ? obj.shortToStr(obj.BandwidthBudget) : '');
        }
        // The agent ignores a frame interval below 20 ms and keeps the previous one. For a shorter interval (60 fps = 16 ms) the same message is
        // sent twice: first with 20 ms, which every agent accepts (50 fps, what an agent that does not know shorter intervals ends up with),
        // then with the real interval, which an agent that allows it takes over. Both carry the same budget.
        var fr = parseInt(obj.FrameRateTimer);
        if (isNaN(fr)) { obj.FrameRateTimer = fr = 33; }
        if (fr < 20) { obj.send(command(20)); }
        obj.send(command(obj.FrameRateTimer));
    }
    // The frame interval of the user: a number of ms, or 'auto'. The pages call this (and SendCompressionLevel) and never put 'auto' into FrameRateTimer themselves
    obj.SetFrameRate = function (v) {
        if (v === 'auto') { autoSetMode(true); return; }
        var n = parseInt(v);
        autoSetMode(false);
        if (n > 0) { obj.FrameRateTimer = n; }
    }

    obj.SendRefresh = function () {
        autoFreeze(600000, 'refresh');
        obj.send(String.fromCharCode(0x00, 0x06, 0x00, 0x04));
        h264Repair(2); // cmd 6 does not repaint what the video painted (7.3): the agent sends the tiles of the video again as JPEG
    }

    obj.ProcessScreenMsg = function (width, height) {
        if (obj.debugmode > 0) { console.log('ScreenSize: ' + width + ' x ' + height); }
        sv.screenW = width; sv.screenH = height; // the player seeks with this call alone: the validation of video frames needs the size
        if ((obj.ScreenWidth == width) && (obj.ScreenHeight == height)) return; // Ignore change if screen is same size.
        // A new size with the same proportions as the picture on the canvas (2 pixels of rounding allowed) is what the agent sends when it lowers or restores
        // its picture scale under a bandwidth limit. The canvas then takes the new size at once, with the old picture stretched to it, and the new tiles
        // overwrite it. Only for an unrotated view that has a picture; any other size change leaves the canvas as it was until the first tile (a blank canvas).
        var cw = obj.Canvas.canvas.width, ch = obj.Canvas.canvas.height;
        var keepPicture = ((obj.rotation == 0) && (obj.DrawSeq > 0) && (cw > 0) && (ch > 0) && (width > 0) && (Math.abs(height - (width * ch / cw)) <= 2));
        obj.Canvas.setTransform(1, 0, 0, 1, 0, 0);
        obj.rotation = 0;
        obj.FirstDraw = true;
        obj.KeepPictureOnResize = keepPicture;
        obj.ScreenWidth = obj.width = width;
        obj.ScreenHeight = obj.height = height;
        autoFreeze(800000, 'screen');
        obj.DropPendingOperations(); // Everything queued belongs to the old screen. The counters start again with the new one.
        if (keepPicture) { presentFlush(); } else { presentDiscard(); }   // the old picture is kept and stretched: the pictures that wait are drawn on it first (nothing is lost); on any other change of size they belong to the old screen and go
        if (h264 != null) { h264.screenChanged(); } // the decoder goes with the screen; the agent starts a new generation with an IDR picture
        obj.KillDraw = obj.tilesReceived = obj.TilesDrawn = 0;
        if (keepPicture) { obj.onResize(); } // the queue is empty, so resizing the canvas here cannot reorder drawing
        obj.SendCompressionLevel(obj.ImageType);
        obj.SendUnPause();
        obj.SendRemoteInputLock(2); // Query input lock state
        // No need to event the display size change now, it will be evented on first draw.
        if (obj.onScreenSizeChange != null) { obj.onScreenSizeChange(obj, obj.ScreenWidth, obj.ScreenHeight, obj.CanvasId); }
    }

    obj.ProcessBinaryCommand = function (cmd, cmdsize, view, fromWire) {
        var X, Y, op = null, ackTag = kvmAckTag(cmd, fromWire, view); // fromWire: set by the transport for frames received on its websocket
        autoMetaCheck();        // the number of viewers (no timer: the check is a comparison of one reference, and it runs with every command and every window of Auto)
        if (autoRun) { autoNote(cmd, cmdsize, view); }
        if ((cmd == 3) || (cmd == 4) || (cmd == 7)) { X = (view[4] << 8) + view[5]; Y = (view[6] << 8) + view[7]; }
        if (obj.debugmode > 2) { console.log('CMD', cmd, cmdsize, X, Y); }

        // Record the command if needed
        if (obj.recordedData != null) {
            // Fix for view being too large for String.fromCharCode.apply()
            var chunkSize = 10000;
            let result = '';
            for (let i = 0; i < view.length; i += chunkSize) { result += String.fromCharCode.apply(null, view.slice(i, i + chunkSize)); }
            if (cmd == 243) {
                // A video frame or a marker is always written in a jumbo packet (its own size field is 0): MNG_JUMBO, the length of the inner command, the inner command
                obj.recordedData.push(recordingEntry(2, 1, obj.shortToStr(27) + obj.shortToStr(8) + obj.intToStr(cmdsize) + result));
            } else if (cmdsize > 65000) {
                obj.recordedData.push(recordingEntry(2, 1, obj.shortToStr(27) + obj.shortToStr(8) + obj.intToStr(cmdsize) + obj.shortToStr(cmd) + obj.shortToStr(0) + obj.shortToStr(0) + obj.shortToStr(0) + result));
            } else {
                obj.recordedData.push(recordingEntry(2, 1, result));
            }
        }

        switch (cmd) {
            case 3: // Tile
                if (obj.FirstDraw) obj.onResize();
                //console.log('TILE', X, Y, cmdsize);
                op = obj.ProcessPictureMsg(view.slice(4), X, Y);
                break;
            case 4: // CopyRect: SX, SY, DX, DY, WIDTH, HEIGHT
                if (cmdsize < 16) break;
                // Only the first operation after a screen size change can see FirstDraw set, and the queue is empty then, so resizing the canvas here cannot reorder drawing.
                if (obj.FirstDraw) obj.onResize();
                obj.ProcessCopyRectMsg(view.slice(4));
                break;
            case 7: // Screen size
                sv.screenW = X; sv.screenH = Y;
                obj.ProcessScreenMsg(X, Y);
                obj.SendKeyMsgKC(obj.KeyAction.UP, 16); // Shift
                obj.SendKeyMsgKC(obj.KeyAction.UP, 17); // Ctrl
                obj.SendKeyMsgKC(obj.KeyAction.UP, 18); // Alt
                obj.SendKeyMsgKC(obj.KeyAction.UP, 91); // Left-Windows
                obj.SendKeyMsgKC(obj.KeyAction.UP, 92); // Right-Windows
                obj.SendKeyMsgKC(obj.KeyAction.UP, 16); // Shift
                obj.send(String.fromCharCode(0x00, 0x0E, 0x00, 0x04));
                streamScreen(X, Y);
                break;
            case 11: // GetDisplays (TODO)
                var selectedDisplay = 0, displays = {}, dcount = (view[4] << 8) + view[5];
                if (dcount > 0) {
                    // Many displays present
                    selectedDisplay = (view[6 + (dcount * 2)] << 8) + view[7 + (dcount * 2)];
                    for (var i = 0; i < dcount; i++) {
                        var disp = (view[6 + (i * 2)] << 8) + view[7 + (i * 2)];
                        if (disp == 65535) { displays[disp] = 'All Displays'; } else { displays[disp] = 'Display ' + disp; }
                    }
                }
                //console.log('Get Displays', displays, selectedDisplay, rstr2hex(str));
                obj.displays = displays; obj.selectedDisplay = selectedDisplay;
                if (obj.onDisplayinfo != null) { obj.onDisplayinfo(obj, displays, selectedDisplay); }
                break;
            case 12: // SetDisplay
                //console.log('SetDisplayConfirmed');
                break;
            case 14: // KVM_INIT_TOUCH
                obj.touchenabled = 1;
                obj.TouchArray = {};
                if (obj.onTouchEnabledChanged != null) obj.onTouchEnabledChanged(obj.touchenabled);
                break;
            case 15: // KVM_TOUCH
                obj.TouchArray = {};
                break;
            case 17: // MNG_KVM_MESSAGE
                var str = String.fromCharCode.apply(null, view.slice(4));
                console.log('Got KVM Message: ' + str);
                if (obj.onMessage != null) obj.onMessage(str, obj);
                break;
            case 18: // MNG_KVM_KEYSTATE
                if ((cmdsize != 5) || (obj.KeyboardState == view[4])) break;
                obj.KeyboardState = view[4]; // 1 = NumLock, 2 = ScrollLock, 4 = CapsLock
                if (obj.onKeyboardStateChanged) { obj.onKeyboardStateChanged(obj, obj.KeyboardState); }
                console.log('MNG_KVM_KEYSTATE:' + ((obj.KeyboardState & 1) ? ' NumLock' : '') + ((obj.KeyboardState & 2) ? ' ScrollLock' : '') + ((obj.KeyboardState & 4) ? ' CapsLock' : ''));
                break;
            case 65: // Alert
                var str = String.fromCharCode.apply(null, view.slice(4));
                if (str[0] != '.') {
                    console.log(str); //alert('KVM: ' + str);
                    if (obj.parent && obj.parent.setConsoleMessage) { obj.parent.setConsoleMessage(str); }
                } else {
                    console.log('KVM: ' + str.substring(1));
                }
                break;
            case 242: // VIDEO_STATE: what the agent can do and what it does now
                streamState(view, cmdsize);
                break;
            case 243: // VIDEO_FRAME: a video frame or a marker. Its position is acknowledged once everything before it has been consumed.
                ackTag = streamFrame(view, cmdsize, ackTag);
                break;
            case 82: // DISPLAY LOCATION & SIZE
                if ((cmdsize < 4) || (((cmdsize - 4) % 10) != 0)) break;
                var screenCount = ((cmdsize - 4) / 10), screenInfo = {}, ptr = 4;
                for (var i = 0; i < screenCount; i++) { screenInfo[(view[ptr + 0] << 8) + view[ptr + 1]] = { x: ((view[ptr + 2] << 8) + view[ptr + 3]), y: ((view[ptr + 4] << 8) + view[ptr + 5]), w: ((view[ptr + 6] << 8) + view[ptr + 7]), h: ((view[ptr + 8] << 8) + view[ptr + 9]) }; ptr += 10; }
                //console.log('ScreenInfo', JSON.stringify(screenInfo, null, 2));
                break;
            case 87: // MNG_KVM_INPUT_LOCK
                if (cmdsize != 5) break;
                if ((obj.RemoteInputLock == null) || (obj.RemoteInputLock !== (view[4] != 0))) {
                    obj.RemoteInputLock = (view[4] != 0);
                    if (obj.onRemoteInputLockChanged) { obj.onRemoteInputLockChanged(obj, obj.RemoteInputLock); }
                }
                break;
            case 88: // MNG_KVM_MOUSE_CURSOR
                if ((cmdsize != 5) || (obj.stopInput)) break;
                var cursorNum = view[4];
                if (cursorNum > mouseCursors.length) { cursorNum = 0; }
                xMouseCursorCurrent = mouseCursors[cursorNum];
                if (xMouseCursorActive) { obj.CanvasId.style.cursor = xMouseCursorCurrent; }
                break;
            default:
                console.log('Unknown command', cmd, cmdsize);
                break;
        }
        // The tag goes on the queue operation this frame created; a counted frame without one (screen size, refused tile) gets a marker
        if (ackTag != null) { if (op != null) { op.ackTag = ackTag; } else { kvmAckMarker(ackTag); } }
    }
    
    // Keyboard and Mouse I/O.
    obj.MouseButton = { "NONE": 0x00, "LEFT": 0x02, "RIGHT": 0x08, "MIDDLE": 0x20 };
    obj.KeyAction = { "NONE": 0, "DOWN": 1, "UP": 2, "SCROLL": 3, "EXUP": 4, "EXDOWN": 5, "DBLCLICK": 6 };
    obj.InputType = { "KEY": 1, "MOUSE": 2, "CTRLALTDEL": 10, "TOUCH": 15, "KEYUNICODE": 85 };
    obj.Alternate = 0;

    var convertKeyCodeTable = {
        "Pause": 19,
        "CapsLock": 20,
        "Space": 32,
        "Quote": 222,
        "Minus": 189,
        "NumpadMultiply": 106,
        "NumpadAdd": 107,
        "PrintScreen": 44,
        "Comma": 188,
        "NumpadSubtract": 109,
        "NumpadDecimal": 110,
        "Period": 190,
        "Slash": 191,
        "NumpadDivide": 111,
        "Semicolon": 186,
        "Equal": 187,
        "OSLeft": 91,
        "BracketLeft": 219,
        "OSRight": 91,
        "Backslash": 220,
        "BracketRight": 221,
        "ContextMenu": 93,
        "Backquote": 192,
        "NumLock": 144,
        "ScrollLock": 145,
        "Backspace": 8,
        "Tab": 9,
        "Enter": 13,
        "NumpadEnter": 13,
        "Escape": 27,
        "Delete": 46,
        "Home": 36,
        "PageUp": 33,
        "PageDown": 34,
        "ArrowLeft": 37,
        "ArrowUp": 38,
        "ArrowRight": 39,
        "ArrowDown": 40,
        "End": 35,
        "Insert": 45,
        "F1": 112,
        "F2": 113,
        "F3": 114,
        "F4": 115,
        "F5": 116,
        "F6": 117,
        "F7": 118,
        "F8": 119,
        "F9": 120,
        "F10": 121,
        "F11": 122,
        "F12": 123,
        "ShiftLeft": 16,
        "ShiftRight": 16,
        "ControlLeft": 17,
        "ControlRight": 17,
        "AltLeft": 18,
        "AltRight": 18,
        "MetaLeft": 91,
        "MetaRight": 92,
        "VolumeMute": 181
        //"LaunchMail": 
        //"LaunchApp1":
        //"LaunchApp2":
        //"BrowserStop":
        //"MediaStop":
        //"MediaTrackPrevious":
        //"MediaTrackNext":
        //"MediaPlayPause":
        //"MediaSelect":
    }

    function convertKeyCode(e) {
        if (e.code.startsWith('Key') && e.code.length == 4) { return e.code.charCodeAt(3); }
        if (e.code.startsWith('Digit') && e.code.length == 6) { return e.code.charCodeAt(5); }
        if (e.code.startsWith('Numpad') && e.code.length == 7) { return e.code.charCodeAt(6) + 48; }
        return convertKeyCodeTable[e.code];
    }

    var extendedKeyTable = ['AltRight', 'ControlRight', 'Home', 'End', 'Insert', 'Delete', 'PageUp', 'PageDown', 'NumpadDivide', 'NumpadEnter', 'NumLock', 'Pause'];
    obj.SendKeyMsg = function (action, event) {
        if (action == null) return;
        if (!event) { event = window.event; }

        var extendedKey = false; // Test feature, add ?extkeys=1 to url to use.

        if ((obj.UseExtendedKeyFlag || (urlargs.extkeys == 1)) && (typeof event.code == 'string') && (event.code.startsWith('Arrow') || (extendedKeyTable.indexOf(event.code) >= 0))) {
            extendedKey = true; 
        }

        if (obj.isWindowsBrowser) {
            if( obj.checkAltGr(obj, event, action) ) {
              return;
            }; 
        }

        if ((obj.UseExtendedKeyFlag || (urlargs.extkeys == 1)) && ((event.code == 'ShiftRight') || ((event.keyCode == 16) && (event.location == 2)))) {
            // Right Shift has its own scan code, not an extended Left Shift scan code.
            obj.SendKeyMsgKC(action, 161, false);
        } else if ((extendedKey == false) && event.code && (event.code.startsWith('NumPad') == false) && (obj.localKeyMap == false)) {
            // Convert "event.code" into a scancode. This works the same regardless of the keyboard language.
            // Older browsers will not support this.
            var kc = convertKeyCode(event);
            if (kc != null) { obj.SendKeyMsgKC(action, kc, extendedKey); }
        } else {
            // Use this keycode, this works best with "US-EN" keyboards.
            // Older browser support this.
            var kc = event.keyCode;
            if (kc == 0x3B) { kc = 0xBA; } // Fix the ';' key
            else if (kc == 173) { kc = 189; } // Fix the '-' key for Firefox
            else if (kc == 61) { kc = 187; } // Fix the '=' key for Firefox
            obj.SendKeyMsgKC(action, kc, extendedKey);
        }
    }

    const ControlLeftKc = 17;
    const AltGrKc = 225;
    //return true: Key is alredy handled. 
    obj.checkAltGr = function (obj, event, action) {
        // Windows doesn't have a proper AltGr, but handles it using
        // fake Ctrl+Alt. However the remote end might not be Windows,
        // so we need to merge those into a single AltGr event. We
        // detect this case by seeing the two key events directly after
        // each other with a very short time between them (<50ms).
        if (obj._altGrArmed) {
            obj._altGrArmed = false;
            clearTimeout(obj._altGrTimeout);
            var deferredCtrlDown = obj._altGrDeferredDown;
            obj._altGrDeferredDown = false;

            if ((event.code === "AltRight") &&  ((event.timeStamp - obj._altGrCtrlTime) < 50)) {
                //AltGr detected.
                obj.SendKeyMsgKC( action, AltGrKc, false);
                return true;
            } 

            // Not an AltGr sequence: flush the deferred ControlLeft keydown BEFORE processing
            // this event, so the remote sees Ctrl go down first. Previously it was dropped
            // here, which lost fast Left-Ctrl taps and delivered "C before Ctrl" on a quick
            // Ctrl+C (issue #6491).
            if (deferredCtrlDown) {
                obj.SendKeyMsgKC( 1, ControlLeftKc, false);
            }
        }

        // Possible start of AltGr sequence? 
        // NOTE: `in` on an array tests INDICES, not membership — must be indexOf. Arming on
        // keyup (no timer, falls through to return false so the keyup still sends) is
        // intentional: it lets the AltRight keyup that follows merge into an AltGr keyup.
        if ((event.code === "ControlLeft") && (obj.pressedKeys.indexOf(ControlLeftKc) == -1)) {
          obj._altGrArmed = true;
            obj._altGrCtrlTime = event.timeStamp;
          if( action == 1 ) {
            obj._altGrDeferredDown = true;
            obj._altGrTimeout = setTimeout(obj._handleAltGrTimeout.bind(obj), 100);
            return true;
          }
        }
        return false;
    }

    obj._handleAltGrTimeout = function () { //Windows and no Ctrl+Alt -> send only Ctrl.
        obj._altGrArmed = false;
        obj._altGrDeferredDown = false;
        clearTimeout(obj._altGrTimeout);
        obj.SendKeyMsgKC( 1, ControlLeftKc, false); // (KeyDown, "ControlLeft", false)
    }

    // Send remote input lock. 0 = Unlock, 1 = Lock, 2 = Query
    obj.SendRemoteInputLock = function (code) { obj.send(String.fromCharCode(0x00, 87, 0x00, 0x05, code)); }

    obj.SendMessage = function (msg) {
        if (obj.State == 3) obj.send(String.fromCharCode(0x00, 0x11) + obj.shortToStr(4 + msg.length) + msg); // 0x11 = 17 MNG_KVM_MESSAGE
    }

    obj.SendKeyMsgKC = function (action, kc, extendedKey) {
        if (obj.State != 3) return;
        if (typeof action == 'object') { for (var i in action) { obj.SendKeyMsgKC(action[i][0], action[i][1], action[i][2]); } }
        else {
            if (action == 1) { // Key Down
                if (obj.pressedKeys.indexOf(kc) == -1) { obj.pressedKeys.unshift(kc); } // Add key press to start of array
            } else if (action == 2) { // Key Up
                var i = obj.pressedKeys.indexOf(kc);
                if (i != -1) { obj.pressedKeys.splice(i, 1); } // Remove the key press from the pressed array
            }
            if (obj.debugmode > 0) { console.log('Sending Key ' + kc + ', action ' + action); }

            var up = (action - 1);
            if (extendedKey) { if (up == 1) { up = 3; } else { up = 4; } }
            obj.send(String.fromCharCode(0x00, obj.InputType.KEY, 0x00, 0x06, up, kc));
        }
    }

    obj.SendStringUnicode = function (str) {
        if (obj.State != 3) return;
        for (var i = 0; i < str.length; i++) {
            obj.send(String.fromCharCode(0x00, obj.InputType.KEYUNICODE, 0x00, 0x07, 0) + ShortToStr(str.charCodeAt(i)));
            obj.send(String.fromCharCode(0x00, obj.InputType.KEYUNICODE, 0x00, 0x07, 1) + ShortToStr(str.charCodeAt(i)));
        }
    }

    obj.SendKeyUnicode = function (action, val) {
        if (obj.State != 3) return;
        if (obj.debugmode > 0) { console.log('Sending UnicodeKey ' + val + ', action ' + action); }
        obj.send(String.fromCharCode(0x00, obj.InputType.KEYUNICODE, 0x00, 0x07, (action - 1)) + ShortToStr(val));
    }

    obj.sendcad = function() { obj.SendCtrlAltDelMsg(); }

    obj.SendCtrlAltDelMsg = function () {
        if (obj.State == 3) { obj.send(String.fromCharCode(0x00, obj.InputType.CTRLALTDEL, 0x00, 0x04)); }
    }

    obj.SendEscKey = function () {
        if (obj.State == 3) obj.send(String.fromCharCode(0x00, obj.InputType.KEY, 0x00, 0x06, 0x00, 0x1B, 0x00, obj.InputType.KEY, 0x00, 0x06, 0x01, 0x1B));
    }

    obj.SendStartMsg = function () {
        obj.SendKeyMsgKC(obj.KeyAction.EXDOWN, 0x5B); // L-Windows
        obj.SendKeyMsgKC(obj.KeyAction.EXUP, 0x5B); // L-Windows
    }

    obj.SendCharmsMsg = function () {
        obj.SendKeyMsgKC(obj.KeyAction.EXDOWN, 0x5B); // L-Windows
        obj.SendKeyMsgKC(obj.KeyAction.DOWN, 67); // C
        obj.SendKeyMsgKC(obj.KeyAction.UP, 67); // C
        obj.SendKeyMsgKC(obj.KeyAction.EXUP, 0x5B); // L-Windows
    }

    obj.SendTouchMsg1 = function (id, flags, x, y) {
        if (obj.State == 3) obj.send(String.fromCharCode(0x00, obj.InputType.TOUCH) + obj.shortToStr(14) + String.fromCharCode(0x01, id) + obj.intToStr(flags) + obj.shortToStr(x) + obj.shortToStr(y));
    }

    obj.SendTouchMsg2 = function (id, flags) {
        var msg = '';
        var flags2;
        var str = "TOUCHSEND: ";
        for (var k in obj.TouchArray) {
            if (k == id) { flags2 = flags; } else {
                if (obj.TouchArray[k].f == 1) { flags2 = 0x00010000 | 0x00000002 | 0x00000004; obj.TouchArray[k].f = 3; str += "START" + k; } // POINTER_FLAG_DOWN
                else if (obj.TouchArray[k].f == 2) { flags2 = 0x00040000; str += "STOP" + k; } // POINTER_FLAG_UP
                else flags2 = 0x00000002 | 0x00000004 | 0x00020000; // POINTER_FLAG_UPDATE
            }
            msg += String.fromCharCode(k) + obj.intToStr(flags2) + obj.shortToStr(obj.TouchArray[k].x) + obj.shortToStr(obj.TouchArray[k].y);
            if (obj.TouchArray[k].f == 2) delete obj.TouchArray[k];
        }
        if (obj.State == 3) obj.send(String.fromCharCode(0x00, obj.InputType.TOUCH) + obj.shortToStr(5 + msg.length) + String.fromCharCode(0x02) + msg);
        if (Object.keys(obj.TouchArray).length == 0 && obj.touchtimer != null) { clearInterval(obj.touchtimer); obj.touchtimer = null; }
    }

    obj.SendMouseMsg = function (Action, event) {
        if (obj.State != 3) return;
        if (Action != null && obj.Canvas != null) {
            if (!event) { var event = window.event; }

            var ScaleFactorHeight = (obj.Canvas.canvas.height / obj.CanvasId.clientHeight);
            var ScaleFactorWidth = (obj.Canvas.canvas.width / obj.CanvasId.clientWidth);
            var Offsets = obj.GetPositionOfControl(obj.Canvas.canvas);
            var X = ((event.pageX - Offsets[0]) * ScaleFactorWidth);
            var Y = ((event.pageY - Offsets[1]) * ScaleFactorHeight);
            if (event.addx) { X += event.addx; }
            if (event.addy) { Y += event.addy; }

            if (X >= 0 && X <= obj.Canvas.canvas.width && Y >= 0 && Y <= obj.Canvas.canvas.height) {
                // Map the displayed (view-rotated) canvas position back to desktop coordinates,
                // like amt-desktop does; without this every rotated view sends wrong mouse positions.
                if (obj.rotation != 0) { var rotatedX = obj.crotX(X, Y); Y = obj.crotY(X, Y); X = rotatedX; }
                var Button = 0;
                var Delta = 0;
                if (Action == obj.KeyAction.UP || Action == obj.KeyAction.DOWN) {
                    if (event.which) { ((event.which == 1) ? (Button = obj.MouseButton.LEFT) : ((event.which == 2) ? (Button = obj.MouseButton.MIDDLE) : (Button = obj.MouseButton.RIGHT))); }
                    else if (typeof event.button == 'number') { ((event.button == 0) ? (Button = obj.MouseButton.LEFT) : ((event.button == 1) ? (Button = obj.MouseButton.MIDDLE) : (Button = obj.MouseButton.RIGHT))); }
                }
                else if (Action == obj.KeyAction.SCROLL) {
                    if (event.detail) { Delta = (-1 * (event.detail * 120)); } else if (event.wheelDelta) { Delta = (event.wheelDelta * 3); }
                }

                // Swap mouse buttons if needed
                if (obj.SwapMouse === true) {
                    if (Button == obj.MouseButton.LEFT) { Button = obj.MouseButton.RIGHT; }
                    else if (Button == obj.MouseButton.RIGHT) { Button = obj.MouseButton.LEFT; }
                }

                // Reverse mouse wheel if needed
                if (obj.ReverseMouseWheel) { Delta = -1 * Delta; }

                var MouseMsg = "";
                if (Action == obj.KeyAction.DBLCLICK) {
                    MouseMsg = String.fromCharCode(0x00, obj.InputType.MOUSE, 0x00, 0x0A, 0x00, 0x88, ((X / 256) & 0xFF), (X & 0xFF), ((Y / 256) & 0xFF), (Y & 0xFF));
                } else if (Action == obj.KeyAction.SCROLL) {
                    var deltaHigh = 0, deltaLow = 0;
                    if (Delta < 0) { deltaHigh = (255 - (Math.abs(Delta) >> 8)); deltaLow = (255 - (Math.abs(Delta) & 0xFF)); } else { deltaHigh = (Delta >> 8); deltaLow = (Delta & 0xFF); }
                    MouseMsg = String.fromCharCode(0x00, obj.InputType.MOUSE, 0x00, 0x0C, 0x00, 0x00, ((X / 256) & 0xFF), (X & 0xFF), ((Y / 256) & 0xFF), (Y & 0xFF), deltaHigh, deltaLow);
                } else {
                    MouseMsg = String.fromCharCode(0x00, obj.InputType.MOUSE, 0x00, 0x0A, 0x00, ((Action == obj.KeyAction.DOWN) ? Button : ((Button * 2) & 0xFF)), ((X / 256) & 0xFF), (X & 0xFF), ((Y / 256) & 0xFF), (Y & 0xFF));
                }

                if (obj.Action == obj.KeyAction.NONE) {
                    if (obj.Alternate == 0 || obj.ipad) { obj.send(MouseMsg); obj.Alternate = 1; } else { obj.Alternate = 0; }
                } else {
                    obj.send(MouseMsg);
                }
            }
        }
    }

    obj.GetDisplayNumbers = function () { obj.send(String.fromCharCode(0x00, 0x0B, 0x00, 0x04)); } // Get Terminal display
    obj.SetDisplay = function (number) { /*console.log('Set display', number);*/ obj.send(String.fromCharCode(0x00, 0x0C, 0x00, 0x06, number >> 8, number & 0xFF)); } // Set Terminal display
    obj.intToStr = function (x) { return String.fromCharCode((x >> 24) & 0xFF, (x >> 16) & 0xFF, (x >> 8) & 0xFF, x & 0xFF); }
    obj.shortToStr = function (x) { return String.fromCharCode((x >> 8) & 0xFF, x & 0xFF); }

    obj.onResize = function () {
        if (obj.ScreenWidth == 0 || obj.ScreenHeight == 0) return;
        if ((obj.Canvas.canvas.width == obj.ScreenWidth) && (obj.Canvas.canvas.height == obj.ScreenHeight)) return;
        presentFlush(); // the picture that is on the canvas is copied below
        if (obj.FirstDraw) {
            var cv = obj.Canvas.canvas, keep = null;
            if (obj.KeepPictureOnResize && (cv.width > 0) && (cv.height > 0)) { // copy the picture before the resize clears the canvas
                try {
                    if (obj.kcanvas == null) { obj.kcanvas = document.createElement('canvas'); }
                    obj.kcanvas.width = cv.width; obj.kcanvas.height = cv.height;
                    obj.kcanvas.getContext('2d').drawImage(cv, 0, 0);
                    keep = obj.kcanvas;
                } catch (ex) { keep = null; }
            }
            obj.KeepPictureOnResize = false;
            obj.Canvas.canvas.width = obj.ScreenWidth;
            obj.Canvas.canvas.height = obj.ScreenHeight;
            obj.Canvas.fillRect(0, 0, obj.ScreenWidth, obj.ScreenHeight);
            if (keep != null) { try { obj.Canvas.drawImage(keep, 0, 0, keep.width, keep.height, 0, 0, obj.ScreenWidth, obj.ScreenHeight); } catch (ex) { } }
            if (obj.onScreenSizeChange != null) { obj.onScreenSizeChange(obj, obj.ScreenWidth, obj.ScreenHeight, obj.CanvasId); }
        }
        obj.FirstDraw = false;
        if (obj.debugmode > 1) { console.log("onResize: " + obj.ScreenWidth + " x " + obj.ScreenHeight); }
    }

    obj.xxMouseInputGrab = false;
    obj.xxKeyInputGrab = false;
    obj.xxMouseMove = function (e) { if (obj.State == 3) obj.SendMouseMsg(obj.KeyAction.NONE, e); if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false; }
    obj.xxMouseUp = function (e) { if (obj.State == 3) obj.SendMouseMsg(obj.KeyAction.UP, e); if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false; }
    obj.xxMouseDown = function (e) { if (obj.State == 3) obj.SendMouseMsg(obj.KeyAction.DOWN, e); if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false; }
    obj.xxMouseDblClick = function (e) { if (obj.State == 3) obj.SendMouseMsg(obj.KeyAction.DBLCLICK, e); if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false; }
    obj.xxDOMMouseScroll = function (e) { if (obj.State == 3) { obj.SendMouseMsg(obj.KeyAction.SCROLL, e); return false; } return true; }
    obj.xxMouseWheel = function (e) { if (obj.State == 3) { obj.SendMouseMsg(obj.KeyAction.SCROLL, e); return false; } return true; }
    obj.xxKeyUp = function (e) {
        if ((e.key != 'Dead') && (obj.State == 3)) {
            if ((typeof e.key == 'string') && (e.key.length == 1) && (e.ctrlKey != true) && (e.altKey != true) && (obj.remoteKeyMap == false)) {
                obj.SendKeyUnicode(obj.KeyAction.UP, e.key.charCodeAt(0));
            } else {
                obj.SendKeyMsg(obj.KeyAction.UP, e);
            }
        }
        if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false;
    }
    obj.xxKeyDown = function (e) {
        if ((e.key != 'Dead') && (obj.State == 3)) {
            if (!((typeof e.key == 'string') && (e.key.length == 1) && (e.ctrlKey != true) && (e.altKey != true) && (obj.remoteKeyMap == false))) {
                obj.SendKeyMsg(obj.KeyAction.DOWN, e);
                if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false;
            }
        }
    }
    obj.xxKeyPress = function (e) {
        if ((e.key != 'Dead') && (obj.State == 3)) {
            if ((typeof e.key == 'string') && (e.key.length == 1) && (e.ctrlKey != true) && (e.altKey != true) && (obj.remoteKeyMap == false)) {
                obj.SendKeyUnicode(obj.KeyAction.DOWN, e.key.charCodeAt(0));
            } // else { obj.SendKeyMsg(obj.KeyAction.DOWN, e); }
        }
        if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false;
    }

    // Key handlers
    obj.handleKeys = function (e) {
        //console.log('keypress', e.code, e.key, e.keyCode, (e.key.length == 1) ? e.key.charCodeAt(0) : 0);
        if (obj.stopInput == true || desktop.State != 3) return false;
        return obj.xxKeyPress(e);
    }
    obj.handleKeyUp = function (e) {
        //console.log('keyup', e.code, e.key, e.keyCode, (e.key.length == 1)?e.key.charCodeAt(0):0);
        if (obj.stopInput == true || desktop.State != 3) return false;
        if (obj.firstUpKeys.length < 5) {
            obj.firstUpKeys.push(e.keyCode);
            if ((obj.firstUpKeys.length == 5)) { var j = obj.firstUpKeys.join(','); if ((j == '16,17,91,91,16') || (j == '16,17,18,91,92')) { obj.stopInput = true; } }
        }
        return obj.xxKeyUp(e);
    }
    obj.handleKeyDown = function (e) {
        //console.log('keydown', e.code, e.key, e.keyCode, (e.key.length == 1) ? e.key.charCodeAt(0) : 0);
        if (obj.stopInput == true || desktop.State != 3) return false;
        return obj.xxKeyDown(e);
    }

    // Release the CTRL, ALT, SHIFT keys if they are pressed.
    obj.handleReleaseKeys = function () {
        var p = JSON.parse(JSON.stringify(obj.pressedKeys)); // Clone the pressed array
        for (var i in p) { obj.SendKeyMsgKC(obj.KeyAction.UP, p[i]); } // Release all keys
    }

    // Mouse handlers
    obj.mousedblclick = function (e) { if (obj.stopInput == true) return false; return obj.xxMouseDblClick(e); }
    obj.mousedown = function (e) { if (obj.stopInput == true) return false; return obj.xxMouseDown(e); }
    obj.mouseup = function (e) { if (obj.stopInput == true) return false; return obj.xxMouseUp(e); }
    obj.mousemove = function (e) { if (obj.stopInput == true) return false; return obj.xxMouseMove(e); }
    obj.mousewheel = function (e) { if (obj.stopInput == true) return false; return obj.xxMouseWheel(e); }

    obj.xxMsTouchEvent = function (evt) {
        if (evt.originalEvent.pointerType == 4) return; // If this is a mouse pointer, ignore this event. Touch & pen are ok.
        if (evt.preventDefault) evt.preventDefault();
        if (evt.stopPropagation) evt.stopPropagation();
        if (evt.type == 'MSPointerDown' || evt.type == 'MSPointerMove' || evt.type == 'MSPointerUp') {
            var flags = 0;
            var id = evt.originalEvent.pointerId % 256;
            var X = evt.offsetX * (Canvas.canvas.width / obj.CanvasId.clientWidth);
            var Y = evt.offsetY * (Canvas.canvas.height / obj.CanvasId.clientHeight);

            if (evt.type == 'MSPointerDown') flags = 0x00010000 | 0x00000002 | 0x00000004; // POINTER_FLAG_DOWN
            else if (evt.type == 'MSPointerMove') {
                //if (obj.TouchArray[id] && MuchTheSame(obj.TouchArray[id].x, X) && MuchTheSame(obj.TouchArray[id].y, Y)) return;
                flags = 0x00020000 | 0x00000002 | 0x00000004; // POINTER_FLAG_UPDATE
            }
            else if (evt.type == 'MSPointerUp') flags = 0x00040000; // POINTER_FLAG_UP

            if (!obj.TouchArray[id]) obj.TouchArray[id] = { x: X, y : Y };
            obj.SendTouchMsg2(id, flags)
            if (evt.type == 'MSPointerUp') delete obj.TouchArray[id];
        } else {
            alert(evt.type);
        }
        return true;
    }

    obj.xxTouchStart = function (e) {
        if (obj.State != 3) return;
        if (e.preventDefault) e.preventDefault();
        if (obj.touchenabled == 0 || obj.touchenabled == 1) {
            if (e.originalEvent.touches.length > 1) return;
            var t = e.originalEvent.touches[0];
            e.which = 1;
            obj.LastX = e.pageX = t.pageX;
            obj.LastY = e.pageY = t.pageY;
            obj.SendMouseMsg(KeyAction.DOWN, e);
        } else {
            var Offsets = obj.GetPositionOfControl(Canvas.canvas);
            for (var i in e.originalEvent.changedTouches) {
                if (!e.originalEvent.changedTouches[i].identifier) continue;
                var id = e.originalEvent.changedTouches[i].identifier % 256;
                if (!obj.TouchArray[id]) { obj.TouchArray[id] = { x: (e.originalEvent.touches[i].pageX - Offsets[0]) * (Canvas.canvas.width / obj.CanvasId.clientWidth), y: (e.originalEvent.touches[i].pageY - Offsets[1]) * (Canvas.canvas.height / obj.CanvasId.clientHeight), f: 1 }; }
            }
            if (Object.keys(obj.TouchArray).length > 0 && touchtimer == null) { obj.touchtimer = setInterval(function () { obj.SendTouchMsg2(256, 0); }, 50); }
        }
    }

    obj.xxTouchMove = function (e) {
        if (obj.State != 3) return;
        if (e.preventDefault) e.preventDefault();
        if (obj.touchenabled == 0 || obj.touchenabled == 1) {
            if (e.originalEvent.touches.length > 1) return;
            var t = e.originalEvent.touches[0];
            e.which = 1;
            obj.LastX = e.pageX = t.pageX;
            obj.LastY = e.pageY = t.pageY;
            obj.SendMouseMsg(obj.KeyAction.NONE, e);
        } else {
            var Offsets = obj.GetPositionOfControl(Canvas.canvas);
            for (var i in e.originalEvent.changedTouches) {
                if (!e.originalEvent.changedTouches[i].identifier) continue;
                var id = e.originalEvent.changedTouches[i].identifier % 256;
                if (obj.TouchArray[id]) {
                    obj.TouchArray[id].x = (e.originalEvent.touches[i].pageX - Offsets[0]) * (obj.Canvas.canvas.width / obj.CanvasId.clientWidth);
                    obj.TouchArray[id].y = (e.originalEvent.touches[i].pageY - Offsets[1]) * (obj.Canvas.canvas.height / obj.CanvasId.clientHeight);
                }
            }
        }
    }

    obj.xxTouchEnd = function (e) {
        if (obj.State != 3) return;
        if (e.preventDefault) e.preventDefault();
        if (obj.touchenabled == 0 || obj.touchenabled == 1) {
            if (e.originalEvent.touches.length > 1) return;
            e.which = 1;
            e.pageX = LastX;
            e.pageY = LastY;
            obj.SendMouseMsg(KeyAction.UP, e);
        } else {
            for (var i in e.originalEvent.changedTouches) {
                if (!e.originalEvent.changedTouches[i].identifier) continue;
                var id = e.originalEvent.changedTouches[i].identifier % 256;
                if (obj.TouchArray[id]) obj.TouchArray[id].f = 2;
            }
        }
    }

    obj.GrabMouseInput = function () {
        if (obj.xxMouseInputGrab == true) return;
        var c = obj.CanvasId;
        c.onmousemove = obj.xxMouseMove;
        c.onmouseup = obj.xxMouseUp;
        c.onmousedown = obj.xxMouseDown;
        c.touchstart = obj.xxTouchStart;
        c.touchmove = obj.xxTouchMove;
        c.touchend = obj.xxTouchEnd;
        c.MSPointerDown = obj.xxMsTouchEvent;
        c.MSPointerMove = obj.xxMsTouchEvent;
        c.MSPointerUp = obj.xxMsTouchEvent;
        if (navigator.userAgent.match(/mozilla/i)) c.DOMMouseScroll = obj.xxDOMMouseScroll; else c.onmousewheel = obj.xxMouseWheel;
        obj.xxMouseInputGrab = true;
    }

    obj.UnGrabMouseInput = function () {
        if (obj.xxMouseInputGrab == false) return;
        var c = obj.CanvasId;
        c.onmousemove = null;
        c.onmouseup = null;
        c.onmousedown = null;
        c.touchstart = null;
        c.touchmove = null;
        c.touchend = null;
        c.MSPointerDown = null;
        c.MSPointerMove = null;
        c.MSPointerUp = null;
        if (navigator.userAgent.match(/mozilla/i)) c.DOMMouseScroll = null; else c.onmousewheel = null;
        obj.xxMouseInputGrab = false;
    }

    obj.GrabKeyInput = function () {
        if (obj.xxKeyInputGrab == true) return;
        // Save the current handlers so UnGrabKeyInput can restore them instead of
        // leaving the document without any keyboard handler. Only take ownership
        // of slots this instance does not already own.
        if (document.onkeydown !== obj.xxKeyDown) { obj._savedOnKeyDown = document.onkeydown; }
        if (document.onkeyup !== obj.xxKeyUp) { obj._savedOnKeyUp = document.onkeyup; }
        if (document.onkeypress !== obj.xxKeyPress) { obj._savedOnKeyPress = document.onkeypress; }
        document.onkeyup = obj.xxKeyUp;
        document.onkeydown = obj.xxKeyDown;
        document.onkeypress = obj.xxKeyPress;
        obj.xxKeyInputGrab = true;
    }

    obj.UnGrabKeyInput = function () {
        if (obj.xxKeyInputGrab == false) return;
        // Restore the handlers that were in place before GrabKeyInput, but only
        // for slots this instance still owns. A newer session may have taken over
        // the slots meanwhile (disconnect + reconnect of a grabbed session), in
        // which case leave the current handlers alone.
        if (document.onkeydown === obj.xxKeyDown) { document.onkeydown = obj._savedOnKeyDown || null; }
        if (document.onkeyup === obj.xxKeyUp) { document.onkeyup = obj._savedOnKeyUp || null; }
        if (document.onkeypress === obj.xxKeyPress) { document.onkeypress = obj._savedOnKeyPress || null; }
        obj._savedOnKeyDown = obj._savedOnKeyUp = obj._savedOnKeyPress = null;
        obj.xxKeyInputGrab = false;
    }

    obj.GetPositionOfControl = function (Control) {
        var Position = Array(2);
        Position[0] = Position[1] = 0;
        while (Control) { Position[0] += Control.offsetLeft; Position[1] += Control.offsetTop; Control = Control.offsetParent; }
        return Position;
    }

    obj.crotX = function (x, y) {
        if (obj.rotation == 0) return x;
        if (obj.rotation == 1) return y;
        if (obj.rotation == 2) return obj.Canvas.canvas.width - x;
        if (obj.rotation == 3) return obj.Canvas.canvas.height - y;
    }

    obj.crotY = function (x, y) {
        if (obj.rotation == 0) return y;
        if (obj.rotation == 1) return obj.Canvas.canvas.width - x;
        if (obj.rotation == 2) return obj.Canvas.canvas.height - y;
        if (obj.rotation == 3) return x;
    }

    obj.rotX = function (x, y) {
        if (obj.rotation == 0 || obj.rotation == 1) return x;
        if (obj.rotation == 2) return x - obj.Canvas.canvas.width;
        if (obj.rotation == 3) return x - obj.Canvas.canvas.height;
    }

    obj.rotY = function (x, y) {
        if (obj.rotation == 0 || obj.rotation == 3) return y;
        if (obj.rotation == 1) return y - obj.Canvas.canvas.width;
        if (obj.rotation == 2) return y - obj.Canvas.canvas.height;
    }

    obj.tcanvas = null;
    obj.setRotation = function (x) {
        while (x < 0) { x += 4; }
        var newrotation = x % 4;
        if (newrotation == obj.rotation) return true;
        presentFlush(); // the canvas is copied and turned below
        var rw = obj.Canvas.canvas.width;
        var rh = obj.Canvas.canvas.height;
        if (obj.rotation == 1 || obj.rotation == 3) { rw = obj.Canvas.canvas.height; rh = obj.Canvas.canvas.width; }

        // Copy the canvas, put it back in the correct direction
        if (obj.tcanvas == null) obj.tcanvas = document.createElement('canvas');
        var tcanvasctx = obj.tcanvas.getContext('2d');
        tcanvasctx.setTransform(1, 0, 0, 1, 0, 0);
        tcanvasctx.canvas.width = rw;
        tcanvasctx.canvas.height = rh;
        tcanvasctx.rotate((obj.rotation * -90) * Math.PI / 180);
        if (obj.rotation == 0) tcanvasctx.drawImage(obj.Canvas.canvas, 0, 0);
        if (obj.rotation == 1) tcanvasctx.drawImage(obj.Canvas.canvas, -obj.Canvas.canvas.width, 0);
        if (obj.rotation == 2) tcanvasctx.drawImage(obj.Canvas.canvas, -obj.Canvas.canvas.width, -obj.Canvas.canvas.height);
        if (obj.rotation == 3) tcanvasctx.drawImage(obj.Canvas.canvas, 0, -obj.Canvas.canvas.height);

        // Change the size and orientation and copy the canvas back into the rotation
        if (obj.rotation == 0 || obj.rotation == 2) { obj.Canvas.canvas.height = rw; obj.Canvas.canvas.width = rh; }
        if (obj.rotation == 1 || obj.rotation == 3) { obj.Canvas.canvas.height = rh; obj.Canvas.canvas.width = rw; }
        obj.Canvas.setTransform(1, 0, 0, 1, 0, 0);
        obj.Canvas.rotate((newrotation * 90) * Math.PI / 180);
        obj.rotation = newrotation;
        obj.Canvas.drawImage(obj.tcanvas, obj.rotX(0, 0), obj.rotY(0, 0));

        obj.ScreenWidth = obj.Canvas.canvas.width;
        obj.ScreenHeight = obj.Canvas.canvas.height;
        if (obj.onScreenSizeChange != null) { console.log('s4', obj.ScreenWidth, obj.ScreenHeight); obj.onScreenSizeChange(obj, obj.ScreenWidth, obj.ScreenHeight, obj.CanvasId); }
        return true;
    }

    obj.StartRecording = function () {
        if (obj.recordedData != null) return;
        presentFlush(); // the screen shot is the canvas as it is now
        // Take a screen shot and save it to file
        obj.CanvasId['toBlob'](function (blob) {
            var fileReader = new FileReader();
            fileReader.readAsArrayBuffer(blob);
            fileReader.onload = function (event) {
                // This is an ArrayBuffer, convert it to a string array
                var binary = '', bytes = new Uint8Array(fileReader.result), length = bytes.byteLength;
                for (var i = 0; i < length; i++) { binary += String.fromCharCode(bytes[i]); }
                obj.recordedData = [];
                obj.recordedStart = Date.now();
                obj.recordedSize = 0;
                obj.recordedData.push(recordingEntry(1, 0, JSON.stringify({ magic: 'MeshCentralRelaySession', ver: 1, time: new Date().toLocaleString(), protocol: 2 }))); // Metadata (nodeid: obj.nodeid)
                obj.recordedData.push(recordingEntry(2, 1, obj.shortToStr(7) + obj.shortToStr(8) + obj.shortToStr(obj.ScreenWidth) + obj.shortToStr(obj.ScreenHeight))); // Screen width and height
                // Save a screenshot
                var cmdlen = (8 + binary.length);
                if (cmdlen > 65000) {
                    // Jumbo Packet
                    obj.recordedData.push(recordingEntry(2, 1, obj.shortToStr(27) + obj.shortToStr(8) + obj.intToStr(cmdlen) + obj.shortToStr(3) + obj.shortToStr(0) + obj.shortToStr(0) + obj.shortToStr(0) + binary));
                } else {
                    // Normal packet
                    obj.recordedData.push(recordingEntry(2, 1, obj.shortToStr(3) + obj.shortToStr(cmdlen) + obj.shortToStr(0) + obj.shortToStr(0) + binary));
                }
                h264Repair(3); // the first video frame after the screenshot is an IDR picture (7.5)
            };
        });
    }

    obj.StopRecording = function () {
        if (obj.recordedData == null) return;
        var r = obj.recordedData;
        r.push(recordingEntry(3, 0, 'MeshCentralMCREC'));
        delete obj.recordedData;
        delete obj.recordedStart;
        delete obj.recordedSize;
        return r;
    }

    function recordingEntry(type, flags, data) {
        // Header: Type (2) + Flags (2) + Size(4) + Time(8)
        // Type (1 = Header, 2 = Network Data), Flags (1 = Binary, 2 = User), Size (4 bytes), Time (8 bytes)
        var now = Date.now();
        if (typeof data == 'number') {
            obj.recordedSize += data;
            return obj.shortToStr(type) + obj.shortToStr(flags) + obj.intToStr(data) + obj.intToStr(now >> 32) + obj.intToStr(now & 32);
        } else {
            obj.recordedSize += data.length;
            return obj.shortToStr(type) + obj.shortToStr(flags) + obj.intToStr(data.length) + obj.intToStr(now >> 32) + obj.intToStr(now & 32) + data;
        }
    }

    // Private method
    obj.MuchTheSame = function (a, b) { return (Math.abs(a - b) < 4); }
    obj.Debug = function (msg) { console.log(msg); }
    obj.getIEVersion = function () { var r = -1; if (navigator.appName == 'Microsoft Internet Explorer') { var ua = navigator.userAgent; var re = new RegExp("MSIE ([0-9]{1,}[.0-9]{0,})"); if (re.exec(ua) != null) r = parseFloat(RegExp.$1); } return r; }
    obj.haltEvent = function (e) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return false; }

    return obj;
}
