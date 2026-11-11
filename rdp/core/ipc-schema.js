/**
* @description Web-RDP IPC field validators shared by the main process (rdp/client.js) and the engine
* (rdp/engine.js): start.config and input events (rdp/IPC.md). Pure functions, no I/O.
* @license Apache-2.0
*/
'use strict';

const limits = require('./limits.js');
const constants = require('../../public/rdp/shared/constants.js');

const CAPSET_IDS = constants.GFX_CAPSETS_ALLOWED.map(function (c) { return c.id; });
const SECURITY = ['auto', 'nla'];
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const SURFACE_CODECS = ['rfx'];     // legacy Surface Commands codecs the engine may advertise (NSCodec is not offered yet)

function isInt(v, min, max) { return Number.isSafeInteger(v) && (v >= min) && (v <= max); }
function isU32(v) { return isInt(v, 0, 0xFFFFFFFF); }
function isStr(v, max) { return (typeof v == 'string') && (v.length <= max) && (v.indexOf('\u0000') < 0); }
function isBool(v) { return typeof v == 'boolean'; }
function isObj(v) { return (v != null) && (typeof v == 'object') && !Array.isArray(v); }

// start.config.trust (rdp/IPC.md): the pinned certificate (uppercase SHA-256 fingerprint or null) and the NLA floor
function trust(t) {
    return isObj(t) && ((t.fingerprint256 === null) || ((typeof t.fingerprint256 == 'string') && FINGERPRINT.test(t.fingerprint256))) && isBool(t.nlaSeen);
}

// start.config: returns a clean copy (known fields only) or null
function config(c) {
    const ok = isObj(c) &&
        isInt(c.width, limits.DESKTOP_MIN_DIM, limits.DESKTOP_MAX_DIM) && ((c.width & 1) === 0) &&
        isInt(c.height, limits.DESKTOP_MIN_DIM, limits.DESKTOP_MAX_DIM) &&
        ((c.mode === 'legacy') || (c.mode === 'gfx')) &&
        Array.isArray(c.gfxCapsets) && c.gfxCapsets.every(function (id, i) { return (CAPSET_IDS.indexOf(id) >= 0) && (c.gfxCapsets.indexOf(id) === i); }) &&
        ([15, 16, 24, 32].indexOf(c.colorDepth) >= 0) &&
        isInt(c.perfFlags, 0, 0x1FF) && (c.connectionType === 'lan') && isU32(c.keyboardLayout) &&
        isStr(c.clientName, 15) && isStr(c.serverName, 255) && (SECURITY.indexOf(c.security) >= 0) &&
        isStr(c.alternateShell, limits.INFO_FIELD_MAX_CHARS) && isStr(c.workingDir, limits.INFO_FIELD_MAX_CHARS) &&
        isBool(c.debug) &&
        (c.trust === undefined || trust(c.trust)) &&
        (c.displayControl === undefined || isBool(c.displayControl)) &&
        (c.displayControlEvenHeight === undefined || isBool(c.displayControlEvenHeight)) &&
        ((c.surfaceCodecs === undefined) || (Array.isArray(c.surfaceCodecs) && c.surfaceCodecs.every(function (id, i) { return (SURFACE_CODECS.indexOf(id) >= 0) && (c.surfaceCodecs.indexOf(id) === i); })));
    if (!ok) { return null; }
    if (c.surfaceCodecs && c.surfaceCodecs.length && (c.mode !== 'legacy' || c.colorDepth !== 32)) { return null; }
    return {
        width: c.width, height: c.height, mode: c.mode, gfxCapsets: c.gfxCapsets.slice(), colorDepth: c.colorDepth,
        perfFlags: c.perfFlags, connectionType: c.connectionType, keyboardLayout: c.keyboardLayout, clientName: c.clientName,
        serverName: c.serverName, security: c.security, alternateShell: c.alternateShell, workingDir: c.workingDir, debug: c.debug,
        displayControl: c.displayControl !== false, displayControlEvenHeight: c.displayControlEvenHeight === true,
        surfaceCodecs: (c.surfaceCodecs === undefined) ? [] : c.surfaceCodecs.slice(),
        trust: (c.trust === undefined) ? { fingerprint256: null, nlaSeen: false } : { fingerprint256: c.trust.fingerprint256, nlaSeen: c.trust.nlaSeen }
    };
}

// input.ev (rdp/IPC.md): every field present with its type and range. Coordinates are bounded by the
// protocol maximum here; the main process checks them against the current desktop.
function inputEvent(ev) {
    if (!isObj(ev)) { return false; }
    const max = limits.DESKTOP_MAX_DIM - 1;
    switch (ev.k) {
        case 'mouse': return isInt(ev.x, 0, max) && isInt(ev.y, 0, max) && isInt(ev.button, 0, 5) && isBool(ev.down) && !((ev.button === 0) && ev.down);
        case 'wheel': return isInt(ev.x, 0, max) && isInt(ev.y, 0, max) && isInt(ev.delta, -255, 255) && (ev.delta !== 0) && isBool(ev.horizontal);
        case 'scancode': return (isInt(ev.code, 0x01, 0x7F) || isInt(ev.code, 0xE001, 0xE07F)) && isBool(ev.down);
        case 'unicode': return isInt(ev.unit, 0x0001, 0xFFFF) && isBool(ev.down);
        case 'sync': return isInt(ev.locks, 0, 15);
    }
    return false;
}

module.exports = Object.freeze({ config: config, trust: trust, FINGERPRINT: FINGERPRINT, inputEvent: inputEvent, isInt: isInt, isU32: isU32, isStr: isStr });
