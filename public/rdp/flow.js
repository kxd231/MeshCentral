/**
* @description Web-RDP browser flow control: byte counters, ack policy, pending-byte guard, control message pacing
* @license Apache-2.0
*
* Implements the browser side of "Flow control" in rdp/WIRE.md. No DOM and no globals: timers are
* injected so the logic is tested in Node with a fake clock.
* Usable from Node (require) and from a page or worker (self.RdpClient.flow).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(require('./shared/limits.js')); }
    else { root.RdpClient = root.RdpClient || {}; root.RdpClient.flow = factory(root.RdpShared.limits); }
})((typeof self !== 'undefined') ? self : this, function (limits) {
    'use strict';

    // Counters and ack schedule of the worker.
    //   received  total bytes of binary frames handed to the worker (cumulative, UI thread count)
    //   processed total bytes of frames whose every operation has been applied
    // ['ack', processed] is sent when processed grew by ACK_MIN_INTERVAL_BYTES since the last ack, or
    // ACK_MAX_DELAY_MS after the first growth that is still un-acked. Acks are strictly increasing and
    // never above `received`.
    class AckState {
        // opts: { send(total), setTimer(fn, ms) → handle, clearTimer(handle), minBytes?, maxDelayMs?, pendingMax? }
        constructor(opts) {
            this.send = opts.send;
            this.setTimer = opts.setTimer;
            this.clearTimer = opts.clearTimer;
            this.minBytes = (opts.minBytes != null) ? opts.minBytes : limits.ACK_MIN_INTERVAL_BYTES;
            this.maxDelayMs = (opts.maxDelayMs != null) ? opts.maxDelayMs : limits.ACK_MAX_DELAY_MS;
            this.pendingMax = (opts.pendingMax != null) ? opts.pendingMax : limits.BROWSER_PENDING_MAX_BYTES;
            this.received = 0;
            this.processed = 0;
            this.lastAck = 0;
            this.timer = null;
        }

        // A frame of `bytes` was handed to the worker. `receivedTotal` is the UI thread's cumulative
        // count including this frame. Returns false when the hard pending limit is exceeded
        // (received − processed > BROWSER_PENDING_MAX_BYTES): the caller reports ['client-error', 'LIMIT'].
        receive(bytes, receivedTotal) {
            const total = (receivedTotal != null) ? receivedTotal : (this.received + bytes);
            // The UI count can only be ahead of ours (frames still queued in the worker's inbox) never behind
            this.received = Math.max(this.received + bytes, total);
            return (this.received - this.processed) <= this.pendingMax;
        }

        // A frame of `bytes` was fully applied
        processedBytes(bytes) {
            if (this.processed + bytes > this.received) { throw new Error('processed would exceed received'); }
            this.processed += bytes;
            if ((this.processed - this.lastAck) >= this.minBytes) { this.flush(); }
            else if ((this.timer === null) && (this.processed > this.lastAck)) {
                const self = this;
                this.timer = this.setTimer(function () { self.timer = null; self.flush(); }, this.maxDelayMs);
            }
        }

        flush() {
            if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
            if (this.processed > this.lastAck) { this.lastAck = this.processed; this.send(this.processed); }
        }

        // bytes received but not yet processed (queueDepth of gfx-ack)
        get queueDepth() { return this.received - this.processed; }

        reset() {
            if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
            this.received = 0; this.processed = 0; this.lastAck = 0;
        }
    }

    // UI thread side: counts bytes of binary frames before they go to the worker, checks the hard
    // pending limit on receipt and forwards the worker's acks to the server.
    //   - the limit is checked against the highest ack the worker reported, which is never above the
    //     true processed count, so a correct server (window WINDOW_BYTES) cannot trip it;
    //   - an ack is forwarded only if it is greater than the last forwarded one and not above received.
    class PendingGuard {
        constructor(opts) {
            this.pendingMax = ((opts != null) && (opts.pendingMax != null)) ? opts.pendingMax : limits.BROWSER_PENDING_MAX_BYTES;
            this.received = 0;
            this.acked = 0;
        }

        // → { ok, total }: ok false when the frame must not be handed to the worker
        onFrame(bytes) {
            this.received += bytes;
            return { ok: (this.received - this.acked) <= this.pendingMax, total: this.received };
        }

        // → the total to send to the server, or null when the ack must not be forwarded
        onAck(total) {
            if (!Number.isSafeInteger(total) || (total <= this.acked) || (total > this.received)) { return null; }
            this.acked = total;
            return total;
        }

        reset() { this.received = 0; this.acked = 0; }
    }

    // Keeps control messages (clipboard, resize, visibility) under CONTROL_MAX_MESSAGES_PER_SECOND:
    // the latest message of each kind is kept, at most one batch per `intervalMs` leaves.
    class ControlQueue {
        // opts: { send(message), now(), setTimer, clearTimer, intervalMs? }
        constructor(opts) {
            this.send = opts.send;
            this.now = opts.now;
            this.setTimer = opts.setTimer;
            this.clearTimer = opts.clearTimer;
            // 3 kinds per batch, so at most 3 / 0.2 s = 15 messages per second, below the server limit of 20
            this.intervalMs = (opts.intervalMs != null) ? opts.intervalMs : 200;
            this.pending = new Map();
            this.last = -Infinity;
            this.timer = null;
        }

        set(kind, message) {
            this.pending.set(kind, message);
            if (this.timer !== null) { return; }
            const wait = Math.max(0, this.last + this.intervalMs - this.now());
            const self = this;
            this.timer = this.setTimer(function () { self.timer = null; self.flush(); }, wait);
        }

        flush() {
            if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
            if (this.pending.size === 0) { return; }
            this.last = this.now();
            const batch = Array.from(this.pending.values());
            this.pending.clear();
            for (const m of batch) { this.send(m); }
        }

        clear() {
            if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
            this.pending.clear();
        }
    }

    return Object.freeze({ AckState: AckState, PendingGuard: PendingGuard, ControlQueue: ControlQueue });
});
