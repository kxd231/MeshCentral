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
        return { fps: (b.frames - a.frames) / dt, bytesPerSec: (b.bytes - a.bytes) / dt, seconds: dt, hidden: ((typeof document == 'object') && (document != null) && (document.visibilityState === 'hidden')) };
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
        obj.DropPendingOperations();
        clearOverflowRefresh();
    }

    obj.Stop = function () {
        obj.StatsEnable(false);
        obj.KvmAckReset();
        obj.DropPendingOperations();
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
    }

    // Apply the operation at the head of the queue if it is complete. Returns true if an operation was consumed.
    obj.DoPendingOperations = function () {
        var q = obj.PendingOperations;
        if ((q.length == 0) || (q[0].st == 0)) return false;
        var op = q.shift();
        if (op.t == 0) { kvmAckDone(op.ackTag); return true; } // an ACK marker: nothing to draw, not a tile
        obj.QueuedBytes -= op.bytes;
        if (op.st == 1) { obj.DecodedPixels -= op.px; }
        obj.TilesDrawn++;
        if (obj.onPreDrawImage != null) { try { obj.onPreDrawImage(); } catch (ex) { console.log(ex); } } // Notify that we are about to draw on the canvas.
        if ((op.st == 1) && (obj.Canvas != null) && (obj.State != 0)) {
            try {
                if (op.t == 2) { obj.Canvas.drawImage(op.img, obj.rotX(op.x, op.y), obj.rotY(op.x, op.y)); }
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
        var q = obj.PendingOperations, lastTag = null;
        for (var i = 0; i < q.length; i++) { q[i].dropped = true; releaseImage(q[i].img); q[i].img = null; if (q[i].ackTag) { lastTag = q[i].ackTag; } }
        q.length = 0;
        if (lastTag != null) { kvmAckDone(lastTag); } // dropped operations have left the queue too
        obj.QueuedBytes = 0;
        obj.DecodedPixels = 0;
        obj.tilesReceived = obj.TilesDrawn = obj.KillDraw = 0; // the counters describe the queue, which is empty now
        obj.Epoch++;
        if (drainTimer != null) { clearTimeout(drainTimer); drainTimer = null; }
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

    // Tag of the next counted frame, or null
    function kvmAckTag(cmd, fromWire) {
        if ((fromWire !== true) || !ka.active || ((cmd != 3) && (cmd != 7))) return null;
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
        q.push({ t: 0, st: 1, bytes: 0, px: 0, img: null, ackTag: tag, dropped: false });
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
        obj.ImageType = type;
        if (level) { obj.CompressionLevel = level; }
        if (scaling) { obj.ScalingLevel = scaling; }
        if (frametimer) { obj.FrameRateTimer = frametimer; }
        if ((budget != null) && (budget !== '') && !isNaN(parseInt(budget))) { obj.BandwidthBudget = Math.max(0, Math.min(65535, parseInt(budget))); }
        var withBudget = (obj.BandwidthBudget != null);
        function command(frameInterval) {
            return String.fromCharCode(0x00, 0x05, 0x00, withBudget ? 0x0C : 0x0A, type, obj.CompressionLevel) + obj.shortToStr(obj.ScalingLevel) + obj.shortToStr(frameInterval) + (withBudget ? obj.shortToStr(obj.BandwidthBudget) : '');
        }
        // The agent ignores a frame interval below 20 ms and keeps the previous one. For a shorter interval (60 fps = 16 ms) the same message is
        // sent twice: first with 20 ms, which every agent accepts (50 fps, what an agent that does not know shorter intervals ends up with),
        // then with the real interval, which an agent that allows it takes over. Both carry the same budget.
        var fr = parseInt(obj.FrameRateTimer);
        if (fr < 20) { obj.send(command(20)); }
        obj.send(command(obj.FrameRateTimer));
    }

    obj.SendRefresh = function () {
        obj.send(String.fromCharCode(0x00, 0x06, 0x00, 0x04));
    }

    obj.ProcessScreenMsg = function (width, height) {
        if (obj.debugmode > 0) { console.log('ScreenSize: ' + width + ' x ' + height); }
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
        obj.DropPendingOperations(); // Everything queued belongs to the old screen. The counters start again with the new one.
        obj.KillDraw = obj.tilesReceived = obj.TilesDrawn = 0;
        if (keepPicture) { obj.onResize(); } // the queue is empty, so resizing the canvas here cannot reorder drawing
        obj.SendCompressionLevel(obj.ImageType);
        obj.SendUnPause();
        obj.SendRemoteInputLock(2); // Query input lock state
        // No need to event the display size change now, it will be evented on first draw.
        if (obj.onScreenSizeChange != null) { obj.onScreenSizeChange(obj, obj.ScreenWidth, obj.ScreenHeight, obj.CanvasId); }
    }

    obj.ProcessBinaryCommand = function (cmd, cmdsize, view, fromWire) {
        var X, Y, op = null, ackTag = kvmAckTag(cmd, fromWire); // fromWire: set by the transport for frames received on its websocket
        if ((cmd == 3) || (cmd == 4) || (cmd == 7)) { X = (view[4] << 8) + view[5]; Y = (view[6] << 8) + view[7]; }
        if (obj.debugmode > 2) { console.log('CMD', cmd, cmdsize, X, Y); }

        // Record the command if needed
        if (obj.recordedData != null) {
            // Fix for view being too large for String.fromCharCode.apply()
            var chunkSize = 10000;
            let result = '';
            for (let i = 0; i < view.length; i += chunkSize) { result += String.fromCharCode.apply(null, view.slice(i, i + chunkSize)); }
            if (cmdsize > 65000) {
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
                obj.ProcessScreenMsg(X, Y);
                obj.SendKeyMsgKC(obj.KeyAction.UP, 16); // Shift
                obj.SendKeyMsgKC(obj.KeyAction.UP, 17); // Ctrl
                obj.SendKeyMsgKC(obj.KeyAction.UP, 18); // Alt
                obj.SendKeyMsgKC(obj.KeyAction.UP, 91); // Left-Windows
                obj.SendKeyMsgKC(obj.KeyAction.UP, 92); // Right-Windows
                obj.SendKeyMsgKC(obj.KeyAction.UP, 16); // Shift
                obj.send(String.fromCharCode(0x00, 0x0E, 0x00, 0x04));
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
