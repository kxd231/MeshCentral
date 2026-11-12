/**
* @description Web-RDP browser → server messages (rdp/WIRE.md): session states, exact schemas,
* infos validation and defaults, permissions (view-only, limited input), rate limits and
* invalid-message counting. No I/O: the caller passes a sink and, for tests, a clock.
* @license Apache-2.0
*/
'use strict';

const LIMITS = require('./core/limits.js');
const errors = require('./protocol/errors.js');
const constants = require('../public/rdp/shared/constants.js');
const sessionTag = require('./session-tag.js');

const E = errors.names;
const RdpError = errors.RdpError;

const STATE = Object.freeze({ AWAIT_INFOS: 'AWAIT_INFOS', AUTHORIZING: 'AUTHORIZING', CONNECTING: 'CONNECTING', ACTIVE: 'ACTIVE', CLOSING: 'CLOSING' });
const RIGHTS = Object.freeze({ FULL: 'full', LIMITED: 'limited', VIEWONLY: 'viewonly' });

// Mesh rights (meshcentral) used to derive the input level, exactly as CreateMstscRelay does
const MESHRIGHT_REMOTEVIEWONLY = 0x00000100;
const MESHRIGHT_DESKLIMITEDINPUT = 0x00001000;
const MESHRIGHT_ADMIN = 0xFFFFFFFF;

function rightsLevel(rights) {
    if ((rights != MESHRIGHT_ADMIN) && ((rights & MESHRIGHT_REMOTEVIEWONLY) != 0)) { return RIGHTS.VIEWONLY; }
    if ((rights != MESHRIGHT_ADMIN) && ((rights & MESHRIGHT_DESKLIMITEDINPUT) != 0)) { return RIGHTS.LIMITED; }
    return RIGHTS.FULL;
}

// Keys allowed with limited input, as in CreateMstscRelay: digits 1..0, the three letter rows,
// Backspace and Enter. Extended keys (0xE0xx) are not allowed.
function limitedScancodeAllowed(k) {
    return ((k >= 2) && (k <= 11)) || ((k >= 16) && (k <= 25)) || ((k >= 30) && (k <= 38)) || ((k >= 44) && (k <= 50)) || (k == 14) || (k == 28);
}

const CLIENT_ERROR_CODES = new Set(['TRUNCATED', 'INVALID', 'LIMIT', 'UNSUPPORTED', 'INTERNAL']);
const GFX_MODES = new Set(['legacy', 'gfx', 'h264']);
const LOCALE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const INPUT_TYPES = new Set(['mouse', 'wheel', 'scancode', 'unicode', 'sync']);
const CONTROL_TYPES = new Set(['clipboard', 'resize', 'visibility', 'ping', 'pong']);
const MIN_MESSAGE_COST = 64;    // byte budget cost of the smallest message

function isInt(v, min, max) { return Number.isSafeInteger(v) && (v >= min) && (v <= max); }
function isBool(v) { return typeof v == 'boolean'; }
function isStr(v, max) { return (typeof v == 'string') && (v.length <= max) && (v.indexOf('\u0000') < 0); }
function isObj(v) { return (v != null) && (typeof v == 'object') && !Array.isArray(v); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k) && (o[k] !== undefined); }

// Locale → Windows keyboard layout identifier (KLID); 0 lets the server choose
const KEYBOARD_LAYOUTS = {
    'pl-pl': 0x415, 'pl': 0x415, 'en-us': 0x409, 'en': 0x409, 'en-gb': 0x809, 'de-de': 0x407, 'de': 0x407,
    'fr-fr': 0x40C, 'fr': 0x40C, 'es-es': 0x40A, 'es': 0x40A, 'es-mx': 0x80A, 'it-it': 0x410, 'it': 0x410,
    'ru-ru': 0x419, 'ru': 0x419, 'ja-jp': 0x411, 'ja': 0x411, 'pt-br': 0x416, 'pt': 0x416, 'pt-pt': 0x816,
    'nl-nl': 0x413, 'nl': 0x413, 'cs-cz': 0x405, 'cs': 0x405, 'sv-se': 0x41D, 'sv': 0x41D,
    'tr-tr': 0x41F, 'tr': 0x41F, 'uk-ua': 0x422, 'uk': 0x422
};
function localeToKeyboardLayout(locale) {
    if (typeof locale != 'string') { return 0; }
    const l = locale.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KEYBOARD_LAYOUTS, l)) { return KEYBOARD_LAYOUTS[l]; }
    const lang = l.split('-')[0];
    return Object.prototype.hasOwnProperty.call(KEYBOARD_LAYOUTS, lang) ? KEYBOARD_LAYOUTS[lang] : 0;
}

// ['infos', o] → { infos, credentials } or null. Credentials are moved out of o (deleted).
// Unknown keys are ignored; a wrong type or range in a known key makes infos invalid.
function validateInfos(o) {
    if (!isObj(o)) { return null; }
    const credentials = { domain: '', username: '', password: '' };
    let ok = true;
    for (const k of ['domain', 'username', 'password']) {
        if (has(o, k)) { if (isStr(o[k], LIMITS.CREDENTIAL_FIELD_MAX_CHARS)) { credentials[k] = o[k]; } else { ok = false; } }
        delete o[k];
    }
    if (!ok) { return null; }
    if (!isStr(o.ip, LIMITS.IP_FIELD_MAX_CHARS) || (o.ip.length < 1)) { return null; }
    const sc = o.screen;
    if (!isObj(sc) || !isInt(sc.width, LIMITS.DESKTOP_MIN_DIM, LIMITS.DESKTOP_MAX_DIM) || !isInt(sc.height, LIMITS.DESKTOP_MIN_DIM, LIMITS.DESKTOP_MAX_DIM)) { return null; }
    let width = sc.width & ~1;
    if (width < LIMITS.DESKTOP_MIN_DIM) { return null; }
    let locale = 'en-US';
    if (has(o, 'locale')) { if (!isStr(o.locale, LIMITS.LOCALE_MAX_CHARS) || !LOCALE.test(o.locale)) { return null; } locale = o.locale; }
    const options = { savepass: false, useServerCreds: false, flags: 0, gfx: 'gfx', bpp: 32, workingDir: '', alternateShell: '', browser: { h264: { ok: false, decodeMs: 0 }, avc444: { ok: false, decodeMs: 0 }, offscreenCanvas: false, rfx: false } };
    if (has(o, 'options')) {
        const op = o.options;
        if (!isObj(op)) { return null; }
        if (has(op, 'savepass')) { if (!isBool(op.savepass)) { return null; } options.savepass = op.savepass; }
        if (has(op, 'useServerCreds')) { if (!isBool(op.useServerCreds)) { return null; } options.useServerCreds = op.useServerCreds; }
        if (has(op, 'flags')) { if (!isInt(op.flags, 0, 0x1FF)) { return null; } options.flags = op.flags; }
        if (has(op, 'gfx')) { if (!GFX_MODES.has(op.gfx)) { return null; } options.gfx = op.gfx; }
        if (has(op, 'bpp')) { if ([15, 16, 24, 32].indexOf(op.bpp) < 0) { return null; } options.bpp = op.bpp; }
        if (has(op, 'workingDir')) { if (!isStr(op.workingDir, LIMITS.INFO_FIELD_MAX_CHARS)) { return null; } options.workingDir = op.workingDir; }
        if (has(op, 'alternateShell')) { if (!isStr(op.alternateShell, LIMITS.INFO_FIELD_MAX_CHARS)) { return null; } options.alternateShell = op.alternateShell; }
        if (has(op, 'browser')) {
            const b = op.browser;
            if (!isObj(b)) { return null; }
            if (has(b, 'h264')) {
                const h = b.h264;
                if (!isObj(h)) { return null; }
                if (has(h, 'ok')) { if (!isBool(h.ok)) { return null; } options.browser.h264.ok = h.ok; }
                if (has(h, 'decodeMs')) { if ((typeof h.decodeMs != 'number') || !Number.isFinite(h.decodeMs) || (h.decodeMs < 0) || (h.decodeMs > 60000)) { return null; } options.browser.h264.decodeMs = h.decodeMs; }
            }
            if (has(b, 'avc444')) {
                const h = b.avc444;
                if (!isObj(h)) { return null; }
                if (has(h, 'ok')) { if (!isBool(h.ok)) { return null; } options.browser.avc444.ok = h.ok; }
                if (has(h, 'decodeMs')) { if ((typeof h.decodeMs != 'number') || !Number.isFinite(h.decodeMs) || (h.decodeMs < 0) || (h.decodeMs > 60000)) { return null; } options.browser.avc444.decodeMs = h.decodeMs; }
            }
            if (has(b, 'offscreenCanvas')) { if (!isBool(b.offscreenCanvas)) { return null; } options.browser.offscreenCanvas = b.offscreenCanvas; }
            if (has(b, 'rfx')) { if (!isBool(b.rfx)) { return null; } options.browser.rfx = b.rfx; }
        }
    }
    return { infos: { ip: o.ip, screen: { width: width, height: sc.height }, locale: locale, options: options }, credentials: credentials };
}

// start.config (rdp/IPC.md) from validated infos and the user's rights. Startup options only with full control.
// security: settings.security ('nla' with settings.webRdp.requireNla, otherwise 'auto').
// clientName: the session tag of settings.webRdp.sessionTag (rdp/session-tag.js), chosen by the server; anything else gives 'MeshCentral'.
function buildConfig(infos, level, serverName, debug, security, clientName) {
    const o = infos.options;
    const gfxCapsets = [];
    if (o.gfx !== 'legacy') {
        for (const c of constants.GFX_CAPSETS_ALLOWED) {
            if (c.id !== 'A' && c.id !== 'B' && c.id !== 'D') { continue; } // C (10.0, AVC disabled) is never advertised
            if ((c.h264 === true) && !((o.gfx === 'h264') && o.browser.h264.ok)) { continue; }
            if ((c.avc444 === true) && !(o.browser.avc444.ok === true)) { continue; }
            gfxCapsets.push(c.id);
        }
    }
    const full = (level === RIGHTS.FULL);
    return {
        width: infos.screen.width, height: infos.screen.height,
        mode: (o.gfx === 'legacy') ? 'legacy' : 'gfx', gfxCapsets: gfxCapsets, colorDepth: o.bpp,
        // RemoteFX through legacy Surface Commands: only in legacy mode, 32 bpp, when the browser reports the decoder (the caller applies the dev switch)
        surfaceCodecs: ((o.gfx === 'legacy') && (o.bpp === 32) && (o.browser.rfx === true)) ? ['rfx'] : [],
        perfFlags: o.flags, connectionType: 'lan', keyboardLayout: localeToKeyboardLayout(infos.locale),
        clientName: sessionTag.isTag(clientName) ? clientName : 'MeshCentral', serverName: ((typeof serverName == 'string') && /^[A-Za-z0-9.-]{1,255}$/.test(serverName)) ? serverName : '',
        security: (security === 'nla') ? 'nla' : 'auto',
        alternateShell: full ? o.alternateShell : '', workingDir: full ? o.workingDir : '',
        debug: (debug === true)
    };
}

// Pointer bounds: { maxX, maxY } accepted, coordinates above { clampX, clampY } are clamped to them.
// desktop: { width, height, prevWidth, prevHeight, changedAt } (setDesktop). For DESKTOP_CHANGE_GRACE_MS
// after a size change, events sent for the previous size are accepted up to the larger of both sizes.
function pointerBounds(desktop, now) {
    if (desktop == null) { const m = LIMITS.DESKTOP_MAX_DIM - 1; return { maxX: m, maxY: m, clampX: m, clampY: m }; }
    const b = { maxX: desktop.width - 1, maxY: desktop.height - 1, clampX: desktop.width - 1, clampY: desktop.height - 1 };
    if ((desktop.prevWidth != null) && ((now - desktop.changedAt) < LIMITS.DESKTOP_CHANGE_GRACE_MS)) {
        b.maxX = Math.max(desktop.width, desktop.prevWidth) - 1;
        b.maxY = Math.max(desktop.height, desktop.prevHeight) - 1;
    }
    return b;
}

// One browser message (already JSON-parsed) → { type, args } or null when invalid.
// bounds: pointerBounds() of the current desktop (default: the protocol maximum).
function validateMessage(msg, bounds) {
    if (!Array.isArray(msg) || (msg.length < 1) || (typeof msg[0] != 'string')) { return null; }
    const a = msg, n = a.length;
    if (bounds == null) { bounds = pointerBounds(null); }
    const maxX = bounds.maxX, maxY = bounds.maxY;
    function cx(x) { return Math.min(x, bounds.clampX); }
    function cy(y) { return Math.min(y, bounds.clampY); }
    switch (a[0]) {
        case 'infos': return (n === 2) ? { type: 'infos', args: [a[1]] } : null;
        case 'mouse':
            if ((n !== 5) || !isInt(a[1], 0, maxX) || !isInt(a[2], 0, maxY) || !isInt(a[3], 0, 5) || !isBool(a[4]) || ((a[3] === 0) && a[4])) { return null; }
            return { type: 'mouse', args: [cx(a[1]), cy(a[2]), a[3], a[4]] };
        case 'wheel':
            if ((n !== 5) || !isInt(a[1], 0, maxX) || !isInt(a[2], 0, maxY) || !isInt(a[3], -255, 255) || (a[3] === 0) || !isBool(a[4])) { return null; }
            return { type: 'wheel', args: [cx(a[1]), cy(a[2]), a[3], a[4]] };
        case 'scancode':
            if ((n !== 3) || !(isInt(a[1], 0x01, 0x7F) || isInt(a[1], 0xE001, 0xE07F)) || !isBool(a[2])) { return null; }
            return { type: 'scancode', args: [a[1], a[2]] };
        case 'unicode':
            if ((n !== 3) || !isInt(a[1], 0x0001, 0xFFFF) || !isBool(a[2])) { return null; }
            return { type: 'unicode', args: [a[1], a[2]] };
        case 'utype':
            if ((n !== 2) || !isStr(a[1], LIMITS.UTYPE_MAX_CHARS)) { return null; }
            return { type: 'utype', args: [a[1]] };
        case 'sync':
            if ((n !== 2) || !isInt(a[1], 0, 15)) { return null; }
            return { type: 'sync', args: [a[1]] };
        case 'clipboard':
            if ((n !== 2) || (typeof a[1] != 'string') || (((a[1].length + 1) * 2) > LIMITS.CLIPBOARD_MAX_BYTES) || (a[1].indexOf('\u0000') >= 0)) { return null; }
            return { type: 'clipboard', args: [a[1]] };
        case 'resize':
            if ((n !== 3) || !isInt(a[1], LIMITS.DESKTOP_MIN_DIM, LIMITS.DESKTOP_MAX_DIM) || ((a[1] & 1) !== 0) || !isInt(a[2], LIMITS.DESKTOP_MIN_DIM, LIMITS.DESKTOP_MAX_DIM)) { return null; }
            return { type: 'resize', args: [a[1], a[2]] };
        case 'visibility':
            if ((n !== 2) || !isBool(a[1])) { return null; }
            return { type: 'visibility', args: [a[1]] };
        case 'gfx-ack':
            if ((n !== 3) || !isInt(a[1], 0, 0xFFFFFFFF) || !isInt(a[2], 0, 0xFFFFFFFE)) { return null; }
            return { type: 'gfx-ack', args: [a[1], a[2]] };
        case 'ack':
            if ((n !== 2) || !isInt(a[1], 0, Number.MAX_SAFE_INTEGER)) { return null; }
            return { type: 'ack', args: [a[1]] };
        case 'client-error':
            if ((n !== 2) || !CLIENT_ERROR_CODES.has(a[1])) { return null; }
            return { type: 'client-error', args: [a[1]] };
        case 'ping': case 'pong': case 'disconnect':
            return (n === 1) ? { type: a[0], args: [] } : null;
    }
    return null;
}

// Rights matrix (rdp/WIRE.md "Permissions"): true when the message may be forwarded
function allowed(level, m) {
    if (level === RIGHTS.FULL) { return true; }
    switch (m.type) {
        case 'mouse': case 'wheel': case 'sync': case 'resize': return (level === RIGHTS.LIMITED);
        case 'scancode': return (level === RIGHTS.LIMITED) && limitedScancodeAllowed(m.args[0]);
        case 'unicode': case 'utype': case 'clipboard': return false;
    }
    return true;    // visibility, ack, gfx-ack, client-error, ping, pong, disconnect
}

// Sliding one-second window with a ring of timestamps
function RateWindow(max) {
    const ts = new Array(max).fill(-Infinity);
    let head = 0;
    this.room = function (now) { return (now - ts[head]) >= 1000; };
    this.take = function (now) { ts[head] = now; head = (head + 1) % max; };
    this.nextRoom = function (now) { return Math.max(0, ts[head] + 1000 - now); };
}

// Per-websocket browser protocol. sink receives validated, permitted, rate-limited messages:
//   infos({ infos, credentials }), input(ev), typeText(text), clipboard(text), resize(w, h), visibility(v),
//   ack(total), gfxAck(frameId, queueDepth), ping(), pong(), disconnect(), fail(RdpError),
//   charge(delta) (optional: bytes of the pending clipboard held here; false when they cannot be charged)
// Before parsing: CLIENT_MESSAGES_PER_SECOND messages in total (WIRE.md "Validation"); AWAIT_INFOS messages ≤ INFOS_MSG_MAX_BYTES;
// later, messages above CLIENT_SMALL_MSG_MAX_BYTES only as '["clipboard",' / '["utype",' (and only with full control);
// CLIENT_BYTES_PER_SECOND in total.
// clock (tests): { now(), setTimeout(fn, ms), clearTimeout(t) }
function BrowserProtocol(sink, clock) {
    const self = this;
    clock = clock || { now: Date.now, setTimeout: setTimeout, clearTimeout: clearTimeout };
    let state = STATE.AWAIT_INFOS, level = RIGHTS.VIEWONLY, desktop = null, invalid = 0;
    const inputRate = new RateWindow(LIMITS.INPUT_MAX_EVENTS_PER_SECOND);
    const controlRate = new RateWindow(LIMITS.CONTROL_MAX_MESSAGES_PER_SECOND);
    let pendPointer = null, pendClipboard = null, pendResize = null, timer = null, pendCharge = 0;
    // Token bucket for browser bytes: CLIENT_BYTES_PER_SECOND capacity and refill rate, constant bookkeeping.
    // Every message costs at least MIN_MESSAGE_COST, also empty and ignored ones.
    let tokens = LIMITS.CLIENT_BYTES_PER_SECOND, tokensAt = null;
    // Token bucket for the number of messages (also acks, pings and ignored ones), checked before anything is parsed.
    // A message without a token is dropped; CLIENT_OVERRATE_MAX of them in a row (no refill to an eighth of the bucket in between) end the session.
    let msgTokens = LIMITS.CLIENT_MESSAGE_BURST, msgAt = null, overRate = 0, preActiveIgnored = 0;

    this.state = function () { return state; };
    this.setState = function (s) { state = s; if (s === STATE.CLOSING) { stop(); } };
    this.setRights = function (l) { level = l; };
    this.setDesktop = function (width, height) {
        if ((desktop != null) && ((desktop.width !== width) || (desktop.height !== height))) {
            desktop = { width: width, height: height, prevWidth: desktop.width, prevHeight: desktop.height, changedAt: clock.now() };
        } else if (desktop == null) { desktop = { width: width, height: height }; }
    };
    this.close = function () { state = STATE.CLOSING; stop(); };

    function stop() { if (timer != null) { clock.clearTimeout(timer); timer = null; } pendPointer = pendResize = null; setPendClipboard(null); }

    function setPendClipboard(t) {
        const n = (t == null) ? 0 : (2 * t.length);
        if (typeof sink.charge == 'function') {
            if (n > pendCharge) { if (sink.charge(n - pendCharge) === false) { pendClipboard = null; return; } }
            else if (n < pendCharge) { sink.charge(n - pendCharge); }
        }
        pendCharge = n;
        pendClipboard = t;
    }

    // true when this message fits the byte budget (and takes its cost)
    function byteBudget(n, now) {
        const cap = LIMITS.CLIENT_BYTES_PER_SECOND;
        if (tokensAt != null) { tokens = Math.min(cap, tokens + ((Math.max(0, now - tokensAt) * cap) / 1000)); }
        tokensAt = now;
        const cost = Math.max(n, MIN_MESSAGE_COST);
        if (cost > tokens) { return false; }
        tokens -= cost;
        return true;
    }

    // true when this message may be processed (and takes a token); false when it is dropped. fails the session on a sustained flood
    function messageBudget(now) {
        const burst = LIMITS.CLIENT_MESSAGE_BURST;
        if (msgAt != null) { msgTokens = Math.min(burst, msgTokens + ((Math.max(0, now - msgAt) * LIMITS.CLIENT_MESSAGES_PER_SECOND) / 1000)); }
        msgAt = now;
        if (msgTokens >= 1) {
            msgTokens -= 1;
            if (msgTokens >= (burst / 8)) { overRate = 0; }
            return true;
        }
        if (++overRate >= LIMITS.CLIENT_OVERRATE_MAX) { fail(E.RDP_ERROR_CLIENT_PROTOCOL); }
        return false;
    }

    function fail(code) { const s = state; self.close(); if (s !== STATE.CLOSING) { sink.fail(new RdpError(code)); } }

    // data, isBinary: as emitted by ws 8 ('message', data: Buffer, isBinary) or ws 7 ('message', data),
    // where a text message is a string and anything else is binary. Results go to the sink.
    this.handle = function (data, isBinary) {
        if (state === STATE.CLOSING) { return; }
        const binary = (typeof isBinary == 'boolean') ? isBinary : (typeof data != 'string');
        if (binary) { return fail(E.RDP_ERROR_CLIENT_PROTOCOL); }
        if (Array.isArray(data)) { data = Buffer.concat(data); }
        else if (data instanceof ArrayBuffer) { data = Buffer.from(data); }
        const size = data.length;      // bytes (Buffer) or UTF-16 units (string), both ≥ the number of characters
        const now = clock.now();
        if (!messageBudget(now)) { return; }                     // every message counts, also acks and ignored ones: no parsing without a token
        if (!byteBudget(size, now)) { return; }                  // every message counts, also ignored ones
        if (state === STATE.AWAIT_INFOS) {
            if (size > LIMITS.INFOS_MSG_MAX_BYTES) { return fail(E.RDP_ERROR_CLIENT_PROTOCOL); }
        } else if (size > LIMITS.CLIENT_SMALL_MSG_MAX_BYTES) {
            const head = (typeof data == 'string') ? data.slice(0, 16) : data.subarray(0, 16).toString('latin1');
            const large = head.startsWith('["clipboard",') || head.startsWith('["utype",');
            if ((state !== STATE.ACTIVE) || (large && (level !== RIGHTS.FULL))) {      // dropped before parsing
                if ((state !== STATE.ACTIVE) && (++preActiveIgnored >= LIMITS.CLIENT_PREACTIVE_IGNORED_MAX)) { fail(E.RDP_ERROR_CLIENT_PROTOCOL); }
                return;
            }
            if (!large) { if (++invalid >= LIMITS.CLIENT_INVALID_MAX) { fail(E.RDP_ERROR_CLIENT_PROTOCOL); } return; }
        }
        let msg = null;
        const text = (typeof data == 'string') ? data : data.toString('utf8');
        try { msg = JSON.parse(text); } catch (ex) { msg = null; }
        const m = validateMessage(msg, pointerBounds(desktop, now));
        switch (state) {
            case STATE.AWAIT_INFOS: {
                const v = ((m != null) && (m.type === 'infos')) ? validateInfos(m.args[0]) : null;
                if (v == null) { return fail(E.RDP_ERROR_CLIENT_PROTOCOL); }
                state = STATE.AUTHORIZING;
                return sink.infos(v);
            }
            case STATE.AUTHORIZING: case STATE.CONNECTING:
                if ((m == null) || ((m.type !== 'ping') && (m.type !== 'pong') && (m.type !== 'disconnect'))) {      // dropped, but not for ever
                    if (++preActiveIgnored >= LIMITS.CLIENT_PREACTIVE_IGNORED_MAX) { fail(E.RDP_ERROR_CLIENT_PROTOCOL); }
                    return;
                }
                return dispatch(m);
            case STATE.ACTIVE:
                if (m == null) { if (++invalid >= LIMITS.CLIENT_INVALID_MAX) { fail(E.RDP_ERROR_CLIENT_PROTOCOL); } return; }
                invalid = 0;
                if (m.type === 'infos') { return; }
                if (!allowed(level, m)) { return; }
                return dispatch(m);
        }
    };

    function dispatch(m) {
        const now = clock.now();
        flush(now);
        if (INPUT_TYPES.has(m.type)) {
            const ev = toInputEvent(m);
            if (!inputRate.room(now)) {
                // excess pointer moves are coalesced; any other excess input closes the session
                if (isPointerMove(ev)) { pendPointer = ev; arm(now); return; }
                return fail(E.RDP_ERROR_CLIENT_PROTOCOL);
            }
            if (pendPointer != null) {
                // a pointer move still waits for room: it goes first, so this event has no room
                if (isPointerMove(ev)) { pendPointer = ev; return; }
                return fail(E.RDP_ERROR_CLIENT_PROTOCOL);
            }
            inputRate.take(now);
            return sink.input(ev);
        }
        if (CONTROL_TYPES.has(m.type)) {
            if (!controlRate.room(now)) {
                if (m.type === 'clipboard') { setPendClipboard(m.args[0]); arm(now); }
                else if (m.type === 'resize') { pendResize = m.args; arm(now); }
                return;     // visibility, ping, pong: dropped
            }
            controlRate.take(now);
            return control(m.type, m.args);
        }
        switch (m.type) {
            case 'utype': return sink.typeText(m.args[0]);
            case 'ack': return sink.ack(m.args[0]);
            case 'gfx-ack': return sink.gfxAck(m.args[0], m.args[1]);
            case 'client-error': { const s = state; self.close(); if (s !== STATE.CLOSING) { sink.fail(new RdpError(E.RDP_ERROR_CLIENT_DECODE, { detail: m.args[0], hint: (m.args[0] === 'UNSUPPORTED') ? errors.hints.USE_LEGACY : undefined })); } return; }
            case 'disconnect': self.close(); return sink.disconnect();
        }
    }

    function control(type, args) {
        switch (type) {
            case 'clipboard': return sink.clipboard(args[0]);
            case 'resize': return sink.resize(args[0], args[1]);
            case 'visibility': return sink.visibility(args[0]);
            case 'ping': return sink.ping();
            case 'pong': return sink.pong();
        }
    }

    // Send pending (rate limited) messages while the windows have room, in arrival class order
    function flush(now) {
        if (state === STATE.CLOSING) { return; }
        if ((pendPointer != null) && inputRate.room(now)) { const ev = pendPointer; pendPointer = null; inputRate.take(now); sink.input(ev); }
        if ((pendResize != null) && controlRate.room(now)) { const r = pendResize; pendResize = null; controlRate.take(now); sink.resize(r[0], r[1]); }
        if ((pendClipboard != null) && controlRate.room(now)) { const t = pendClipboard; setPendClipboard(null); controlRate.take(now); sink.clipboard(t); }
    }

    function arm(now) {
        if (timer != null) { return; }
        const wait = Math.max(1, Math.min((pendPointer != null) ? inputRate.nextRoom(now) : Infinity, ((pendResize != null) || (pendClipboard != null)) ? controlRate.nextRoom(now) : Infinity));
        timer = clock.setTimeout(function () {
            timer = null;
            const t = clock.now();
            flush(t);
            if ((pendPointer != null) || (pendResize != null) || (pendClipboard != null)) { arm(t); }
        }, wait);
    }
}

function isPointerMove(ev) { return (ev.k === 'mouse') && (ev.button === 0); }

function toInputEvent(m) {
    const a = m.args;
    switch (m.type) {
        case 'mouse': return { k: 'mouse', x: a[0], y: a[1], button: a[2], down: a[3] };
        case 'wheel': return { k: 'wheel', x: a[0], y: a[1], delta: a[2], horizontal: a[3] };
        case 'scancode': return { k: 'scancode', code: a[0], down: a[1] };
        case 'unicode': return { k: 'unicode', unit: a[0], down: a[1] };
        case 'sync': return { k: 'sync', locks: a[0] };
    }
    return null;
}

module.exports = {
    STATE: STATE,
    RIGHTS: RIGHTS,
    rightsLevel: rightsLevel,
    limitedScancodeAllowed: limitedScancodeAllowed,
    localeToKeyboardLayout: localeToKeyboardLayout,
    validateInfos: validateInfos,
    validateMessage: validateMessage,
    pointerBounds: pointerBounds,
    buildConfig: buildConfig,
    allowed: allowed,
    BrowserProtocol: BrowserProtocol
};
