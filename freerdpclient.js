/**
* @description MeshCentral RDP client backed by the native "meshfreerdp" helper (FreeRDP 3)
* The helper runs as a child process and talks to us using the framed protocol described in freerdp/PROTOCOL.md.
* @license Apache-2.0
* @version v0.1.0
*/

'use strict';

const child_process = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

// Frame types, Node -> helper
const T_CONFIG = 0x81, T_MOUSE = 0x82, T_KEY_SCANCODE = 0x83, T_KEY_UNICODE = 0x84, T_CLIPBOARD = 0x85, T_QUIT = 0x86;
// Frame types, helper -> Node
const F_CONNECTED = 0x01, F_TILE = 0x02, F_POINTER = 0x03, F_CLIPBOARD = 0x04, F_ERROR = 0x05, F_CLOSED = 0x06, F_LOG = 0x07;

const MAX_FRAME = 64 * 1024 * 1024; // Maximum payload length allowed by the protocol
const KILL_TIMEOUT = 2000; // Time given to the helper to exit before SIGKILL

// Mouse flags (FreeRDP / MS-RDPBCGR 2.2.8.1.1.3.1.1.3)
const PTR_FLAGS_HWHEEL = 0x0400, PTR_FLAGS_WHEEL = 0x0200, PTR_FLAGS_WHEEL_NEGATIVE = 0x0100;
const PTR_FLAGS_MOVE = 0x0800, PTR_FLAGS_DOWN = 0x8000;
const PTR_FLAGS_BUTTON1 = 0x1000, PTR_FLAGS_BUTTON2 = 0x2000, PTR_FLAGS_BUTTON3 = 0x4000;

// Locale to Windows keyboard layout identifier (KLID)
const keyboardLayouts = {
    'pl-pl': 0x415, 'pl': 0x415,
    'en-us': 0x409, 'en': 0x409, 'en-gb': 0x809,
    'de-de': 0x407, 'de': 0x407,
    'fr-fr': 0x40C, 'fr': 0x40C,
    'es-es': 0x40A, 'es': 0x40A, 'es-mx': 0x80A,
    'it-it': 0x410, 'it': 0x410,
    'ru-ru': 0x419, 'ru': 0x419,
    'ja-jp': 0x411, 'ja': 0x411,
    'pt-br': 0x416, 'pt': 0x416, 'pt-pt': 0x816,
    'nl-nl': 0x413, 'nl': 0x413,
    'cs-cz': 0x405, 'cs': 0x405,
    'sv-se': 0x41D, 'sv': 0x41D,
    'tr-tr': 0x41F, 'tr': 0x41F,
    'uk-ua': 0x422, 'uk': 0x422
};

function localeToKeyboardLayout(locale) {
    if (typeof locale != 'string') { return 0; }
    const l = locale.trim().toLowerCase().replace(/_/g, '-');
    if (keyboardLayouts[l] != null) { return keyboardLayouts[l]; }
    const lang = l.split('-')[0];
    return (keyboardLayouts[lang] != null) ? keyboardLayouts[lang] : 0;
}

function clampU16(v) { v = Math.trunc(Number(v)); if (!(v >= 0)) { return 0; } return (v > 65535) ? 65535 : v; }

function buildFrame(type, payload) {
    if (payload == null) { payload = Buffer.alloc(0); }
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame[0] = type;
    frame.writeUInt32LE(payload.length, 1);
    payload.copy(frame, 5);
    return frame;
}

// Returns the first existing executable among: configured path, freerdp/build/meshfreerdp, "meshfreerdp" in PATH. Null if none.
module.exports.getBinaryPath = function (configuredPath) {
    const name = (process.platform == 'win32') ? 'meshfreerdp.exe' : 'meshfreerdp';
    const candidates = [];
    if ((typeof configuredPath == 'string') && (configuredPath.length > 0)) { candidates.push(configuredPath); }
    candidates.push(path.join(__dirname, 'freerdp', 'build', name));
    const dirs = (process.env.PATH || '').split(path.delimiter);
    for (var i in dirs) { if (dirs[i] != '') { candidates.push(path.join(dirs[i], name)); } }
    for (var j in candidates) {
        try {
            if (!fs.statSync(candidates[j]).isFile()) { continue; }
            fs.accessSync(candidates[j], fs.constants.X_OK);
            return candidates[j];
        } catch (ex) { }
    }
    return null;
};

module.exports.localeToKeyboardLayout = localeToKeyboardLayout;

module.exports.createClient = function (args) {
    if (args == null) { args = {}; }
    const obj = new EventEmitter();
    var child = null;
    var connected = false; // Helper sent CONNECTED, input is allowed
    var closeRequested = false; // close() was called
    var gotClosed = false; // Helper sent CLOSED frame
    var closeEmitted = false;
    var killTimer = null;
    var chunks = [], chunksLen = 0; // Pending stdout bytes
    var stderrPartial = '';

    obj.stdout = null; // Exposed for flow control once connect() is called

    function debug(msg) { try { if (typeof args.debug == 'function') { args.debug(msg); } } catch (ex) { } }

    // EventEmitter throws on unhandled 'error', we don't want that.
    function emitError(name, code) { if (obj.listenerCount('error') > 0) { obj.emit('error', { err: name, code: code }); } }

    function emitClose() {
        if (closeEmitted) return;
        closeEmitted = true;
        connected = false;
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        obj.emit('close');
    }

    function armKillTimer() {
        if (killTimer || (child == null)) return;
        killTimer = setTimeout(function () {
            killTimer = null;
            try { if (child && (child.exitCode == null) && (child.signalCode == null)) { child.kill('SIGKILL'); } } catch (ex) { }
        }, KILL_TIMEOUT);
    }

    function writeFrame(type, payload) {
        if ((child == null) || (child.stdin == null) || child.stdin.destroyed || !child.stdin.writable) return false;
        try { child.stdin.write(buildFrame(type, payload)); return true; } catch (ex) { return false; }
    }

    // Input is ignored until the helper reports a connection, and after close
    function canSend() { return connected && !closeRequested; }

    // ---- helper -> Node ----

    function handleFrame(type, payload) {
        switch (type) {
            case F_CONNECTED: {
                var info = {};
                try { info = JSON.parse(payload.toString('utf8')); } catch (ex) { }
                if (connected) { obj.emit('resize', { width: info.width, height: info.height }); break; }
                connected = true;
                obj.emit('connect', { width: info.width, height: info.height });
                break;
            }
            case F_TILE: {
                if (payload.length < 9) break;
                const x = payload.readUInt16LE(0), y = payload.readUInt16LE(2), w = payload.readUInt16LE(4), h = payload.readUInt16LE(6), fmt = payload[8];
                if ((w == 0) || (h == 0)) break;
                obj.emit('bitmap', { destLeft: x, destTop: y, destRight: x + w - 1, destBottom: y + h - 1, width: w, height: h, bitsPerPixel: 32, isCompress: false, fmt: fmt, data: payload.subarray(9) });
                break;
            }
            case F_POINTER: { obj.emit('pointer', null, payload.toString('utf8')); break; }
            case F_CLIPBOARD: { obj.emit('clipboard', payload.toString('utf8')); break; }
            case F_ERROR: {
                var e = {};
                try { e = JSON.parse(payload.toString('utf8')); } catch (ex) { }
                emitError((typeof e.name == 'string') ? e.name : 'FREERDP_HELPER_FAILED', e.code);
                break;
            }
            case F_CLOSED: { gotClosed = true; armKillTimer(); break; }
            case F_LOG: { debug('meshfreerdp: ' + payload.toString('utf8')); break; }
            default: { debug('freerdpclient: unknown frame type ' + type); break; }
        }
    }

    // Take exactly n bytes from the pending queue
    function take(n) {
        var buf;
        if (chunks[0].length >= n) {
            buf = chunks[0].subarray(0, n);
            if (chunks[0].length == n) { chunks.shift(); } else { chunks[0] = chunks[0].subarray(n); }
        } else {
            buf = Buffer.allocUnsafe(n);
            var off = 0;
            while (off < n) {
                const c = chunks[0], need = n - off;
                if (c.length <= need) { c.copy(buf, off); off += c.length; chunks.shift(); }
                else { c.copy(buf, off, 0, need); chunks[0] = c.subarray(need); off = n; }
            }
        }
        chunksLen -= n;
        return buf;
    }

    function peekHeader() {
        const h = Buffer.allocUnsafe(5);
        var off = 0;
        for (var i = 0; (i < chunks.length) && (off < 5); i++) { off += chunks[i].copy(h, off, 0, Math.min(5 - off, chunks[i].length)); }
        return h;
    }

    function onStdout(chunk) {
        chunks.push(chunk);
        chunksLen += chunk.length;
        while (chunksLen >= 5) {
            const h = peekHeader();
            const len = h.readUInt32LE(1);
            if (len > MAX_FRAME) {
                debug('freerdpclient: protocol error, frame too large (' + len + ')');
                chunks = []; chunksLen = 0;
                protocolFailure();
                return;
            }
            if (chunksLen < 5 + len) break;
            take(5);
            const payload = (len > 0) ? take(len) : Buffer.alloc(0);
            try { handleFrame(h[0], payload); } catch (ex) { debug('freerdpclient: frame handler exception: ' + ex); }
        }
    }

    function protocolFailure() {
        if (!closeEmitted && !closeRequested) { emitError('FREERDP_HELPER_FAILED', 0); }
        obj.close();
    }

    // ---- public API ----

    obj.connect = function (host, port) {
        if ((child != null) || closeRequested) return obj;
        const config = {
            host: host,
            port: port,
            domain: args.domain || '',
            username: args.userName || '',
            password: args.password || '',
            width: (args.screen && args.screen.width) ? args.screen.width : 1024,
            height: (args.screen && args.screen.height) ? args.screen.height : 768,
            keyboardLayout: localeToKeyboardLayout(args.locale)
        };
        if (typeof args.perfFlags == 'number') { config.perfFlags = args.perfFlags; }
        if (args.workingDir) { config.workingDir = args.workingDir; }
        if (args.alternateShell) { config.alternateShell = args.alternateShell; }
        if (typeof args.jpegQuality == 'number') { config.jpegQuality = args.jpegQuality; }
        if (typeof args.colorDepth == 'number') { config.colorDepth = args.colorDepth; }
        if (typeof args.gfx == 'boolean') { config.gfx = args.gfx; }
        if (typeof args.h264 == 'boolean') { config.h264 = args.h264; }

        try {
            child = child_process.spawn(args.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (ex) {
            debug('freerdpclient: spawn failed: ' + ex);
            child = null;
            process.nextTick(function () { emitError('FREERDP_HELPER_FAILED', 0); emitClose(); });
            return obj;
        }
        obj.stdout = child.stdout;

        child.on('error', function (err) { // Spawn failure (ENOENT, EACCES, ...) or kill failure
            debug('freerdpclient: helper error: ' + err);
            if (closeEmitted) return;
            const neverStarted = (child && (child.pid == null));
            if (neverStarted || !closeRequested) { emitError('FREERDP_HELPER_FAILED', (typeof err.errno == 'number') ? err.errno : 0); }
            if (neverStarted) { emitClose(); } // Never started, 'close' may not follow
        });
        child.on('close', function (code, signal) {
            if (stderrPartial.length > 0) { debug('meshfreerdp: ' + stderrPartial); stderrPartial = ''; }
            debug('freerdpclient: helper exited, code=' + code + ', signal=' + signal + ', closedFrame=' + gotClosed);
            if (!gotClosed && !closeRequested && !closeEmitted) { emitError('FREERDP_HELPER_FAILED', (code != null) ? code : -1); }
            emitClose();
        });
        child.stdin.on('error', function () { }); // EPIPE when the helper is gone
        child.stdout.on('error', function () { });
        child.stdout.on('data', onStdout);
        child.stderr.on('error', function () { });
        child.stderr.on('data', function (d) {
            stderrPartial += d.toString('utf8');
            var i;
            while ((i = stderrPartial.indexOf('\n')) >= 0) {
                const line = stderrPartial.substring(0, i).replace(/\r$/, '');
                stderrPartial = stderrPartial.substring(i + 1);
                if (line.length > 0) { debug('meshfreerdp: ' + line); }
            }
            if (stderrPartial.length > 8192) { debug('meshfreerdp: ' + stderrPartial); stderrPartial = ''; }
        });

        writeFrame(T_CONFIG, Buffer.from(JSON.stringify(config), 'utf8')); // Must be the first frame
        return obj;
    };

    obj.sendPointerEvent = function (x, y, button, isPressed) {
        if (!canSend()) return;
        var flags = 0;
        switch (button) {
            case 1: flags = PTR_FLAGS_BUTTON1; break;
            case 2: flags = PTR_FLAGS_BUTTON2; break;
            case 3: flags = PTR_FLAGS_BUTTON3; break;
            default: flags = PTR_FLAGS_MOVE; break;
        }
        if (isPressed) { flags |= PTR_FLAGS_DOWN; }
        const p = Buffer.allocUnsafe(6);
        p.writeUInt16LE(flags, 0); p.writeUInt16LE(clampU16(x), 2); p.writeUInt16LE(clampU16(y), 4);
        writeFrame(T_MOUSE, p);
    };

    obj.sendWheelEvent = function (x, y, step, isNegative, isHorizontal) {
        if (!canSend()) return;
        var flags = isHorizontal ? PTR_FLAGS_HWHEEL : PTR_FLAGS_WHEEL;
        step = Math.trunc(Number(step));
        if (isNaN(step)) { step = 0; }
        isNegative = !!isNegative;
        if (step < 0) { step = -step; isNegative = !isNegative; }
        step = Math.min(step, 255);
        flags |= isNegative ? (PTR_FLAGS_WHEEL_NEGATIVE | ((-step) & 0xFF)) : (step & 0xFF);
        const p = Buffer.allocUnsafe(6);
        p.writeUInt16LE(flags, 0); p.writeUInt16LE(clampU16(x), 2); p.writeUInt16LE(clampU16(y), 4);
        writeFrame(T_MOUSE, p);
    };

    obj.sendKeyEventScancode = function (code, isPressed, extended) {
        if (!canSend()) return;
        code = Number(code) | 0;
        const ext = (extended || ((code & 0xFF00) == 0xE000)) ? 1 : 0;
        writeFrame(T_KEY_SCANCODE, Buffer.from([code & 0xFF, isPressed ? 1 : 0, ext]));
    };

    obj.sendKeyEventUnicode = function (code, isPressed) {
        if (!canSend()) return;
        const p = Buffer.allocUnsafe(3);
        p.writeUInt16LE(clampU16(code), 0); p[2] = isPressed ? 1 : 0;
        writeFrame(T_KEY_UNICODE, p);
    };

    obj.setClipboardData = function (text) {
        if (!canSend() || (typeof text != 'string')) return;
        writeFrame(T_CLIPBOARD, Buffer.from(text, 'utf8'));
    };

    // Ask the helper to quit, kill it if it does not exit in time. Safe to call many times.
    obj.close = function () {
        if (closeRequested) return;
        closeRequested = true;
        connected = false;
        if (child == null) { process.nextTick(emitClose); return; }
        if (closeEmitted) return;
        writeFrame(T_QUIT);
        try { child.stdin.end(); } catch (ex) { }
        armKillTimer();
    };

    return obj;
};
