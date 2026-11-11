/** @description Static virtual channel chunking and bounded per-channel reassembly. @license Apache-2.0 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('../protocol/errors.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
}
// extraFlags: 0x10 (CHANNEL_FLAG_SHOW_PROTOCOL) only for a channel whose peer expects it (cliprdr); see sendSvc in connection.js
function* chunks(bytes, size = 1600, extraFlags = 0) {
    if (bytes.length > L.SVC_MAX_MESSAGE_BYTES || size < 1 || size > 1600) {
        throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
    }
    for (let p = 0; p < bytes.length || p === 0; p += size) {
        const n = Math.min(size, bytes.length - p),
            flags = (p === 0 ? 1 : 0) | (p + n === bytes.length ? 2 : 0) | extraFlags;
        yield new Writer()
            .u32le(bytes.length)
            .u32le(flags)
            .bytes(bytes.subarray(p, p + n))
            .toBytes();
    }
}
class Channel {
    constructor(io, onMessage, onDiscard = null) {
        this.io = io;
        this.onMessage = onMessage;
        this.onDiscard = onDiscard;
        this.discarding = false;
        this.buffer = null;
        this.offset = 0;
    }
    close() {
        if (this.buffer) {
            this.io.release(this.buffer.length);
            this.buffer = null;
        }
        this.offset = 0;
        this.discarding = false;
    }
    receive(bytes) {
        const r = new Reader(bytes),
            total = r.u32le(),
            flags = r.u32le();
        // MS-RDPBCGR CHANNEL_FLAG_SUSPEND/RESUME: ignore control packets.
        if (flags & 0x60) return;
        if (flags & ~0x13) bad();
        if (this.discarding) {
            if (flags & 2) {
                this.close();
                this.onDiscard();
            }
            return;
        }
        if (total > L.SVC_MAX_MESSAGE_BYTES && this.onDiscard) {
            this.close();
            this.discarding = !(flags & 2);
            if (!this.discarding) this.onDiscard();
            return;
        }
        if (total > L.SVC_MAX_MESSAGE_BYTES) {
            throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
        }
        if (flags & 1) {
            if (this.buffer) {
                bad();
            }
            this.io.reserve(total);
            try {
                this.buffer = new Uint8Array(total);
            } catch (e) {
                this.io.release(total);
                throw e;
            }
            this.offset = 0;
        }
        if (!this.buffer || total !== this.buffer.length || r.remaining > total - this.offset) {
            bad();
        }
        this.buffer.set(r.rest(), this.offset);
        this.offset += bytes.length - 8;
        if (flags & 2) {
            if (this.offset !== total) {
                bad();
            }
            const data = this.buffer;
            try {
                this.onMessage(data);
            } finally {
                this.close();
            }
        } else if (this.offset === total) {
            bad();
        }
    }
}
module.exports = Object.freeze({ chunks, Channel });
