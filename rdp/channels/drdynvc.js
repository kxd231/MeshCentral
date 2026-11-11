/** @description MS-RDPEDYC client: v1/v2 transport, v3 capability parsing, bounded DVC reassembly. @license Apache-2.0 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('../protocol/errors.js');
const { useLegacy } = require('../gfx/errors.js');
const GFX_NAME = 'Microsoft::Windows::RDS::Graphics';
const DISP_NAME = 'Microsoft::Windows::RDS::DisplayControl';
function bad() { throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' }); }
function limit() { throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' }); }
function uint(r, size) {
    if (size === 0) return r.u8();
    if (size === 1) return r.u16le();
    if (size === 2) return r.u32le();
    bad();
}
function idHeader(cmd, id) {
    const size = id <= 255 ? 0 : id <= 65535 ? 1 : 2;
    const w = new Writer().u8(cmd << 4 | size);
    if (size === 0) w.u8(id); else if (size === 1) w.u16le(id); else w.u32le(id);
    return w;
}
class DynamicChannels {
    // budget is the connection's shared SVC/fast-path/DVC reassembly budget.
    // openGraphics / openDisplay: (send) => endpoint, or null when that channel is not offered (failure HRESULT to the server).
    // canReopenGraphics(): after the server closed the graphics channel, may it create it again (a restart around a resize)?
    constructor(budget, send, openGraphics, openDisplay = null, canReopenGraphics = () => false, debug = () => {}) {
        this.debug = debug; this.lastUnknownLog = -Infinity;
        this.budget = budget; this.send = send;
        // One listener per name; each opens at most once per RDP session.
        this.listeners = new Map();
        if (openGraphics) this.listeners.set(GFX_NAME, { open: openGraphics, opened: false, reopen: canReopenGraphics });
        if (openDisplay) this.listeners.set(DISP_NAME, { open: openDisplay, opened: false, reopen: true });
        this.version = 0; this.channels = new Map(); this.closed = false; this.reassembly = 0;
    }
    receive(bytes) {
        const context = { gfx: false };
        try { return this.receiveMessage(bytes, context); }
        catch (e) { throw context.gfx ? useLegacy(e) : e; }
    }
    receiveMessage(bytes, context) {
        if (this.closed) bad();
        const r = new Reader(bytes), h = r.u8(), cmd = h >>> 4, cb = h & 3, sp = h >>> 2 & 3;
        if (cmd === 5) {
            if (this.version || cb || r.u8() !== 0) bad();
            const v = r.u16le(); if (v < 1 || v > 3) bad();
            if (v >= 2) for (let i = 0; i < 4; i++) r.u16le(); // priority charges, no scheduler needed
            r.expectEnd();
            // DVC compression is optional in v3. Negotiate v2 so commands 6/7 cannot be used.
            this.version = Math.min(v, 2);
            this.send(new Writer().u8(0x50).u8(0).u16le(this.version).toBytes()); return;
        }
        if (!this.version) bad();
        const id = uint(r, cb);
        context.gfx = this.channels.get(id)?.gfx === true;
        if (cmd === 6 || cmd === 7) bad();
        if (cmd === 1) {
            if (this.channels.has(id)) bad();
            const name = r.rest();
            if (!name.length || name.length > 512 || name[name.length - 1] !== 0) bad();
            let text = '';
            for (let i = 0; i < name.length - 1; i++) {
                if (!name[i] || name[i] > 127) bad();
                text += String.fromCharCode(name[i]);
            }
            // Unsupported listeners get a failure HRESULT (NO_LISTENER); a name is served once per session.
            context.gfx = text === GFX_NAME;
            const listener = this.listeners.get(text);
            const accept = !!listener && !listener.opened;
            if (this.channels.size >= L.DVC_MAX_CHANNELS) limit();
            const response = idHeader(1, id).u32le(accept ? 0 : 0xc0000001).toBytes();
            this.send(response);
            if (accept) {
                listener.opened = true;
                const c = { endpoint: null, buffer: null, offset: 0, listener, gfx: context.gfx };
                this.channels.set(id, c);
                c.endpoint = listener.open(b => this.sendData(id, b));
            }
            return;
        }
        const c = this.channels.get(id);
        if (!c) {
            if (cmd === 2) uint(r, sp); // Parse the bounded length field, but never reserve/reassemble unknown data.
            else if (cmd === 4) r.expectEnd();
            else if (cmd !== 3) bad();
            // FreeRDP drdynvc_process_{data_first,data,close_request} (Apache-2.0): ignore unknown/refused IDs, without a reply.
            const now = Date.now();
            if (now - this.lastUnknownLog >= 1000) {
                this.lastUnknownLog = now; this.debug('Ignoring DVC message for an unknown channel');
            }
            return;
        }
        if (cmd === 4) {
            r.expectEnd();
            const endpoint = c.endpoint; this.dispose(c); this.channels.delete(id);
            // Peer shutdown applies the connection's bounded resize restart policy.
            if (endpoint && endpoint.peerClose) endpoint.peerClose();
            // Display Control is stateless and may be created again; the graphics pipeline only when the connection allows a restart
            if (c.listener && (typeof c.listener.reopen === 'function' ? c.listener.reopen() : c.listener.reopen)) c.listener.opened = false;
            this.send(idHeader(4, id).toBytes()); return;
        }
        if (cmd !== 2 && cmd !== 3) bad();
        if (cmd === 2) {
            if (c.buffer) bad();
            const total = uint(r, sp);
            if (!total || total < r.remaining) bad(); // 2.2.3.1 permits a complete message in DATA_FIRST
            if (total > L.DVC_MAX_MESSAGE_BYTES || total + this.reassembly > L.REASSEMBLY_MAX_BYTES) limit();
            this.budget.reserve(total);
            try { c.buffer = new Uint8Array(total); } catch (e) { this.budget.release(total); throw e; }
            this.reassembly += total; c.offset = 0;
        }
        if (c.buffer) {
            const count = r.remaining; if (!count || count > c.buffer.length - c.offset) bad();
            c.buffer.set(r.rest(), c.offset); c.offset += count;
            if (c.offset === c.buffer.length) {
                const b = c.buffer;
                try { c.endpoint.receive(b); } finally { this.free(c); }
            }
        } else {
            if (r.remaining > L.DVC_MAX_MESSAGE_BYTES) limit();
            if (!r.remaining) bad();
            c.endpoint.receive(r.rest());
        }
    }
    sendData(id, bytes) {
        try { return this.sendMessage(id, bytes); }
        catch (e) { throw this.channels.get(id)?.gfx === true ? useLegacy(e) : e; }
    }
    sendMessage(id, bytes) {
        if (this.closed || !this.channels.has(id)) return;
        if (bytes.length > L.DVC_MAX_MESSAGE_BYTES) limit();
        // Client PDUs (capabilities / ACK) are small. Bound each SVC message to 1600 bytes.
        let offset = 0;
        while (offset < bytes.length) {
            const first = offset === 0 && bytes.length > 1590;
            const w = idHeader(first ? 2 : 3, id);
            if (first) { w.buf[0] |= 2 << 2; w.u32le(bytes.length); }
            const count = Math.min(1600 - w.length, bytes.length - offset);
            this.send(w.bytes(bytes.subarray(offset, offset + count)).toBytes()); offset += count;
        }
    }
    free(c) {
        if (c.buffer) { const n = c.buffer.length; c.buffer = null; c.offset = 0; this.reassembly -= n; this.budget.release(n); }
    }
    dispose(c) { this.free(c); if (c.endpoint) { c.endpoint.close(); c.endpoint = null; } }
    close() {
        if (this.closed) return; this.closed = true;
        for (const c of this.channels.values()) this.dispose(c);
        this.channels.clear();
    }
}
module.exports = Object.freeze({ DynamicChannels, GFX_NAME, DISP_NAME });
