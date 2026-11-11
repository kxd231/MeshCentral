/** @description Fast-path output fragments and input events. @license Apache-2.0 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('./errors.js');
const caps = require('./caps.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'UNSUPPORTED' });
}
class Output {
    constructor(io, output) {
        this.io = io;
        this.output = output;
        this.buffer = null;
        this.length = 0;
        this.code = null;
    }
    close() {
        if (this.buffer) {
            this.io.release(this.buffer.length);
        }
        this.buffer = null;
        this.length = 0;
        this.code = null;
    }
    *parse(bytes) {
        const r = new Reader(bytes),
            h = r.u8(),
            l = r.u8(),
            n = l & 128 ? ((l & 127) << 8) | r.u8() : l;
        if (h !== 0 || n !== bytes.length || n > L.FASTPATH_MAX_BYTES) {
            bad();
        }
        while (r.remaining) {
            const header = r.u8(),
                code = header & 15,
                fragment = (header >>> 4) & 3,
                compression = header >>> 6;
            if (compression === 2) {
                if (r.u8() !== 0) {
                    bad();
                }
            } else if (compression !== 0) {
                bad();
            }
            const data = r.bytes(r.u16le());
            if (fragment === 0) {
                if (this.code !== null) {
                    bad();
                }
                yield* this.update(code, data);
                continue;
            }
            if (fragment === 2) {
                if (this.code !== null) {
                    bad();
                }
                this.code = code;
            } else if (this.code !== code) {
                bad();
            }
            if (
                this.length + data.length > L.FASTPATH_REASSEMBLY_MAX_BYTES ||
                this.length + data.length > L.REASSEMBLY_MAX_BYTES
            ) {
                throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
            }
            if (!data.length) {
                bad();
            }
            const need = this.length + data.length;
            if (!this.buffer || this.buffer.length < need) {
                const capacity = Math.min(
                    L.FASTPATH_REASSEMBLY_MAX_BYTES,
                    Math.max(4096, need, this.buffer ? this.buffer.length * 2 : 0),
                );
                this.io.reserve(capacity);
                let next;
                try {
                    next = new Uint8Array(capacity);
                    if (this.buffer) next.set(this.buffer.subarray(0, this.length));
                } catch (e) {
                    this.io.release(capacity);
                    throw e;
                }
                if (this.buffer) this.io.release(this.buffer.length);
                this.buffer = next;
            }
            this.buffer.set(data, this.length);
            this.length = need;
            if (fragment === 1) {
                try {
                    yield* this.update(code, this.buffer.subarray(0, this.length));
                } finally {
                    this.close();
                }
            }
        }
    }
    *update(code, bytes) {
        if (code === 1 || code === 2) {
            const r = new Reader(bytes);
            if (r.u16le() !== code) bad();
            yield* this.output.update(bytes);
            return;
        }
        if (code === 4) {
            yield* this.output.surfaceCommands(bytes, caps.RFX_CODEC_ID);
            return;
        }
        const r = new Reader(bytes);
        if (code === 3) {
            r.expectEnd();
            return null;
        }
        const kind = {
            5: 'hidden',
            6: 'default',
            8: 'position',
            9: 'color',
            10: 'cached',
            11: 'new',
            12: 'large',
        }[code];
        if (!kind) {
            bad();
        }
        yield this.output.pointer(kind, r);
    }
}
function event(ev) {
    const w = new Writer();
    if (ev.k === 'scancode') {
        w.u8((ev.down ? 0 : 1) | (ev.code > 127 ? 2 : 0)).u8(ev.code & 127);
    } else if (ev.k === 'unicode') {
        w.u8(0x80 | (ev.down ? 0 : 1)).u16le(ev.unit);
    } else if (ev.k === 'sync') {
        w.u8(0x60 | ev.locks);
    } else if (ev.k === 'mouse' || ev.k === 'wheel') {
        let flags = 0,
            extended = false;
        if (ev.k === 'wheel') {
            flags = (ev.horizontal ? 0x400 : 0x200) | (ev.delta < 0 ? 0x100 : 0) | (ev.delta & 255);
        } else if (!ev.button) {
            flags = 0x800;
        } else if (ev.button <= 3) {
            flags = [0, 0x1000, 0x2000, 0x4000][ev.button] | (ev.down ? 0x8000 : 0);
        } else {
            extended = true;
            flags = (ev.button === 4 ? 1 : 2) | (ev.down ? 0x8000 : 0);
        }
        w.u8(extended ? 0x40 : 0x20)
            .u16le(flags)
            .u16le(ev.x)
            .u16le(ev.y);
    } else {
        bad();
    }
    return w.toBytes();
}
function input(ev) {
    const e = event(ev);
    return new Writer()
        .u8(4)
        .u8(e.length + 2)
        .bytes(e)
        .toBytes();
}
// Slow-path fallback for servers without fast-path input.
function slowInput(ev) {
    const e = new Reader(event(ev)),
        h = e.u8(),
        code = h >>> 5,
        w = new Writer().u16le(1).u16le(0).u32le(0);
    if (code === 0) {
        w.u16le(4)
            .u16le((h & 1 ? 0x8000 : 0) | (h & 2 ? 0x100 : 0))
            .u16le(e.u8())
            .u16le(0);
    } else if (code === 4) {
        w.u16le(5)
            .u16le(h & 1 ? 0x8000 : 0)
            .u16le(e.u16le())
            .u16le(0);
    } else if (code === 3) {
        w.u16le(0)
            .u16le(0)
            .u32le(h & 31);
    } else {
        w.u16le(code === 2 ? 0x8002 : 0x8001).bytes(e.rest());
    }
    return w.toBytes();
}
module.exports = Object.freeze({ Output, event, input, slowInput });
