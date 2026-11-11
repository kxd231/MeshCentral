/**
* @description Web-RDP browser messages: builders for browser → server JSON, validation of server → browser JSON, error text
* @license Apache-2.0
*
* Implements the JSON side of rdp/WIRE.md without any DOM access, so it is tested in Node.
* A builder returns the message array, or null when the arguments cannot form a valid message
* (the server would count it as invalid; three in a row end the session).
* Usable from Node (require) and from a page (self.RdpClient.messages).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) {
        module.exports = factory(require('./shared/limits.js'), require('./shared/constants.js'), require('./shared/errors.js'));
    } else {
        root.RdpClient = root.RdpClient || {};
        root.RdpClient.messages = factory(root.RdpShared.limits, root.RdpShared.constants, root.RdpShared.errors);
    }
})((typeof self !== 'undefined') ? self : this, function (limits, constants, errors) {
    'use strict';

    const LOCALE_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
    const ERROR_CODE_RE = /^RDP_ERROR_[A-Z0-9_]{1,64}$/;
    const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
    const DETAIL_RE = /^[A-Za-z0-9_]{1,64}$/;
    const CLIENT_ERROR_CODES = ['TRUNCATED', 'INVALID', 'LIMIT', 'UNSUPPORTED', 'INTERNAL'];

    function isInt(v, min, max) { return Number.isSafeInteger(v) && (v >= min) && (v <= max); }
    function hasNul(s) { return s.indexOf('\u0000') >= 0; }
    function clampInt(v, min, max) { v = Math.round(v); return (v < min) ? min : ((v > max) ? max : v); }

    // ---- connection ------------------------------------------------------------------------------

    // WebSocket URL of the relay. basePath is the domain path of the page ('/' or '/domain/'), it is
    // normalised to start and end with '/'. The scheme follows the page (wss on https).
    function relayUrl(loc, basePath) {
        let p = (typeof basePath === 'string') ? basePath : '/';
        if (!p.startsWith('/')) { p = '/' + p; }
        if (!p.endsWith('/')) { p += '/'; }
        return ((loc.protocol === 'https:') ? 'wss://' : 'ws://') + loc.host + p + 'mstscrelay.ashx';
    }

    // Base path of the standalone page (…/mstsc.html): everything before the last path segment
    function basePathOfPage(pathname) {
        const i = (typeof pathname === 'string') ? pathname.lastIndexOf('/') : -1;
        return (i >= 0) ? pathname.substring(0, i + 1) : '/';
    }

    function normalizeLocale(locale) {
        return ((typeof locale === 'string') && (locale.length <= limits.LOCALE_MAX_CHARS) && LOCALE_RE.test(locale)) ? locale : 'en-US';
    }

    // Capability report for infos.options.browser. h264: { ok, decodeMs } from the worker's probe (dev GFX only), else not supported.
    // rfx: the worker's RemoteFX probe passed (dev switch only); the server uses it to advertise legacy Surface Commands.
    // avc444: { ok, decodeMs } of the AVC444 probe (dev GFX switch only; the server honours it only there too).
    function browserCaps(hasOffscreenCanvas, h264, rfx, avc444) {
        const h = ((h264 != null) && (h264.ok === true) && Number.isFinite(h264.decodeMs) && (h264.decodeMs >= 0) && (h264.decodeMs <= 60000)) ? { ok: true, decodeMs: h264.decodeMs } : { ok: false, decodeMs: 0 };
        const a = ((avc444 != null) && (avc444.ok === true) && Number.isFinite(avc444.decodeMs) && (avc444.decodeMs >= 0) && (avc444.decodeMs <= 60000)) ? { ok: true, decodeMs: avc444.decodeMs } : { ok: false, decodeMs: 0 };
        return { h264: h, avc444: a, offscreenCanvas: (hasOffscreenCanvas === true), rfx: (rfx === true) };
    }

    const GFX_REQUESTS = ['legacy', 'gfx', 'h264'];

    // p: { ip, domain, username, password, locale, screen: { width, height },
    //      options: { savepass, useServerCreds, flags, workingDir, alternateShell, gfx }, offscreenCanvas, h264: { ok, decodeMs }, rfx }
    // options.gfx: 'legacy' (default; the only value outside the dev GFX switch), 'gfx' (set A) or 'h264' (set B + A).
    // → { ok: true, message } | { ok: false, error: string }. Over-long credentials are rejected, never truncated.
    function buildInfos(p) {
        if ((p == null) || (typeof p !== 'object')) { return { ok: false, error: 'No connection parameters' }; }
        if ((typeof p.ip !== 'string') || (p.ip.length < 1) || (p.ip.length > limits.IP_FIELD_MAX_CHARS) || hasNul(p.ip)) { return { ok: false, error: 'Invalid device identifier' }; }
        const o = p.options || {};
        const strings = { domain: p.domain, username: p.username, password: p.password };
        for (const k of Object.keys(strings)) {
            const v = (strings[k] == null) ? '' : strings[k];
            if (typeof v !== 'string') { return { ok: false, error: 'Invalid ' + k }; }
            if (v.length > limits.CREDENTIAL_FIELD_MAX_CHARS) { return { ok: false, error: 'The ' + k + ' is too long (' + limits.CREDENTIAL_FIELD_MAX_CHARS + ' characters at most)' }; }
            if (hasNul(v)) { return { ok: false, error: 'Invalid ' + k }; }
            strings[k] = v;
        }
        const info = { workingDir: (o.workingDir == null) ? '' : o.workingDir, alternateShell: (o.alternateShell == null) ? '' : o.alternateShell };
        for (const k of Object.keys(info)) {
            if ((typeof info[k] !== 'string') || (info[k].length > limits.INFO_FIELD_MAX_CHARS) || hasNul(info[k])) { return { ok: false, error: 'Invalid ' + k }; }
        }
        const s = p.screen || {};
        let w = Number.isFinite(s.width) ? s.width : 1280, h = Number.isFinite(s.height) ? s.height : 1024;
        w = clampInt(w, limits.DESKTOP_MIN_DIM, limits.DESKTOP_MAX_DIM);
        h = clampInt(h, limits.DESKTOP_MIN_DIM, limits.DESKTOP_MAX_DIM);
        if (w % 2 !== 0) { w--; }
        const flags = (o.flags == null) ? 0 : o.flags;
        if (!isInt(flags, 0, 0x1FF)) { return { ok: false, error: 'Invalid performance flags' }; }
        const gfx = (o.gfx == null) ? 'legacy' : o.gfx;
        if (GFX_REQUESTS.indexOf(gfx) < 0) { return { ok: false, error: 'Invalid graphics mode' }; }
        return {
            ok: true,
            message: ['infos', {
                ip: p.ip,
                screen: { width: w, height: h },
                domain: strings.domain,
                username: strings.username,
                password: strings.password,
                locale: normalizeLocale(p.locale),
                options: {
                    savepass: (o.savepass === true),
                    useServerCreds: (o.useServerCreds === true),
                    flags: flags,
                    gfx: gfx,      // 'legacy' unless the dev GFX switch asked for more; the server default would be 'gfx'
                    bpp: 32,
                    workingDir: info.workingDir,
                    alternateShell: info.alternateShell,
                    browser: browserCaps(p.offscreenCanvas, p.h264, p.rfx, p.avc444)
                }
            }]
        };
    }

    // ---- input -----------------------------------------------------------------------------------

    // MouseEvent.button → RDP button (1 left, 2 right, 3 middle, 4 X1/back, 5 X2/forward), swap exchanges left and right
    function mouseButton(domButton, swap) {
        const map = [1, 3, 2, 4, 5];
        let b = map[domButton];
        if (b === undefined) { return 0; }
        if (swap === true) { if (b === 1) { b = 2; } else if (b === 2) { b = 1; } }
        return b;
    }

    // Position on the remote desktop from client coordinates and the canvas rectangle (CSS pixels),
    // scaled to the desktop size and clamped inside it
    function mousePoint(clientX, clientY, rect, width, height) {
        const rw = (rect.width > 0) ? rect.width : width, rh = (rect.height > 0) ? rect.height : height;
        let x = Math.floor((clientX - rect.left) * width / rw), y = Math.floor((clientY - rect.top) * height / rh);
        if (!Number.isFinite(x)) { x = 0; }
        if (!Number.isFinite(y)) { y = 0; }
        return { x: Math.min(Math.max(x, 0), width - 1), y: Math.min(Math.max(y, 0), height - 1) };
    }

    function mouse(x, y, button, down, width, height) {
        if (!isInt(x, 0, width - 1) || !isInt(y, 0, height - 1) || !isInt(button, 0, 5)) { return null; }
        if ((button === 0) && (down !== false)) { return null; }
        return ['mouse', x, y, button, (down === true)];
    }

    function wheel(x, y, delta, horizontal, width, height) {
        if (!isInt(x, 0, width - 1) || !isInt(y, 0, height - 1) || !isInt(delta, -255, 255) || (delta === 0)) { return null; }
        return ['wheel', x, y, delta, (horizontal === true)];
    }

    // Turns browser wheel events into RDP wheel steps: one notch is 120 units. Fractions of a step
    // (touchpads, high resolution wheels) accumulate until they reach a whole unit.
    // Browser deltaY > 0 scrolls down, RDP delta > 0 is up/right, so vertical is inverted.
    class WheelAccumulator {
        constructor() { this.v = 0; this.h = 0; }
        // → array of { delta, horizontal }, each delta within −255..255 and non-zero
        add(deltaX, deltaY, deltaMode, reverse) {
            const unit = (deltaMode === 1) ? 40 : ((deltaMode === 2) ? 120 * 10 : 1.2); // lines (3 per notch), pages, pixels (100 per notch)
            const out = [];
            const sign = (reverse === true) ? -1 : 1;
            if (Number.isFinite(deltaY) && (deltaY !== 0)) { this.v += -deltaY * unit * sign; this._drain('v', false, out); }
            if (Number.isFinite(deltaX) && (deltaX !== 0)) { this.h += deltaX * unit * sign; this._drain('h', true, out); }
            return out;
        }
        _drain(key, horizontal, out) {
            let guard = 8; // one event never produces more than 8 messages, the rest is dropped
            while (guard-- > 0) {
                const whole = (this[key] > 0) ? Math.floor(this[key]) : Math.ceil(this[key]);
                if (whole === 0) { return; }
                const step = Math.max(-255, Math.min(255, whole));
                this[key] -= step;
                out.push({ delta: step, horizontal: horizontal });
            }
            this[key] = 0;
        }
    }

    // Wheel event of any shape → { dx, dy, mode }, deltas in the WheelEvent convention (positive = down / right)
    // and mode 0 pixels, 1 lines, 2 pages. Covers 'wheel', legacy 'mousewheel' (wheelDelta, up is positive,
    // 120 per notch) and Firefox 'DOMMouseScroll' (detail in lines, axis 1 horizontal / 2 vertical).
    function normalizeWheel(e) {
        if ((typeof e.deltaX === 'number') || (typeof e.deltaY === 'number')) {
            return { dx: e.deltaX || 0, dy: e.deltaY || 0, mode: e.deltaMode || 0 };
        }
        if (typeof e.wheelDelta === 'number') {
            const px = -e.wheelDelta * 100 / 120;
            return (e.wheelDeltaX && !e.wheelDeltaY) ? { dx: px, dy: 0, mode: 0 } : { dx: 0, dy: px, mode: 0 };
        }
        if (typeof e.detail === 'number') { return (e.axis === 1) ? { dx: e.detail, dy: 0, mode: 1 } : { dx: 0, dy: e.detail, mode: 1 }; }
        return { dx: 0, dy: 0, mode: 0 };
    }

    function scancode(code, down) {
        return (Number.isInteger(code) && (((code >= 0x01) && (code <= 0x7F)) || ((code >= 0xE001) && (code <= 0xE07F)))) ? ['scancode', code, (down === true)] : null;
    }

    function unicode(unit, down) {
        return isInt(unit, 1, 0xFFFF) ? ['unicode', unit, (down === true)] : null;
    }

    // Text typed by the main process, one unit per UTYPE_INTERVAL_MS. Longer text is rejected, never cut.
    function utype(text) {
        if ((typeof text !== 'string') || hasNul(text) || (text.length > limits.UTYPE_MAX_CHARS)) { return null; }
        return ['utype', text];
    }

    function sync(locks) { return isInt(locks, 0, 15) ? ['sync', locks] : null; }

    // Clipboard text: UTF-16LE with a terminator must fit CLIPBOARD_MAX_BYTES. NUL is removed.
    function clipboard(text) {
        if (typeof text !== 'string') { return null; }
        const t = hasNul(text) ? text.split('\u0000').join('') : text;
        if (((t.length * 2) + 2) > limits.CLIPBOARD_MAX_BYTES) { return null; }
        return ['clipboard', t];
    }

    // Desktop size request: latest wins on the server. Width is rounded down to an even number.
    function resize(width, height) {
        if (!Number.isFinite(width) || !Number.isFinite(height)) { return null; }
        let w = Math.floor(width), h = Math.floor(height);
        if (w % 2 !== 0) { w--; }
        if (!isInt(w, limits.DESKTOP_MIN_DIM, limits.DESKTOP_MAX_DIM) || !isInt(h, limits.DESKTOP_MIN_DIM, limits.DESKTOP_MAX_DIM)) { return null; }
        return ['resize', w, h];
    }

    function visibility(visible) { return ['visibility', (visible === true)]; }
    function ack(total) { return Number.isSafeInteger(total) && (total >= 0) ? ['ack', total] : null; }
    // ['gfx-ack', frameId, queueDepth]: END_FRAME of frameId rendered (rdp/WIRE.md "GFX frame acknowledgements")
    function gfxAck(frameId, queueDepth) {
        return (isInt(frameId, 0, 0xFFFFFFFF) && isInt(queueDepth, 0, 0xFFFFFFFE)) ? ['gfx-ack', frameId, queueDepth] : null;
    }
    function clientError(code) { return (CLIENT_ERROR_CODES.indexOf(code) >= 0) ? ['client-error', code] : ['client-error', 'INTERNAL']; }

    // ---- server → browser ------------------------------------------------------------------------

    // Parses and validates a text frame. → null for anything invalid or unknown, else { type, ... }
    function parseServerMessage(text) {
        if (typeof text !== 'string') { return null; }
        let m;
        try { m = JSON.parse(text); } catch (ex) { return null; }
        if (!Array.isArray(m) || (typeof m[0] !== 'string')) { return null; }
        const o = m[1];
        switch (m[0]) {
            case 'rdp-connect': {
                if ((m.length !== 2) || (o == null) || (typeof o !== 'object')) { return null; }
                if (!isInt(o.width, 1, limits.DESKTOP_MAX_DIM) || !isInt(o.height, 1, limits.DESKTOP_MAX_DIM)) { return null; }
                if ((o.width * o.height) > limits.SURFACES_MAX_PIXELS) { return null; }
                if ((o.mode !== 'legacy') && (o.mode !== 'gfx')) { return null; }
                let gfx = null;
                if ((o.gfx != null) && (typeof o.gfx === 'object') && isInt(o.gfx.capsVersion, 0, 0xFFFFFFFF) && isInt(o.gfx.flags, 0, 0xFFFFFFFF)) { gfx = { capsVersion: o.gfx.capsVersion, flags: o.gfx.flags }; }
                return { type: 'connect', wire: o.wire, width: o.width, height: o.height, mode: o.mode, gfx: gfx };
            }
            case 'rdp-resize': {
                if ((m.length !== 2) || (o == null) || (typeof o !== 'object')) { return null; }
                if (!isInt(o.width, 1, limits.DESKTOP_MAX_DIM) || !isInt(o.height, 1, limits.DESKTOP_MAX_DIM)) { return null; }
                if ((o.width * o.height) > limits.SURFACES_MAX_PIXELS) { return null; }
                return { type: 'resize', width: o.width, height: o.height };
            }
            case 'rdp-clipboard': {
                if ((m.length !== 2) || (typeof o !== 'string') || (o.length > ((limits.CLIPBOARD_MAX_BYTES / 2) - 1))) { return null; }
                return { type: 'clipboard', text: o };
            }
            case 'rdp-error': {
                if ((m.length !== 2) || (o == null) || (typeof o !== 'object')) { return null; }
                return { type: 'error', error: sanitizeError(o) };
            }
            case 'rdp-close': return (m.length === 1) ? { type: 'close' } : null;
            case 'ping': return (m.length === 1) ? { type: 'ping' } : null;
            case 'pong': return (m.length === 1) ? { type: 'pong' } : null;
            default: return null;
        }
    }

    // Only keep the fields of rdp-error that have the documented shape
    function sanitizeError(o) {
        const r = { code: (typeof o.code === 'string') && ERROR_CODE_RE.test(o.code) ? o.code : 'RDP_ERROR_INTERNAL' };
        if ((typeof o.detail === 'string') && DETAIL_RE.test(o.detail)) { r.detail = o.detail; }
        if ((typeof o.phase === 'string') && /^[a-zA-Z0-9_-]{1,64}$/.test(o.phase)) { r.phase = o.phase; }
        if ((typeof o.hint === 'string') && /^[a-z0-9-]{1,32}$/.test(o.hint)) { r.hint = o.hint; }
        // The pinned and the presented certificate fingerprints (public values), only with RDP_ERROR_CERT_CHANGED
        if ((r.code === 'RDP_ERROR_CERT_CHANGED') && (o.cert != null) && (typeof o.cert === 'object') && FINGERPRINT_RE.test(o.cert.actual) &&
            ((o.cert.expected === null) || FINGERPRINT_RE.test(o.cert.expected))) { r.cert = { expected: o.cert.expected, actual: o.cert.actual }; }
        return r;
    }

    // Plain English hints for the fixed hint ids; translation comes later
    const HINT_TEXT = {};
    HINT_TEXT[errors.hints.USE_GFX] = 'Try the GFX graphics mode.';
    HINT_TEXT[errors.hints.USE_LEGACY] = 'Try the legacy graphics mode.';
    HINT_TEXT[errors.hints.ENABLE_TLS] = 'Enable TLS or Network Level Authentication on the RDP server.';
    HINT_TEXT[errors.hints.ENABLE_H264] = 'The server needs H.264, which this browser cannot decode.';
    HINT_TEXT[errors.hints.CHECK_CREDENTIALS] = 'Check the username, password and domain.';

    // → { message, code, detail, hint } for display. `message` is plain text (the caller escapes it for HTML).
    function describeError(err) {
        const e = sanitizeError((err != null && typeof err === 'object') ? err : {});
        const known = errors.isKnown(e.code);
        let message = known ? (errors.descriptions[e.code] + ' [' + e.code + ']') : ('RDP error: ' + e.code);
        if (e.hint && HINT_TEXT[e.hint]) { message += '. ' + HINT_TEXT[e.hint]; }
        // TLS xrdp can finalize RDP before checking the account, then close without a logon error.
        // A generic disconnect cannot prove authentication failure, even after rdp-connect.
        if (!e.detail && !e.hint && (e.code === 'RDP_ERROR_SERVER_DISCONNECTED' || e.code === 'RDP_ERROR_CONNECTION_LOST')) {
            message += '. If the remote desktop did not open, check the username, password, domain and Remote Desktop logon permissions for the account on the remote computer.';
        }
        if (e.cert) { message += '. Pinned certificate SHA-256: ' + (e.cert.expected || 'none') + '. Certificate presented now: ' + e.cert.actual + '. Ask an administrator of the device to accept the new certificate.'; }
        if (e.detail) { message += ' (' + e.detail + ')'; }
        return { message: message, code: e.code, detail: e.detail, phase: e.phase, hint: e.hint, cert: e.cert };
    }

    return Object.freeze({
        CLIENT_ERROR_CODES: CLIENT_ERROR_CODES,
        relayUrl: relayUrl, basePathOfPage: basePathOfPage, normalizeLocale: normalizeLocale, browserCaps: browserCaps,
        buildInfos: buildInfos, mouseButton: mouseButton, mousePoint: mousePoint, mouse: mouse, wheel: wheel,
        WheelAccumulator: WheelAccumulator, normalizeWheel: normalizeWheel, scancode: scancode, unicode: unicode, utype: utype, sync: sync,
        clipboard: clipboard, resize: resize, visibility: visibility, ack: ack, gfxAck: gfxAck, clientError: clientError,
        parseServerMessage: parseServerMessage, sanitizeError: sanitizeError, describeError: describeError
    });
});
