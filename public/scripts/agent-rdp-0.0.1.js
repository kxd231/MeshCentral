/** 
* @description RDP Remote Desktop
* @author Ylian Saint-Hilaire
* @version v0.0.1
*/

// Construct the desktop adapter on top of public/rdp/rdp-client.js.
var CreateRDPDesktop = function (canvasid, domainUrl) {
    var obj = {}
    obj.m = { KeyAction: { 'NONE': 0, 'DOWN': 1, 'UP': 2, 'SCROLL': 3, 'EXUP': 4, 'EXDOWN': 5, 'DBLCLICK': 6 }, rotation: 0, AutoResize: false };
    obj.State = 0;
    obj.CanvasId = (typeof canvasid === 'string') ? Q(canvasid) : canvasid;
    obj.canvas = obj.CanvasId;
    obj.ScreenWidth = obj.width = 1280;
    obj.ScreenHeight = obj.height = 1024;
    obj.m.onClipboardChanged = null;
    obj.onConsoleMessageChange = null;
    var resizeObserver = null;

    var client = RdpClient.create({
        canvas: obj.CanvasId,
        basePath: domainUrl,
        gfxPolicy: ((typeof webRdpGfx !== 'undefined') ? webRdpGfx : ''), // settings.webRdp.gfx: 'on' (default of the server) | 'off' | 'dev'
        gfxPreference: function () { return ((obj.m.Graphics === 'legacy') || (obj.m.Graphics === 'lossless')) ? obj.m.Graphics : 'auto'; }, // the user's choice in the RDP options (Auto / Lossless / Classic bitmaps)
        h264: (typeof webRdpH264 === 'undefined') || (webRdpH264 !== 'off'), // settings.webRdp.h264 (page variable)
        swapMouse: function () { return (obj.m.SwapMouse === true); },
        reverseWheel: function () { return (obj.m.ReverseMouseWheel === true); },
        allowResize: function () { return (obj.m.AutoResize === true); },
        callbacks: {
            onState: function (state) { changeState(state); },
            onSize: function (w, h) {
                obj.ScreenWidth = obj.width = w;
                obj.ScreenHeight = obj.height = h;
                if (obj.m.onScreenSizeChange != null) { obj.m.onScreenSizeChange(obj, w, h, obj.CanvasId); }
            },
            onConnect: function () { watchContainerSize(); },
            onNotice: function (n) {
                // The automatic legacy fallback: a short note, no error
                obj.consoleMessageTimeout = 15; // Seconds
                obj.consoleMessage = null;
                obj.consoleMessageId = n.id;
                obj.consoleMessageArgs = [n.code];
                delete obj.consoleAction;
                if (obj.onConsoleMessageChange) { obj.onConsoleMessageChange(); }
            },
            onCanvasReplaced: function (c) {
                obj.CanvasId = obj.canvas = c;
                // The clone has none of the listeners the page added with addEventListener (setupDesktop): wheel
                if (typeof dmousewheel === 'function') {
                    c.addEventListener('DOMMouseScroll', function (e) { return dmousewheel(e); });
                    c.addEventListener('mousewheel', function (e) { return dmousewheel(e); });
                }
            },
            onClipboard: function (text) { obj.lastClipboardContent = text; if (obj.m.onClipboardChanged) { obj.m.onClipboardChanged(text); } },
            onError: function (info) {
                obj.consoleMessageTimeout = info.offerLegacy ? 60 : 10; // Seconds
                obj.consoleMessage = (typeof webRdpErrorText === 'function') ? webRdpErrorText(info) : info.message; // Plain text, the page escapes it
                obj.consoleMessageId = null;
                delete obj.consoleMessageArgs;
                // GFX failed after the desktop was shown: the page offers a reconnect in legacy mode (no automatic retry)
                // (the page connects again with the credentials of this connect and obj.m.Graphics = 'legacy')
                if (info.offerLegacy) { obj.consoleAction = { id: 'reconnect-legacy' }; }
                else if (info.cert && (info.code === 'RDP_ERROR_CERT_CHANGED')) { obj.consoleAction = { id: 'accept-cert', cert: info.cert }; } // the page offers it to users who may accept it
                else { delete obj.consoleAction; }
                if (obj.onConsoleMessageChange) { obj.onConsoleMessageChange(); }
            }
        }
    });

    function changeState(newstate) {
        if (obj.State == newstate) return;
        obj.State = newstate;
        if (newstate == 0) { stopWatchingContainerSize(); }
        if (obj.onStateChanged != null) obj.onStateChanged(obj, obj.State);
    }

    // With the Browser Size setting the remote desktop follows the size of the page area
    function watchContainerSize() {
        stopWatchingContainerSize(); // the legacy fallback connects twice in one Start()
        if ((obj.m.AutoResize !== true) || (typeof ResizeObserver === 'undefined') || (obj.CanvasId.parentNode == null)) return;
        var parent = obj.CanvasId.parentNode;
        resizeObserver = new ResizeObserver(function () { client.requestResize(parent.clientWidth, parent.clientHeight); });
        resizeObserver.observe(parent);
    }
    function stopWatchingContainerSize() { if (resizeObserver != null) { resizeObserver.disconnect(); resizeObserver = null; } }

    obj.Start = function (nodeid, port, credentials) {
        obj.nodeid = nodeid;
        obj.port = port;
        obj.credentials = credentials;
        client.connect({
            ip: nodeid,
            domain: credentials.domain,
            username: credentials.username,
            password: credentials.password,
            locale: window.navigator.language,
            screen: { width: credentials.width || obj.width, height: credentials.height || obj.height },
            options: { savepass: credentials.savecred, useServerCreds: credentials.servercred, flags: credentials.flags, workingDir: credentials.workdir, alternateShell: credentials.altshell }
        });
    }

    obj.Stop = function () { stopWatchingContainerSize(); client.disconnect(); }

    obj.m.mouseCursorActive = function (x) { client.setCursorActive(x); }
    obj.m.mousemove = function (e) { return client.mouseMove(e); }
    obj.m.mousedown = function (e) { return client.mouseDown(e); }
    obj.m.mouseup = function (e) { return client.mouseUp(e); }
    obj.m.mousewheel = function (e) { return client.wheel(e); }
    obj.m.handleKeyDown = function (e) { return client.keyDown(e); }
    obj.m.handleKeyUp = function (e) { return client.keyUp(e); }
    obj.m.releaseModifiers = function () { client.releaseKeys(); }
    obj.m.handleReleaseKeys = function () { client.releaseKeys(); } // the page calls it when it opens a dialog or loses focus
    obj.m.sendcad = function () { client.sendCad(); } // Ctrl-Alt-Del
    obj.m.SendStringUnicode = function (txt) { client.typeText(txt); }
    obj.m.setClipboard = function (content) { client.setClipboard(content); }
    obj.m.getClipboard = function () { return obj.lastClipboardContent; }
    obj.m.SendKeyMsgKC = function (action, kc, extendedKey) {
        if (obj.State != 3) return;
        if (typeof action == 'object') { for (var i in action) { obj.m.SendKeyMsgKC(action[i][0], action[i][1], action[i][2]); } }
        else { client.sendKeyCode(((action & 1) != 0), kc); }
    }
    obj.m.mousedblclick = function () { }
    obj.m.handleKeyPress = function () { }
    obj.m.handleKeys = function () { }
    obj.m.setRotation = function () { }

    return obj;
}
