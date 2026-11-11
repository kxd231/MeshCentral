/**
 * @description MS-RDPEDISP client: Display Control dynamic virtual channel (Microsoft::Windows::RDS::DisplayControl).
 * Parses the server's DISPLAYCONTROL_CAPS_PDU and builds a single-monitor DISPLAYCONTROL_MONITOR_LAYOUT_PDU.
 * @license Apache-2.0
 *
 * Wire layouts: MS-RDPEDISP 2.2.1.1 (header), 2.2.2.1 (caps), 2.2.2.2 (monitor layout), 2.2.2.2.1 (monitor).
 * Cross-checked with FreeRDP 3.x channels/disp/client/disp_main.c (Apache-2.0, Copyright 2017 David Fort,
 * Thincast Technologies GmbH).
 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const { RdpError } = require('../protocol/errors.js');
const SHARED = require('../core/limits.js');

const DISP_NAME = 'Microsoft::Windows::RDS::DisplayControl';
const PDU = Object.freeze({ MONITOR_LAYOUT: 0x00000002, CAPS: 0x00000005 });
const MONITOR_PRIMARY = 0x00000001;
const MIN_DIM = 200;                // MS-RDPEDISP 2.2.2.2.1: 200..8192, width not odd
const MAX_DIM = 8192;
const MONITOR_BYTES = 40;
const HEADER_BYTES = 8;
const CAPS_BYTES = 20;
const MAX_MONITORS = 16;            // local supported range; caps outside it disable this optional channel
const MAX_FACTOR = 0xFFFF;          // anything larger cannot be a sane area factor
const LAYOUT_MAX_BYTES = HEADER_BYTES + 8 + MONITOR_BYTES;   // one monitor: 56
const DPI = 96;

function bad(detail = 'INVALID') { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: detail }); }

// DISPLAYCONTROL_CAPS_PDU: the server's limits. Returns { maxMonitors, maxArea } (area in pixels).
function parseCaps(bytes) {
    const r = new Reader(bytes);
    const type = r.u32le(), length = r.u32le();
    if ((type !== PDU.CAPS) || (length !== CAPS_BYTES) || (bytes.length !== CAPS_BYTES)) { bad(); }
    const maxMonitors = r.u32le(), a = r.u32le(), b = r.u32le();
    r.expectEnd();
    if ((maxMonitors < 1) || (maxMonitors > MAX_MONITORS) || (a < 1) || (b < 1) || (a > MAX_FACTOR) || (b > MAX_FACTOR)) { bad(); }
    return { maxMonitors: maxMonitors, maxArea: a * b * maxMonitors };
}

// Even width in [MIN_DIM, MAX_DIM] and height in the same range; when the server's area limit is smaller,
// both are scaled down keeping the aspect ratio. Returns null when no valid size fits.
function fit(width, height, maxArea, evenHeight = false) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) { return null; }
    const lo = MIN_DIM, hi = Math.min(MAX_DIM, SHARED.DESKTOP_MAX_DIM);
    let w = Math.min(hi, Math.max(lo, Math.floor(width))), h = Math.min(hi, Math.max(lo, Math.floor(height)));
    w -= (w & 1);
    if (maxArea > 0 && (w * h) > maxArea) {
        const k = Math.sqrt(maxArea / (w * h));
        w = Math.max(lo, Math.floor(w * k)); w -= (w & 1);
        h = Math.max(lo, Math.floor(h * k));
    }
    if (evenHeight) h -= (h & 1);
    if ((maxArea > 0 && (w * h) > maxArea) || ((w * h) > SHARED.SURFACES_MAX_PIXELS)) { return null; }
    return { width: w, height: h };
}

function physical(px) { return Math.min(10000, Math.max(10, Math.round((px * 25.4) / DPI))); }

// DISPLAYCONTROL_MONITOR_LAYOUT_PDU with one primary monitor at (0,0), 100% scaling
function monitorLayout(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width < MIN_DIM) || (height < MIN_DIM) || (width > MAX_DIM) || (height > MAX_DIM) || (width & 1)) {
        throw new RdpError('RDP_ERROR_INTERNAL');
    }
    return new Writer(LAYOUT_MAX_BYTES, LAYOUT_MAX_BYTES)
        .u32le(PDU.MONITOR_LAYOUT).u32le(LAYOUT_MAX_BYTES)
        .u32le(MONITOR_BYTES).u32le(1)
        .u32le(MONITOR_PRIMARY).u32le(0).u32le(0).u32le(width).u32le(height)
        .u32le(physical(width)).u32le(physical(height))
        .u32le(0)           // Orientation: landscape
        .u32le(100)         // DesktopScaleFactor
        .u32le(100)         // DeviceScaleFactor
        .toBytes();
}

// Channel endpoint. send(bytes) writes one DVC message; onCaps(caps) is called once, when the server's caps arrive.
class DisplayControl {
    constructor(send, onCaps, onDisabled = () => {}, evenHeight = false) {
        this.send = send; this.onCaps = onCaps; this.onDisabled = onDisabled; this.evenHeight = evenHeight;
        this.caps = null; this.closed = false;
    }
    get ready() { return this.caps !== null && !this.closed; }
    receive(bytes) {
        if (this.closed) return;
        // Display Control is optional. Invalid framing or unsupported caps disable this endpoint, not the session.
        try {
            const r = new Reader(bytes);
            const type = r.u32le(), length = r.u32le();
            if ((length !== bytes.length) || (length < HEADER_BYTES)) bad();
            if (type !== PDU.CAPS) return;
            if (this.caps) bad();
            this.caps = parseCaps(bytes);
        } catch (e) {
            if (!(e instanceof RdpError) || e.code !== 'RDP_ERROR_PROTOCOL') throw e;
            this.close(); this.onDisabled(); return;
        }
        this.onCaps(this.caps);
    }

    // The size that would be requested for (width, height), or null
    fit(width, height) { return this.caps ? fit(width, height, this.caps.maxArea, this.evenHeight) : null; }
    layout(width, height) { if (this.ready) { this.send(monitorLayout(width, height)); } }
    close() { this.closed = true; }
}

module.exports = Object.freeze({ DISP_NAME, PDU, DisplayControl, parseCaps, fit, monitorLayout, MIN_DIM, MAX_DIM });
