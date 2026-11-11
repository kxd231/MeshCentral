/**
* @description Web-RDP browser client (UI thread, legacy mode): websocket, input, clipboard, cursor, flow control
* @license Apache-2.0
*
* Speaks rdp/WIRE.md. Decoding and drawing happen in rdp-worker.js; this file only forwards binary frames to
* the worker (after the hard pending-byte check) and the worker's acks and gfx-acks to the server.
*
* Graphics follow settings.webRdp.gfx (options.gfxPolicy, the page variable webRdpGfx): 'off' requests 'legacy' exactly as
* before and refuses a GFX answer. 'on' (default of the server) probes the H.264 decoder in the worker and requests 'h264'
* (probe ok) or 'gfx' (set A only), unless the user chose legacy (options.gfxPreference() → 'auto' | 'legacy'); a GFX failure
* before the first desktop frame is retried ONCE in legacy mode (fallback.js), a later one is reported with a manual legacy
* reconnect (info.offerLegacy). 'dev' (also options.gfxDev === true) is 'on' without the automatic fallback plus the developer
* features: options.gfxMode forces 'legacy' | 'gfx' | 'h264', RemoteFX Surface Bits, and per-frame timings in window.__rdpStats.
* Browser objects (WebSocket, Worker, document, ...) are taken from `options.deps`, defaulting to the globals,
* so the logic is tested in Node with fakes.
*
* RdpClient.create(options) → client            general API, used by the page tab (agent-rdp-0.0.1.js)
* RdpClient.createStandalone(canvas) → { connect(...), disconnect() }   used by views/mstsc.handlebars
*
* States (same numbers as the old client): 0 disconnected, 1 connecting, 2 setup, 3 connected.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(root, require('./shared/limits.js'), require('./shared/constants.js'), require('./flow.js'), require('./messages.js'), require('./keyboard.js'), require('./fallback.js'));
    } else {
        root.RdpClient = root.RdpClient || {};
        const api = factory(root, root.RdpShared.limits, root.RdpShared.constants, root.RdpClient.flow, root.RdpClient.messages, root.RdpClient.keyboard, root.RdpClient.fallback);
        root.RdpClient.create = api.create;
        root.RdpClient.createStandalone = api.createStandalone;
    }
})((typeof self !== 'undefined') ? self : this, function (root, limits, constants, flow, messages, keyboard, fallback) {
    'use strict';

    const WS_OPEN = 1;
    const MOUSE_MOVE_INTERVAL_MS = 20;      // pointer moves are coalesced to at most 50 per second
    const RESIZE_DEBOUNCE_MS = 300;
    const CLIENT_ERROR_GRACE_MS = 3000;     // wait for the server's rdp-error after a client-error, then show our own
    const CLIPBOARD_POLL_MS = 1000;
    const PROBE_WAIT_MS = 8000;             // the worker's H.264 probe has its own timeout; this is the last resort
    const RETRY_DELAY_MS = 300;             // brief pause before the first legacy attempt
    const SLOT_RETRY_DELAY_MS = 2500;       // one admission retry, beyond the server's 2 s engine quit/kill grace
    const FIRST_FRAME_WAIT_MS = 15000;      // visible time allowed for a confirmed GFX session to render its first frame
    const CLOSE_WAIT_MS = 1000;             // dev: how long the worker may take to report its decoders after 'close'
    const STATS_MAX_FRAMES = 20000;         // dev: frame records kept in window.__rdpStats
    const MAX_CSS_CURSOR_DIM = 128;         // browsers ignore larger cursor images
    let styleCounter = 0;

    // Canvases whose control moved to a worker: they cannot be drawn on or transferred again
    const transferred = new WeakSet();

    function defaultDeps() {
        return {
            WebSocket: root.WebSocket, Worker: root.Worker, document: root.document, window: root, navigator: root.navigator,
            setTimeout: function (f, ms) { return root.setTimeout(f, ms); }, clearTimeout: function (h) { root.clearTimeout(h); },
            setInterval: function (f, ms) { return root.setInterval(f, ms); }, clearInterval: function (h) { root.clearInterval(h); },
            now: function () { return Date.now(); },
            storage: (function () { try { return root.localStorage || null; } catch (ex) { return null; } })()     // the memory of a failed AVC444 session
        };
    }

    function create(options) {
        options = options || {};
        const deps = Object.assign(defaultDeps(), options.deps || {});
        const cb = options.callbacks || {};
        const client = { state: 0, width: 0, height: 0, canvas: options.canvas };
        let ws = null, worker = null, guard = null, control = null, errorShown = false, clientErrorSent = false;
        let moveTimer = null, pendingMove = null, resizeTimer = null, clientErrorTimer = null, clipTimer = null;
        let needSync = true, lastClip = null, cursorActive = true, cursorCss = 'default';
        let epoch = 0;          // bumped on every init/reset sent to the worker; draws and pointers of older epochs are stale
        // 'off' | 'on' | 'dev'; options.gfxDev === true is the old spelling of 'dev'
        const gfxPolicy = fallback.normalizePolicy((options.gfxPolicy !== undefined) ? options.gfxPolicy : (options.gfxDev === true ? 'dev' : 'off'));
        const gfxDev = (gfxPolicy === 'dev');
        let fb = new fallback.GraphicsFallback(false), retryParams = null, retryTimer = null, suppressAvc444 = false;
        const h264Allowed = (options.h264 !== false);   // settings.webRdp.h264 (page variable webRdpH264); the server enforces it too
        let firstFrameTimer = null, firstFrameRemaining = null, firstFrameStarted = null, fallbackCause = null, slotRetryUsed = false;
        let requestedGfx = 'legacy', gfxSession = false, probeTimer = null, probeDone = null, stats = null;
        let rfxReported = false, capsDone = null;      // RemoteFX reported in infos (dev switch, legacy mode, worker probe); the answer of the worker's 'caps'
        let ctx2d = null, styleEl = null, inputAttached = false, lifecycleAttached = false, offscreenMode = false;
        const cursorCache = new Map();
        const pressed = new Set();
        const held = new keyboard.HeldKeys();
        const wheelAcc = new messages.WheelAccumulator();
        const styleId = 'rdp-cursor-' + (++styleCounter);

        function setState(s) { if (client.state === s) { return; } client.state = s; if (cb.onState) { cb.onState(s); } }
        function send(m) {
            if (m === null || ws === null || ws.readyState !== WS_OPEN) { return false; }
            ws.send(JSON.stringify(m));
            return true;
        }
        const live = function () { return client.state === 3; };

        // ---- teardown ---------------------------------------------------------------------------------
        function clearFirstFrameTimer() {
            if (firstFrameTimer !== null) { deps.clearTimeout(firstFrameTimer); firstFrameTimer = null; }
        }
        // Suppress Output may stop all frames while hidden; preserve the unused visible-time budget.
        function pauseFirstFrameTimer() {
            if (firstFrameTimer === null) { return; }
            firstFrameRemaining = Math.max(0, firstFrameRemaining - (deps.now() - firstFrameStarted));
            clearFirstFrameTimer();
        }
        function resumeFirstFrameTimer() {
            if (firstFrameRemaining === null || firstFrameTimer !== null || (deps.document && deps.document.hidden)) { return; }
            firstFrameStarted = deps.now();
            firstFrameTimer = deps.setTimeout(function () {
                firstFrameTimer = null; firstFrameRemaining = null;
                fail({ code: 'RDP_ERROR_TIMEOUT', hint: 'use-legacy', message: 'No graphics frame arrived before the deadline' });
                retryParams = null;
            }, firstFrameRemaining);
        }
        function cleanup() {
            clearFirstFrameTimer(); firstFrameRemaining = null;
            if (moveTimer !== null) { deps.clearTimeout(moveTimer); moveTimer = null; }
            if (resizeTimer !== null) { deps.clearTimeout(resizeTimer); resizeTimer = null; }
            if (clientErrorTimer !== null) { deps.clearTimeout(clientErrorTimer); clientErrorTimer = null; }
            if (clipTimer !== null) { deps.clearInterval(clipTimer); clipTimer = null; }
            if (control !== null) { control.clear(); }
            detachLifecycle();
            client.detachInput();
            if (probeTimer !== null) { deps.clearTimeout(probeTimer); probeTimer = null; }
            probeDone = null; capsDone = null; rfxReported = false;
            if (retryTimer !== null) { deps.clearTimeout(retryTimer); retryTimer = null; }
            retryParams = null;     // the connect parameters are held only while a retry is still possible
            if (worker !== null) { closeWorker(worker); worker = null; }
            if (ws !== null) {
                const w = ws; ws = null;
                w.onopen = w.onmessage = w.onclose = w.onerror = null;
                try { w.close(); } catch (ex) { }
            }
            if (styleEl !== null) { if (styleEl.parentNode) { styleEl.parentNode.removeChild(styleEl); } styleEl = null; }
            pressed.clear(); held.releaseAll(); cursorCache.clear();
            // The page may hand the element to another desktop type (Agent, Intel AMT) that needs getContext('2d'),
            // which fails on a canvas whose control moved to the worker: leave a fresh one behind at once
            if ((client.canvas != null) && transferred.has(client.canvas)) {
                replaceCanvas(false);
                if (client.canvas.removeAttribute) { client.canvas.removeAttribute('data-rdp-cursor'); }
            }
        }

        // Tells the worker to release its decoders, then ends it. In the dev mode the worker reports how many
        // VideoDecoders it created and closed first (window.__rdpStats.decoders), waiting at most CLOSE_WAIT_MS.
        function closeWorker(w) {
            try { w.postMessage({ t: 'close' }); } catch (ex) { }
            if (!gfxDev || !gfxSession) { try { w.terminate(); } catch (ex) { } return; }
            let timer = null;
            const end = function () { if (timer !== null) { deps.clearTimeout(timer); timer = null; } try { w.terminate(); } catch (ex) { } };
            w.onmessage = function (e) {
                const m = e.data;
                if ((m != null) && (m.t === 'closed')) { if (stats !== null) { stats.decoders = m.decoders; if (m.codecs != null) { stats.codecs = m.codecs; } stats.closedAt = Date.now(); } end(); }
            };
            timer = deps.setTimeout(end, CLOSE_WAIT_MS);
        }

        function ensureStats() {
            if (!gfxDev) { return null; }
            const w = deps.window;
            if ((w == null) || (typeof w !== 'object')) { return null; }
            stats = { frames: [], total: 0, dropped: 0, gfxAcks: 0, session: null, probe: null, decoders: null, codecs: {}, closedAt: 0, workerDropped: 0 };
            w.__rdpStats = stats;
            return stats;
        }

        // Swaps the canvas element for an unused clone (same attributes, id and position). Listeners added with
        // addEventListener are not cloned: this client re-attaches its own, the page adapter gets onCanvasReplaced.
        function replaceCanvas(reattachInput) {
            const old = client.canvas;
            const fresh = old.cloneNode(false);
            if (old.parentNode) { old.parentNode.replaceChild(fresh, old); }
            const wasAttached = inputAttached;
            if (wasAttached) { client.detachInput(); }
            client.canvas = fresh;
            if (wasAttached && reattachInput) { client.attachInput(); }
            if (cb.onCanvasReplaced) { cb.onCanvasReplaced(fresh); }
            return fresh;
        }

        // Ends the session with an error shown to the user (once)
        function fail(info) {
            if (errorShown) { return; }
            // Socket close precedes engine exit on the server: a single-session limit can still be occupied.
            // The same holds for the retry without AVC444 (suppressAvc444 is set only by that retry within one user connect)
            if ((fb.isFallback || suppressAvc444) && (fb.mode === null) && (retryParams !== null) && !slotRetryUsed && (info.code === 'RDP_ERROR_TOO_MANY_SESSIONS')) {
                slotRetryUsed = true;
                retryWithout(SLOT_RETRY_DELAY_MS, fb.isFallback);
                return;
            }
            // A GFX failure of a session that confirmed the AVC444 set D (10.4): remember it, so that the next connects of this browser offer B + A
            const usedAvc444 = (client.gfx != null) && (client.gfx.capsVersion === 0x000A0400);
            if (usedAvc444 && fallback.isGfxFailure(info)) { fallback.rememberAvc444Failure(deps.storage, deps.now()); }
            const verdict = fb.failure(info, usedAvc444);
            if ((verdict === 'retry-no-avc444') && (retryParams !== null)) {
                suppressAvc444 = true;
                retryWithout(RETRY_DELAY_MS, false); return;
            }
            if ((verdict === 'retry-legacy') && (retryParams !== null)) {
                fallbackCause = { id: 'legacy-fallback', code: info.code };
                if (['TRUNCATED', 'INVALID', 'LIMIT', 'UNSUPPORTED', 'INTERNAL'].indexOf(info.detail) >= 0) { fallbackCause.detail = info.detail; }
                retryLegacy(RETRY_DELAY_MS); return;
            }
            errorShown = true;
            if (verdict === 'offer-legacy') { info = Object.assign({}, info, { offerLegacy: true }); }
            cleanup();
            // The page drops its desktop object when it sees state 0 and its error handler needs it: report first.
            try { if (cb.onError) { cb.onError(info); } } finally { setState(0); }
        }

        function localError(message, code) { fail({ message: message, code: code || 'RDP_ERROR_INTERNAL', detail: undefined, hint: undefined }); }

        // One automatic retry in legacy mode with the parameters of the connect that just failed (fallback.js decided it is allowed).
        // The page sees 'connecting' again, not an error; the parameters are dropped as soon as they are used.
        function retryLegacy(delay) { retryWithout(delay, true); }
        function retryWithout(delay, legacy) {
            const p = retryParams;
            cleanup();                      // closes the socket and the worker, clears timers and retryParams
            errorShown = false;
            setState(1);
            retryTimer = deps.setTimeout(function () {
                retryTimer = null;
                if (client.state !== 1) { return; }
                beginAttempt(p, legacy);
            }, delay);
        }

        // Reports a decode or limit problem to the server; the server answers with rdp-error and closes
        function reportClientError(code) {
            if (clientErrorSent) { return; }
            clientErrorSent = true;
            send(messages.clientError(code));
            // Stop feeding the worker; if the server does not answer, show the problem ourselves
            clientErrorTimer = deps.setTimeout(function () {
                clientErrorTimer = null;
                localError('The browser could not process the image data (' + code + ')', 'RDP_ERROR_CLIENT_DECODE');
            }, CLIENT_ERROR_GRACE_MS);
        }

        // ---- connect ----------------------------------------------------------------------------------
        // p: { ip, domain, username, password, locale, screen: { width, height }, options: { savepass, useServerCreds, flags, workingDir, alternateShell } }
        client.connect = function (p) {
            if (client.state !== 0) { return false; }
            // One fallback budget per user-initiated connect; the automatic retry (beginAttempt with forceLegacy) never gets a new one
            fb = new fallback.GraphicsFallback(gfxPolicy === 'on' || options.gfxFallback === true);
            fallbackCause = null; slotRetryUsed = false; suppressAvc444 = false;
            return beginAttempt(p, false);
        };

        // One connection attempt. forceLegacy: the automatic retry after a GFX failure.
        function beginAttempt(p, forceLegacy) {
            errorShown = false; clientErrorSent = false; needSync = true; lastClip = null; gfxSession = false; client.gfx = null;
            setState(1);
            const canvas = client.canvas;
            const offscreen = (canvas != null) && (typeof canvas.transferControlToOffscreen === 'function');
            // 'off' (and an unknown policy) requests 'legacy' whatever the caller passed; the user's choice 'legacy' wins over 'on'
            const preference = fallback.normalizePreference(options.gfxPreference ? options.gfxPreference() : 'auto');
            let wanted = forceLegacy ? 'legacy' : fallback.wantedMode(gfxPolicy, preference, options.gfxMode);
            if (!h264Allowed && ((wanted === 'auto') || (wanted === 'h264'))) { wanted = 'gfx'; }     // no H.264 at all: lossless GFX, nothing to probe
            if (['legacy', 'gfx', 'h264', 'auto'].indexOf(wanted) < 0) { localError('Invalid graphics mode'); return false; }
            const build = function (gfx, h264, rfx, avc444) {
                return messages.buildInfos(Object.assign({}, p, { offscreenCanvas: offscreen, h264: h264, avc444: avc444 || null, rfx: (rfx === true), options: Object.assign({}, p.options, { gfx: gfx }) }));
            };
            const first = build((wanted === 'auto') ? 'gfx' : wanted, null);
            if (!first.ok) { localError(first.error); return false; }
            if (typeof deps.Worker !== 'function') { localError('This browser does not support Web Workers, which Web-RDP needs'); return false; }
            if (typeof deps.WebSocket !== 'function') { localError('This browser does not support WebSockets'); return false; }

            prepareCanvas(first.message[1].screen.width, first.message[1].screen.height);
            guard = new flow.PendingGuard();
            control = new flow.ControlQueue({ send: send, now: deps.now, setTimer: deps.setTimeout, clearTimer: deps.clearTimeout });
            try {
                worker = new deps.Worker(options.workerUrl || 'rdp/rdp-worker.js');
            } catch (ex) { localError('The Web-RDP worker could not be started'); return false; }
            const thisWorker = worker;
            worker.onmessage = function (e) { if (worker === thisWorker) { onWorkerMessage(e.data); } };
            worker.onerror = function () { if (worker === thisWorker) { localError('The Web-RDP worker failed'); } };
            ensureStats();

            const start = function (probe, rfx) {
                if ((worker !== thisWorker) || (client.state !== 1)) { return; }
                let mode = wanted;
                if (wanted === 'auto') { mode = ((probe != null) && probe.ok) ? 'h264' : 'gfx'; }
                requestedGfx = mode;
                fb.attempt(mode, forceLegacy);
                if ((fb.enabled && !forceLegacy && (mode !== 'legacy')) || (forceLegacy && !slotRetryUsed)) { retryParams = p; }
                if (stats !== null) { stats.probe = probe; stats.requested = mode; }
                rfxReported = ((mode === 'legacy') && (rfx === true));
                const withAvc444 = (mode === 'h264') && (probe != null) && !suppressAvc444 && !fallback.avc444Remembered(deps.storage, deps.now());
                const built = build(mode, (mode === 'h264') ? probe : null, rfxReported, withAvc444 ? probe.avc444 : null);
                if (!built.ok) { localError(built.error); return; }
                openSocket(built);
            };
            if ((wanted === 'auto') || (wanted === 'h264')) {
                // The probe decodes a built-in picture in the worker, where the real decoding will happen
                probeDone = function (r) { if (probeTimer !== null) { deps.clearTimeout(probeTimer); probeTimer = null; } probeDone = null; start(r); };
                probeTimer = deps.setTimeout(function () { probeTimer = null; if (probeDone !== null) { probeDone({ ok: false, decodeMs: 0 }); } }, PROBE_WAIT_MS);
                worker.postMessage({ t: 'probe', avc444: !suppressAvc444 && !fallback.avc444Remembered(deps.storage, deps.now()) });
            } else if (gfxDev && !forceLegacy && (wanted === 'legacy') && (options.rfx !== false)) {
                // Dev switch: legacy graphics with RemoteFX Surface Bits when the worker's decoder passes its self-test
                capsDone = function (r) { if (probeTimer !== null) { deps.clearTimeout(probeTimer); probeTimer = null; } capsDone = null; start(null, r.rfx === true); };
                probeTimer = deps.setTimeout(function () { probeTimer = null; if (capsDone !== null) { capsDone({ rfx: false }); } }, PROBE_WAIT_MS);
                worker.postMessage({ t: 'caps' });
            } else { start(null, false); }
            return true;
        }

        function openSocket(built) {
            const url = options.relayUrl || messages.relayUrl(deps.window.location, options.basePath);
            try { ws = new deps.WebSocket(url); } catch (ex) { localError('The connection to the server could not be opened'); return; }
            ws.binaryType = 'arraybuffer';
            const thisWs = ws;
            ws.onopen = function () {
                if (ws !== thisWs) { return; }
                setState(2);
                send(built.message);
                attachLifecycle();
                startClipboardPoll();
            };
            ws.onmessage = function (evt) { if (ws === thisWs) { onSocketMessage(evt.data); } };
            ws.onclose = function () {
                if (ws !== thisWs) { return; }
                ws = null;
                if (errorShown) { return; }
                // No rdp-close or rdp-error came first: the connection was lost (or never opened)
                cleanup(); setState(0);
                if (cb.onClose) { cb.onClose({ clean: false }); }
            };
            ws.onerror = function () { /* onclose follows */ };
        }

        client.disconnect = function () {
            if (client.state === 0) { return; }
            send(['disconnect']);
            cleanup();
            setState(0);
            if (cb.onClose) { cb.onClose({ clean: true }); }
        };

        // ---- server messages --------------------------------------------------------------------------
        function onSocketMessage(data) {
            if (typeof data === 'string') { onText(data); return; }
            if (!(data instanceof ArrayBuffer)) { return; }
            // Binary frames exist only after rdp-connect; before that the server broke the protocol
            if (!live()) { localError('The server sent data before the session started', 'RDP_ERROR_PROTOCOL'); return; }
            if (clientErrorSent) { return; }
            const r = guard.onFrame(data.byteLength);
            if (!r.ok) { reportClientError('LIMIT'); return; }
            worker.postMessage({ t: 'frame', buffer: data, received: r.total }, [data]);
        }

        function onText(text) {
            const m = messages.parseServerMessage(text);
            if (m === null) { return; } // unknown or malformed control messages are ignored
            switch (m.type) {
                case 'connect': onConnect(m); break;
                case 'resize': onDesktopResize(m); break;
                case 'clipboard': lastClip = m.text; if (cb.onClipboard) { cb.onClipboard(m.text); } break;
                case 'error': fail(messages.describeError(m.error)); break;
                case 'close': {
                    if (errorShown) { break; }
                    cleanup(); setState(0);
                    if (cb.onClose) { cb.onClose({ clean: true }); }
                    break;
                }
                case 'ping': send(['pong']); break;
                default: break;
            }
        }

        function onConnect(m) {
            if (client.state !== 2) { return; }
            if (m.wire !== constants.WIRE_VERSION) { localError('This page and the server use different Web-RDP protocol versions, reload the page', 'RDP_ERROR_PROTOCOL'); return; }
            // GFX only when this client asked for it (dev switch); a server that answers GFX to a legacy request broke the protocol
            if ((m.mode !== 'legacy') && !((m.mode === 'gfx') && (requestedGfx !== 'legacy'))) {
                send(messages.clientError('UNSUPPORTED'));
                localError('The server selected a graphics mode this client cannot show', 'RDP_ERROR_CAPABILITIES_REJECTED');
                return;
            }
            gfxSession = (m.mode === 'gfx');
            fb.connected(m.mode);
            if (!gfxSession) { retryParams = null; }     // a legacy session never falls back
            if (gfxSession) {
                firstFrameRemaining = FIRST_FRAME_WAIT_MS;
                resumeFirstFrameTimer();
            }
            client.mode = m.mode; client.gfx = m.gfx;
            client.fallback = fb.isFallback;
            if (stats !== null) { stats.session = { mode: m.mode, capsVersion: m.gfx ? m.gfx.capsVersion : null, flags: m.gfx ? m.gfx.flags : null, requested: requestedGfx, width: m.width, height: m.height }; }
            client.width = m.width; client.height = m.height;
            const off = setupCanvas(m.width, m.height);
            epoch++;
            worker.postMessage({ t: 'init', canvas: off, width: m.width, height: m.height, epoch: epoch, mode: m.mode, dev: gfxDev, rfx: (rfxReported && (m.mode === 'legacy')), avc444: (m.gfx != null) && ((m.gfx.capsVersion >>> 16) === 0x000A) }, off ? [off] : []);
            setState(3);
            if (cb.onConnect) { cb.onConnect({ width: m.width, height: m.height }); }
            if (cb.onSize) { cb.onSize(m.width, m.height); }
            if (fb.isFallback && cb.onNotice) { cb.onNotice(fallbackCause); }
            if (deps.document && deps.document.hidden) { control.set('visibility', messages.visibility(false)); }
        }

        // gfx: in-band ResetGraphics (the worker asked for it); the server's pointer cache is not touched by it, and the
        // worker is told with 'output' instead of 'reset' (its GFX state survives)
        function onDesktopResize(m, gfx) {
            if (!live()) { return; }
            client.width = m.width; client.height = m.height;
            epoch++;
            let off = null;
            if (offscreenMode && client.canvas) {
                // The placeholder size of a transferred canvas follows neither the worker nor the page, and the page
                // reads it (deskAdjust). A new element of the new size, with a new OffscreenCanvas for the worker.
                const canvas = replaceCanvas(true);
                canvas.width = m.width; canvas.height = m.height;
                // No 2D fallback here: the worker still draws on the old OffscreenCanvas, the screen would stay blank
                try { off = canvas.transferControlToOffscreen(); transferred.add(canvas); } catch (ex) { reportClientError('INTERNAL'); return; }
            } else if (client.canvas) { client.canvas.width = m.width; client.canvas.height = m.height; }
            worker.postMessage({ t: (gfx === true) ? 'output' : 'reset', canvas: off, width: m.width, height: m.height, epoch: epoch }, off ? [off] : []);
            if (cb.onSize) { cb.onSize(m.width, m.height); }
        }

        // A canvas whose control moved to a worker in an earlier session cannot be used again: swap in a
        // fresh element with the same attributes. The size is the requested one until the server answers.
        function prepareCanvas(w, h) {
            let canvas = client.canvas;
            if (canvas == null) { return; }
            if (transferred.has(canvas)) { canvas = replaceCanvas(true); } // normally done by cleanup() already
            canvas.width = w; canvas.height = h;
        }

        // Gives the worker the canvas (transferred) or prepares the 2D fallback. → OffscreenCanvas | null
        function setupCanvas(w, h) {
            const canvas = client.canvas;
            if (canvas == null) { return null; }
            if (transferred.has(canvas)) { throw new Error('canvas already transferred'); } // prepareCanvas ran at connect
            canvas.width = w; canvas.height = h; // the size before the transfer; the worker keeps it current afterwards
            canvas.setAttribute('data-rdp-cursor', styleId);
            offscreenMode = false; ctx2d = null;
            if (typeof canvas.transferControlToOffscreen === 'function') {
                try {
                    const off = canvas.transferControlToOffscreen();
                    transferred.add(canvas);
                    offscreenMode = true;
                    return off;
                } catch (ex) { /* the canvas already has a context: draw on the UI thread */ }
            }
            ctx2d = canvas.getContext('2d');
            return null;
        }

        // ---- worker messages --------------------------------------------------------------------------
        function onWorkerMessage(m) {
            if ((m == null) || (typeof m !== 'object')) { return; }
            switch (m.t) {
                case 'ack': {
                    if (clientErrorSent) { break; }
                    if (Number.isSafeInteger(m.total) && (m.total > guard.received)) { reportClientError('INTERNAL'); break; }
                    const total = guard.onAck(m.total);
                    if (total !== null) { send(messages.ack(total)); }
                    break;
                }
                case 'client-error':
                    if ((stats !== null) && (typeof m.message === 'string')) { stats.lastError = { code: m.code, message: m.message.substring(0, 200) }; }
                    reportClientError(messages.CLIENT_ERROR_CODES.indexOf(m.code) >= 0 ? m.code : 'INTERNAL'); break;
                case 'gfx-ack': {
                    // Forwarded in the order the worker produced it: before the ack that covers its END_FRAME
                    if (clientErrorSent || !gfxSession) { break; }
                    const g = messages.gfxAck(m.frameId, m.queueDepth);
                    if (g === null) { reportClientError('INTERNAL'); break; }
                    send(g);
                    clearFirstFrameTimer(); firstFrameRemaining = null; fb.firstFrame(); retryParams = null;       // the desktop was shown: no automatic retry from here on
                    if (stats !== null) { stats.gfxAcks++; }
                    break;
                }
                case 'desktop': {
                    if (!gfxSession || !live()) { break; }
                    if (!Number.isSafeInteger(m.width) || !Number.isSafeInteger(m.height) || (m.width < 1) || (m.height < 1) ||
                        (m.width > limits.DESKTOP_MAX_DIM) || (m.height > limits.DESKTOP_MAX_DIM) || ((m.width * m.height) > limits.SURFACES_MAX_PIXELS)) { reportClientError('INVALID'); break; }
                    onDesktopResize({ width: m.width, height: m.height }, true);
                    break;
                }
                case 'caps-result': if (capsDone !== null) { capsDone({ rfx: (m.rfx === true) }); } break;
                case 'probe-result': if (probeDone !== null) { probeDone({ ok: (m.ok === true), decodeMs: Number.isFinite(m.decodeMs) ? m.decodeMs : 0, avc444: (m.avc444 != null) ? { ok: (m.avc444.ok === true), decodeMs: Number.isFinite(m.avc444.decodeMs) ? m.avc444.decodeMs : 0 } : null }); } break;
                case 'stats': onStats(m); break;
                case 'draw': drawFallback(m); break;
                case 'pointer': if (gfxSession || (m.epoch === epoch)) { onPointer(m); } break;
                default: break;
            }
        }

        // Dev only: frame timing records of the worker (absolute ms: performance.timeOrigin + now)
        function onStats(m) {
            if ((stats === null) || !Array.isArray(m.frames)) { return; }
            for (const f of m.frames) {
                stats.total++;
                if (stats.frames.length < STATS_MAX_FRAMES) { stats.frames.push(f); } else { stats.dropped++; }
                if (typeof stats.onFrame === 'function') { try { stats.onFrame(f); } catch (ex) { /* a listener must not break the session */ } }
            }
            if (Number.isFinite(m.dropped)) { stats.workerDropped = m.dropped; }
            if (m.decoders != null) { stats.decoders = m.decoders; }
            if (m.codecs != null) { stats.codecs = m.codecs; }
            if (m.surface != null) { stats.surface = m.surface; }
            if (typeof m.simd === 'boolean') { stats.simd = m.simd; }
        }

        function drawFallback(m) {
            if (!(m.buffer instanceof ArrayBuffer)) { return; }
            const bytes = m.buffer.byteLength;
            drawRect(m);
            // Confirm even a dropped rectangle: the worker counts un-confirmed bytes and pauses at its limit
            if (worker !== null) { worker.postMessage({ t: 'drawn', bytes: bytes, epoch: m.epoch }); }
        }

        function drawRect(m) {
            if (!live() || (ctx2d === null) || (m.epoch !== epoch)) { return; } // epoch: a rectangle from before an rdp-resize
            if (!Number.isSafeInteger(m.x) || !Number.isSafeInteger(m.y) || !Number.isSafeInteger(m.width) || !Number.isSafeInteger(m.height)) { return; }
            if ((m.x < 0) || (m.y < 0) || (m.width < 1) || (m.height < 1) || (m.x + m.width > client.width) || (m.y + m.height > client.height)) { return; }
            if (m.buffer.byteLength !== m.width * m.height * 4) { return; }
            const ImageDataCtor = deps.ImageData || root.ImageData;
            ctx2d.putImageData(new ImageDataCtor(new Uint8ClampedArray(m.buffer), m.width, m.height), m.x, m.y);
        }

        // ---- cursor -----------------------------------------------------------------------------------
        function applyCursor() {
            const doc = deps.document;
            if (!doc || !client.canvas) { return; }
            if (styleEl === null) {
                styleEl = doc.createElement('style');
                (doc.head || doc.documentElement).appendChild(styleEl);
            }
            // A rule in a stylesheet, not an inline style: the page resets canvas.style.cursor on every mouse move
            styleEl.textContent = 'canvas[data-rdp-cursor="' + styleId + '"]{cursor:' + (cursorActive ? cursorCss : 'default') + '}';
        }

        function cursorFromShape(m) {
            if ((m.width > MAX_CSS_CURSOR_DIM) || (m.height > MAX_CSS_CURSOR_DIM) || !(m.rgba instanceof ArrayBuffer)) { return 'default'; }
            if (!Number.isSafeInteger(m.hotX) || !Number.isSafeInteger(m.hotY) || (m.hotX < 0) || (m.hotY < 0)) { return 'default'; } // goes into a CSS value
            const doc = deps.document;
            try {
                const c = doc.createElement('canvas');
                c.width = m.width; c.height = m.height;
                const ImageDataCtor = deps.ImageData || root.ImageData;
                c.getContext('2d').putImageData(new ImageDataCtor(new Uint8ClampedArray(m.rgba), m.width, m.height), 0, 0);
                return 'url("' + c.toDataURL('image/png') + '") ' + m.hotX + ' ' + m.hotY + ', auto';
            } catch (ex) { return 'default'; }
        }

        function onPointer(m) {
            if (!live()) { return; }
            switch (m.kind) {
                case 'hidden': cursorCss = 'none'; break;
                case 'default': cursorCss = 'default'; break;
                case 'set': {
                    cursorCss = cursorFromShape(m);
                    if (Number.isSafeInteger(m.cacheIndex) && (m.cacheIndex !== constants.WIRE_POINTER_NO_CACHE)) { cursorCache.set(m.cacheIndex, cursorCss); }
                    break;
                }
                case 'cached': cursorCss = cursorCache.has(m.cacheIndex) ? cursorCache.get(m.cacheIndex) : 'default'; break;
                default: return;
            }
            applyCursor();
        }

        client.setCursorActive = function (active) { cursorActive = (active === true); applyCursor(); };

        // ---- input ------------------------------------------------------------------------------------
        function syncLocks(e) {
            if (!needSync || !live()) { return; }
            needSync = false;
            send(messages.sync(keyboard.lockBits(e)));
        }

        function point(e) {
            const p = messages.mousePoint(e.clientX, e.clientY, client.canvas.getBoundingClientRect(), client.width, client.height);
            client.lastX = p.x; client.lastY = p.y;
            return p;
        }

        function flushMove() {
            if (moveTimer !== null) { deps.clearTimeout(moveTimer); moveTimer = null; }
            if (pendingMove !== null) {
                const p = pendingMove; pendingMove = null;
                send(messages.mouse(p.x, p.y, 0, false, client.width, client.height));
            }
        }

        client.mouseMove = function (e) {
            if (!live()) { return false; }
            syncLocks(e);
            pendingMove = point(e);
            if (moveTimer === null) { moveTimer = deps.setTimeout(function () { moveTimer = null; flushMove(); }, MOUSE_MOVE_INTERVAL_MS); }
            if (e.preventDefault) { e.preventDefault(); }
            return false;
        };

        client.mouseDown = function (e) {
            if (!live()) { return false; }
            syncLocks(e);
            const b = messages.mouseButton(e.button, options.swapMouse ? options.swapMouse() : false);
            if (b === 0) { return false; }
            flushMove();
            const p = point(e);
            if (send(messages.mouse(p.x, p.y, b, true, client.width, client.height))) { pressed.add(b); }
            if (e.preventDefault) { e.preventDefault(); }
            return false;
        };

        client.mouseUp = function (e) {
            if (!live()) { return false; }
            const b = messages.mouseButton(e.button, options.swapMouse ? options.swapMouse() : false);
            if ((b === 0) || !pressed.has(b)) { return false; } // the press did not start here
            flushMove();
            pressed.delete(b);
            const p = point(e);
            send(messages.mouse(p.x, p.y, b, false, client.width, client.height));
            if (e.preventDefault) { e.preventDefault(); }
            return false;
        };

        client.wheel = function (e) {
            if (!live()) { return false; }
            const n = messages.normalizeWheel(e);
            const steps = wheelAcc.add(n.dx, n.dy, n.mode, options.reverseWheel ? options.reverseWheel() : false);
            if (steps.length > 0) {
                flushMove();
                const p = point(e);
                for (const s of steps) { send(messages.wheel(p.x, p.y, s.delta, s.horizontal, client.width, client.height)); }
            }
            if (e.preventDefault) { e.preventDefault(); }
            return false;
        };

        function sendScancode(code, down) {
            if (send(messages.scancode(code, down))) { if (down) { held.down(code); } else { held.up(code); } }
        }

        client.keyDown = function (e) {
            if (!live()) { return false; }
            const input = keyboard.eventToInput(e, true);
            if (input === null) { return false; }
            syncLocks(e);
            if (input.kind === 'scancode') { sendScancode(input.code, true); }
            else { for (const u of input.units) { send(messages.unicode(u, true)); send(messages.unicode(u, false)); } }
            if (e.preventDefault) { e.preventDefault(); }
            return false;
        };

        client.keyUp = function (e) {
            if (!live()) { return false; }
            const input = keyboard.eventToInput(e, false);
            if (input === null) { return false; }
            if (input.kind === 'scancode') { sendScancode(input.code, false); }
            if (e.preventDefault) { e.preventDefault(); }
            return false;
        };

        // Releases every key and button the remote side thinks is down (window blur, hidden tab)
        client.releaseKeys = function () {
            if (!live()) { return; }
            for (const code of held.releaseAll()) { send(messages.scancode(code, false)); }
            if (pressed.size > 0) {
                const x = Math.max(0, Math.min(client.width - 1, client.lastX | 0)), y = Math.max(0, Math.min(client.height - 1, client.lastY | 0));
                for (const b of pressed) { send(messages.mouse(x, y, b, false, client.width, client.height)); }
                pressed.clear();
            }
        };

        // Ctrl+Alt+Del
        client.sendCad = function () {
            if (!live()) { return; }
            const seq = [0x1D, 0x38, 0xE053];
            for (const c of seq) { send(messages.scancode(c, true)); }
            for (let i = seq.length - 1; i >= 0; i--) { send(messages.scancode(seq[i], false)); }
        };

        // Types text on the remote side (paste as typing). → false when the text is not acceptable
        client.typeText = function (text) {
            const m = messages.utype(text);
            return live() && send(m);
        };

        // Key by Windows virtual-key code, for the page's key toolbar. down: true/false
        client.sendKeyCode = function (down, keyCode) {
            if (!live()) { return false; }
            const code = keyboard.scancodeFromKeyCode(keyCode);
            if (code === undefined) { return false; }
            sendScancode(code, down);
            return true;
        };

        // ---- clipboard --------------------------------------------------------------------------------
        client.setClipboard = function (text) {
            const m = messages.clipboard(text);
            if (!live() || (m === null)) { return false; }
            lastClip = m[1];
            control.set('clipboard', m);
            return true;
        };
        client.getClipboard = function () { return lastClip; };

        function startClipboardPoll() {
            if (!options.clipboardPoll || clipTimer !== null) { return; }
            const nav = deps.navigator;
            // Firefox shows a paste prompt for every readText call
            if (!nav || !nav.clipboard || (typeof nav.clipboard.readText !== 'function') || /firefox/i.test(nav.userAgent || '')) { return; }
            let first = true;
            clipTimer = deps.setInterval(function () {
                if (!live()) { return; }
                nav.clipboard.readText().then(function (text) {
                    if (typeof text !== 'string') { return; }
                    if (first) { first = false; if (lastClip === null) { lastClip = text; } return; } // what is already there is not sent
                    if (text !== lastClip) { client.setClipboard(text); }
                }).catch(function () { });
            }, CLIPBOARD_POLL_MS);
        }

        // ---- resize -----------------------------------------------------------------------------------
        // Asks the server for a new desktop size (debounced). Only when options.allowResize says so.
        client.requestResize = function (width, height) {
            if (!live() || !(options.allowResize ? options.allowResize() : false)) { return; }
            const m = messages.resize(width, height);
            if ((m === null) || ((m[1] === client.width) && (m[2] === client.height))) { return; }
            if (resizeTimer !== null) { deps.clearTimeout(resizeTimer); }
            resizeTimer = deps.setTimeout(function () { resizeTimer = null; if (live()) { control.set('resize', m); } }, RESIZE_DEBOUNCE_MS);
        };

        // ---- listeners --------------------------------------------------------------------------------
        const onWinBlur = function () { client.releaseKeys(); };
        const onWinFocus = function () { needSync = true; };
        const onWinMouseUp = function (e) { client.mouseUp(e); };
        const onVisibility = function () {
            if (!live()) { return; }
            if (deps.document.hidden) { pauseFirstFrameTimer(); } else { resumeFirstFrameTimer(); }
            control.set('visibility', messages.visibility(!deps.document.hidden));
            if (deps.document.hidden) { client.releaseKeys(); }
        };

        function attachLifecycle() {
            if (lifecycleAttached || !deps.window || !deps.window.addEventListener) { return; }
            lifecycleAttached = true;
            deps.window.addEventListener('blur', onWinBlur);
            deps.window.addEventListener('focus', onWinFocus);
            deps.window.addEventListener('mouseup', onWinMouseUp);
            if (deps.document) { deps.document.addEventListener('visibilitychange', onVisibility); }
        }
        function detachLifecycle() {
            if (!lifecycleAttached) { return; }
            lifecycleAttached = false;
            deps.window.removeEventListener('blur', onWinBlur);
            deps.window.removeEventListener('focus', onWinFocus);
            deps.window.removeEventListener('mouseup', onWinMouseUp);
            if (deps.document) { deps.document.removeEventListener('visibilitychange', onVisibility); }
        }

        // Mouse and keyboard listeners for a page that does not route the events itself (standalone page)
        const handlers = {
            mousemove: function (e) { return client.mouseMove(e); },
            mousedown: function (e) { return client.mouseDown(e); },
            mouseup: function (e) { return client.mouseUp(e); },
            wheel: function (e) { return client.wheel(e); },
            contextmenu: function (e) { if (live() && e.preventDefault) { e.preventDefault(); } return false; }
        };
        const onKeyDown = function (e) { return client.keyDown(e); };
        const onKeyUp = function (e) { return client.keyUp(e); };

        client.attachInput = function () {
            if (inputAttached || !client.canvas) { return; }
            inputAttached = true;
            for (const k of Object.keys(handlers)) { client.canvas.addEventListener(k, handlers[k], (k === 'wheel') ? { passive: false } : false); }
            deps.window.addEventListener('keydown', onKeyDown);
            deps.window.addEventListener('keyup', onKeyUp);
        };
        client.detachInput = function () {
            if (!inputAttached) { return; }
            inputAttached = false;
            if (client.canvas) { for (const k of Object.keys(handlers)) { client.canvas.removeEventListener(k, handlers[k]); } }
            deps.window.removeEventListener('keydown', onKeyDown);
            deps.window.removeEventListener('keyup', onKeyUp);
        };

        client.lastX = 0; client.lastY = 0;
        return client;
    }

    // Dev only: ?gfx=legacy|gfx|h264 on the standalone page forces the requested graphics mode (ignored unless settings.webRdp.gfx = "dev")
    function gfxModeFromQuery(win) {
        const m = /[?&]gfx=(legacy|gfx|h264)(?:&|$)/.exec((win.location && win.location.search) || '');
        return m ? m[1] : undefined;
    }

    // Page wrapper for views/mstsc.handlebars: same call shape as the old MstscClient
    //   connect(ip, domain, username, password, options, next)   next(null) or next({ code, detail, text })
    function createStandalone(canvas, opts) {
        opts = opts || {};
        const win = (opts.deps && opts.deps.window) || root;
        let current = canvas, nextCb = null, finished = false, preference = 'auto';
        let resizeListener = null;
        const done = function (err) { if (finished) { return; } finished = true; if (resizeListener) { win.removeEventListener('resize', resizeListener); resizeListener = null; } if (nextCb) { nextCb(err); } };
        const client = create({
            canvas: canvas,
            basePath: messages.basePathOfPage(win.location.pathname),
            workerUrl: opts.workerUrl,
            allowResize: function () { return true; },
            clipboardPoll: true,
            gfxPolicy: (opts.gfxPolicy !== undefined) ? opts.gfxPolicy : ((opts.gfxDev !== undefined) ? ((opts.gfxDev === true) ? 'dev' : 'off') : win.webRdpGfx),
            gfxPreference: function () { return preference; },
            h264: (opts.h264 !== undefined) ? opts.h264 : (win.webRdpH264 !== 'off'),
            gfxMode: gfxModeFromQuery(win),
            rfx: /[?&]rfx=off(?:&|$)/.test((win.location && win.location.search) || '') ? false : undefined,   // dev: ?rfx=off keeps plain bitmaps in legacy mode
            deps: opts.deps,
            callbacks: {
                onCanvasReplaced: function (c) { current = c; },
                onClipboard: function (text) {
                    if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) { win.navigator.clipboard.writeText(text).catch(function () { }); }
                },
                onNotice: function (n) { if (opts.onNotice) { opts.onNotice(n); } },
                onError: function (info) { done({ code: info.code, detail: info.detail, text: info.message, offerLegacy: info.offerLegacy === true }); },
                onClose: function (info) { done((info && info.clean === false) ? { code: 'RDP_ERROR_CONNECTION_LOST', text: 'The connection to the server was closed' } : null); },
                onConnect: function () { client.attachInput(); }
            }
        });
        return {
            get canvas() { return current; },
            connect: function (ip, domain, username, password, options, next) {
                if (client.state !== 0) { return; } // a session is running: keep its callback and listener
                finished = false; nextCb = next;
                const o = options || {};
                preference = fallback.normalizePreference(o.graphics);       // one-shot choice of the page: Auto, Lossless or Classic bitmaps
                const resizeFn = function () { client.requestResize(win.innerWidth, win.innerHeight); };
                resizeListener = resizeFn;
                win.addEventListener('resize', resizeFn);
                const started = client.connect({
                    ip: ip, domain: domain, username: username, password: password, locale: win.navigator.language,
                    screen: { width: win.innerWidth, height: win.innerHeight },
                    options: { savepass: o.savepass, useServerCreds: o.useServerCreds, flags: o.flags }
                });
                // A refused start already reported through onError (done removes the listener); make sure nothing stays behind
                if (!started && (resizeListener === resizeFn)) { win.removeEventListener('resize', resizeFn); resizeListener = null; }
            },
            disconnect: function () { client.disconnect(); }
        };
    }

    return Object.freeze({ create: create, createStandalone: createStandalone });
});
