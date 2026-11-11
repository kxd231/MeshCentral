/**
 * @description MS-RDPECLIP text-only clipboard, long format names, coalesced requests
 * @license Apache-2.0
 */
'use strict';
const { Reader, Writer } = require('../core/stream.js');
const L = require('../core/limits.js');
const { RdpError } = require('../protocol/errors.js');
function bad() {
    throw new RdpError('RDP_ERROR_PROTOCOL', { detail: 'INVALID' });
}
function packet(type, flags, bytes) {
    return new Writer(256, L.SVC_MAX_MESSAGE_BYTES)
        .u16le(type)
        .u16le(flags)
        .u32le(bytes.length)
        .bytes(bytes)
        .toBytes();
}
function encodeText(text) {
    text = text.split('\0', 1)[0];
    if ((text.length + 1) * 2 > L.CLIPBOARD_MAX_BYTES) {
        throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
    }
    const w = new Writer(256, L.CLIPBOARD_MAX_BYTES);
    for (let i = 0; i < text.length; i++) {
        w.u16le(text.charCodeAt(i));
    }
    return w.u16le(0).toBytes();
}
// FORMAT_DATA_RESPONSE with the clipboard text, built into one exact-size buffer (no Writer doubling, no second copy). The size is
// reserved before the buffer is allocated ("reserve before allocate"); the reservation is handed back at once because the
// write queue (connection.enqueue) reserves the same bytes when it takes the packet. text has no NUL (localText).
function textResponse(text, reserve, release) {
    const n = (text.length + 1) * 2, total = 8 + n;
    if (n > L.CLIPBOARD_MAX_BYTES) {
        throw new RdpError('RDP_ERROR_RESOURCE_LIMIT', { detail: 'LIMIT' });
    }
    if (reserve) reserve(total);
    let b;
    try {
        b = new Uint8Array(total);
    } finally {
        if (release) release(total);
    }
    const v = new DataView(b.buffer);
    v.setUint16(0, 5, true);
    v.setUint16(2, 1, true);
    v.setUint32(4, n, true);
    for (let i = 0; i < text.length; i++) v.setUint16(8 + 2 * i, text.charCodeAt(i), true);
    return b;
}
function decodeText(bytes) {
    if (bytes.length & 1 || bytes.length > L.CLIPBOARD_MAX_BYTES) {
        bad();
    }
    const r = new Reader(bytes),
        parts = [];
    let units = [];
    while (r.remaining) {
        const u = r.u16le();
        if (u === 0) {
            parts.push(String.fromCharCode(...units));
            return parts.join('');
        }
        units.push(u);
        if (units.length === 4096) {
            parts.push(String.fromCharCode(...units));
            units = [];
        }
    }
    parts.push(String.fromCharCode(...units));
    return parts.join('');
}
// A Format Data Request the server never answered (xrdp stays silent for text of about 1 MiB and more) must not end the remote to local
// clipboard for the rest of the session: a newer Format List after this time asks again (a list inside the window is remembered and
// acted on when the window ends). CLIPRDR has no request id and the channel is FIFO, so a late answer to the abandoned request arrives
// first and is taken for the answer of the new one. To end on fresh data, the answer that follows an abandoned request is delivered
// and one more request is sent (afterStale); an answer that arrives with no request pending is ignored (nothing is cleared).
const REQUEST_STALE_MS = 15000;
const monotonic = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
class Clipboard {
    constructor(send, receive, reserve, release, now) {
        this.now = now || monotonic;
        this.requestAt = 0;
        this.afterStale = false;
        this.staleTimer = null;
        this.send = send;
        this.receive = receive;
        this.reserve = reserve || null;
        this.release = release || null;
        this.ready = false;
        this.long = false;
        this.local = '';
        this.advertised = '';
        this.listPending = false;
        this.localDirty = false;
        this.requestPending = false;
        this.remoteAgain = false;
    }
    close() {
        this.local = '';
        this.advertised = '';
        this.closed = true;
        this.clearStaleTimer();
    }
    clearStaleTimer() {
        if (this.staleTimer !== null) {
            clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
    }
    // A Format List that came while the request was pending, and the server stayed silent until the window ended
    staleCheck() {
        this.staleTimer = null;
        if (this.closed || !this.requestPending || !this.remoteAgain) return;
        if (this.now() - this.requestAt < REQUEST_STALE_MS) return;
        this.request();
    }
    localText(text) {
        text = text.split('\0', 1)[0];
        if ((text.length + 1) * 2 > L.CLIPBOARD_MAX_BYTES) return;
        this.local = text;
        this.localDirty = true;
        this.advertise();
    }
    advertise() {
        if (!this.ready || this.listPending || !this.localDirty) {
            return;
        }
        this.localDirty = false;
        this.advertised = this.local;
        this.listPending = true;
        this.send(
            packet(
                2,
                0,
                this.advertised.length
                    ? new Writer()
                          .u32le(13)
                          .zeros(this.long ? 2 : 32)
                          .toBytes()
                    : new Uint8Array(),
            ),
        );
    }
    request() {
        if (this.requestPending) {
            const wait = REQUEST_STALE_MS - (this.now() - this.requestAt);
            if (wait > 0) {
                this.remoteAgain = true;
                if (this.staleTimer === null && !this.closed) {
                    this.staleTimer = setTimeout(() => this.staleCheck(), wait + 50);
                    if (this.staleTimer.unref) this.staleTimer.unref();
                }
                return;
            }
            this.remoteAgain = false;
            this.afterStale = true;
        }
        this.clearStaleTimer();
        this.requestPending = true;
        this.requestAt = this.now();
        this.send(packet(4, 0, new Writer().u32le(13).toBytes()));
    }
    discardMessage() {
        // Treat an oversized/malformed remote transfer like FORMAT_DATA_RESPONSE FAIL.
        this.requestPending = false;
        this.remoteAgain = false;
        this.afterStale = false;
        this.clearStaleTimer();
    }
    receiveMessage(bytes) {
        try {
            this.parseMessage(bytes);
        } catch (e) {
            if (!(e instanceof RdpError) || e.code !== 'RDP_ERROR_PROTOCOL') throw e;
            this.discardMessage();
            this.listPending = false;
        }
    }
    parseMessage(bytes) {
        const r = new Reader(bytes),
            type = r.u16le(),
            flags = r.u16le(),
            n = r.u32le(),
            v = r.sub(n);
        // xrdp 0.10.1 appends a zero DWORD outside dataLen (clipboard.c). Bound this
        // compatibility padding explicitly; the PDU body still ends at dataLen.
        if (r.remaining === 4) {
            if (r.u32le() !== 0) bad();
        }
        r.expectEnd();
        if (type === 7) {
            const count = v.u16le();
            v.skip(2);
            if (count > 16) {
                bad();
            }
            let general = false;
            for (let i = 0; i < count; i++) {
                const ct = v.u16le(),
                    len = v.u16le();
                if (len < 4) {
                    bad();
                }
                const cap = v.sub(len - 4);
                if (ct === 1) {
                    if (general || len !== 12) {
                        bad();
                    }
                    general = true;
                    const version = cap.u32le(),
                        f = cap.u32le();
                    if (version < 1 || version > 2) {
                        bad();
                    }
                    this.long = !!(f & 2);
                }
            }
            v.expectEnd();
            return;
        }
        if (type === 1) {
            if (flags !== 0 || n !== 0 || this.ready) {
                bad();
            }
            this.ready = true;
            this.send(
                packet(7, 0, new Writer().u16le(1).u16le(0).u16le(1).u16le(12).u32le(2).u32le(2).toBytes()),
            );
            this.localDirty = true;
            this.advertise();
            return;
        }
        if (type === 2) {
            if (flags & ~4) {
                bad();
            }
            let unicode = false,
                count = 0;
            while (v.remaining) {
                if (++count > 1024) {
                    bad();
                }
                const id = v.u32le();
                unicode = unicode || id === 13;
                if (this.long) {
                    let units = 0;
                    while (v.u16le() !== 0) {
                        if (++units > 255) {
                            bad();
                        }
                    }
                } else {
                    v.skip(32);
                }
            }
            this.send(packet(3, 1, new Uint8Array(0)));
            if (unicode) {
                this.request();
            }
            return;
        }
        if (type === 3) {
            if (n !== 0 || !this.listPending || (flags !== 1 && flags !== 2)) {
                bad();
            }
            this.listPending = false;
            this.advertise();
            return;
        }
        if (type === 4) {
            if (flags !== 0 || n !== 4) {
                bad();
            }
            const id = v.u32le();
            this.send(id === 13 ? textResponse(this.advertised, this.reserve, this.release) : packet(5, 2, new Uint8Array(0)));
            return;
        }
        if (type === 5) {
            if (!this.requestPending) {
                return; // the late answer of a request given up earlier, already replaced: nothing to deliver, no state to touch
            }
            if (flags !== 1 && flags !== 2) {
                bad();
            }
            this.requestPending = false;
            this.clearStaleTimer();
            if (this.afterStale) {
                this.afterStale = false;
                this.remoteAgain = true; // this answer may belong to the abandoned request: ask once more, the last text delivered is fresh
            }
            if (flags === 1) {
                this.receive(decodeText(v.rest()));
            } else if (v.remaining) {
                bad();
            }
            if (this.remoteAgain) {
                this.remoteAgain = false;
                this.request();
            }
            return;
        }
        bad(); // No file copy, locking or temporary directory capabilities advertised.
    }
}
module.exports = Object.freeze({ packet, encodeText, textResponse, decodeText, Clipboard, REQUEST_STALE_MS });
