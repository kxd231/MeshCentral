/**
* @description Web-RDP graphics policy and the automatic legacy fallback (state machine, no DOM)
* @license Apache-2.0
*
* settings.webRdp.gfx reaches the page as `webRdpGfx` ('on' | 'off' | 'dev', '' without the JS engine). This module decides
* - which graphics mode a connect attempt requests (wantedMode),
* - whether a failed GFX session is retried once in legacy mode, offered a manual legacy reconnect, or just reported (GraphicsFallback).
*
* The fallback is a bounded state machine: at most ONE automatic retry per user-initiated connect, only before the first
* desktop frame of a GFX session and only for GFX-specific errors. The retry is always legacy, so it cannot retry again.
* Usable from Node (require) and from a page (self.RdpClient.fallback).
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(); }
    else { root.RdpClient = root.RdpClient || {}; root.RdpClient.fallback = factory(); }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';

    // Codes that mean "this GFX session cannot work here" (rdp/protocol/errors.js, public/rdp/shared/errors.js):
    //   CAPABILITIES_REJECTED / hint use-legacy   the server refuses or never confirmed GFX (GFX_CONFIRM_TIMEOUT_MS), or this client cannot show the mode
    //   H264_REQUIRED                              the server insists on H.264, which this browser cannot decode
    //   CLIENT_DECODE                              the server's answer to a client-error of the worker (decoder or WebCodecs failure, UNSUPPORTED codec)
    // Server-side GFX parser and budget failures carry use-legacy, including PROTOCOL and RESOURCE_LIMIT.
    const GFX_CODES = ['RDP_ERROR_CAPABILITIES_REJECTED', 'RDP_ERROR_H264_REQUIRED', 'RDP_ERROR_CLIENT_DECODE'];

    // The page variable webRdpGfx → 'on' | 'off' | 'dev'. Anything unknown (also '' and undefined) is 'off': an old or unconfigured page stays legacy.
    function normalizePolicy(value) {
        return ((value === 'on') || (value === 'dev')) ? value : 'off';
    }

    // The per-user choice in the RDP options: 'auto' (default: H.264 when the browser and the server have it, otherwise lossless GFX),
    // 'lossless' (GFX with Progressive / ClearCodec, never H.264) or 'legacy' (Classic bitmaps)
    function normalizePreference(value) {
        return ((value === 'legacy') || (value === 'lossless')) ? value : 'auto';
    }

    // What a connect attempt asks the server for. 'auto' means: probe the browser, then 'h264' (probe ok) or 'gfx' (set A only).
    // policy: 'on' | 'off' | 'dev'; preference: 'auto' | 'lossless' | 'legacy'; forced: dev switch only ('legacy' | 'gfx' | 'h264' | 'auto' | undefined)
    function wantedMode(policy, preference, forced) {
        if (policy === 'off') { return 'legacy'; }
        const chosen = (preference === 'legacy') ? 'legacy' : ((preference === 'lossless') ? 'gfx' : 'auto');
        if (policy === 'dev') { return forced || chosen; }
        return chosen;
    }

    // A failed AVC444 session is remembered per browser for AVC444_MEMORY_MS (the next connects offer B + A instead of D). Storage is any
    // object with getItem / setItem (localStorage); every access is guarded, a browser without storage simply forgets.
    const AVC444_MEMORY_KEY = 'webrdpAvc444Failed';
    const AVC444_MEMORY_MS = 12 * 60 * 60 * 1000;
    function avc444Remembered(storage, now) {
        try {
            const v = Number(storage.getItem(AVC444_MEMORY_KEY));
            return Number.isFinite(v) && (v > 0) && (now < v);
        } catch (ex) { return false; }
    }
    function rememberAvc444Failure(storage, now) {
        try { storage.setItem(AVC444_MEMORY_KEY, String(now + AVC444_MEMORY_MS)); } catch (ex) { /* no storage: forgotten */ }
    }

    // info: { code, hint }. Generic error codes carry no channel provenance; trust the engine's explicit hint.
    function isGfxFailure(info) {
        if ((info == null) || (typeof info !== 'object')) { return false; }
        return info.hint === 'use-legacy' || GFX_CODES.indexOf(info.code) >= 0;
    }

    // One per user-initiated connect. `enabled`: automatic fallback allowed (policy 'on'); a GFX failure after the first frame is
    // offered a manual legacy reconnect whenever the session was GFX, also when the automatic fallback is off.
    //   attempt(mode)         a connection attempt starts with this requested mode ('legacy' | 'gfx' | 'h264'); fallback attempts pass fallback=true
    //   connected(mode)       rdp-connect arrived with this mode
    //   firstFrame()          the first desktop frame of the session was rendered
    //   failure(info, usedAvc444) → 'retry-no-avc444' | 'retry-legacy' | 'offer-legacy' | 'error'. A GFX failure of a session that
    //     confirmed the AVC444 set D, before its first frame, is retried once WITHOUT D (set B + A, Progressive on Windows); that retry does not use the legacy retry
    class GraphicsFallback {
        constructor(enabled) {
            this.enabled = (enabled === true);
            this.used = false;            // the one automatic retry was taken
            this.requested = null;        // requested mode of the current attempt
            this.mode = null;             // mode of the current session (rdp-connect)
            this.frame = false;           // first frame of the current attempt rendered
            this.isFallback = false;      // the current attempt is the automatic legacy retry
            this.usedNoAvc444 = false;    // the one retry without AVC444 was taken
        }

        attempt(mode, fallback) {
            this.requested = mode; this.mode = null; this.frame = false; this.isFallback = (fallback === true);
        }
        connected(mode) { this.mode = mode; }
        firstFrame() { this.frame = true; }
        get gfxRequested() { return (this.requested !== null) && (this.requested !== 'legacy'); }

        failure(info, usedAvc444) {
            if (!this.gfxRequested || this.isFallback || !isGfxFailure(info)) { return 'error'; }
            if ((usedAvc444 === true) && !this.frame && this.enabled && !this.usedNoAvc444) { this.usedNoAvc444 = true; return 'retry-no-avc444'; }
            if (!this.frame) {
                if (!this.enabled || this.used) { return 'error'; }
                this.used = true;
                return 'retry-legacy';
            }
            return (this.mode === 'gfx') ? 'offer-legacy' : 'error';
        }
    }

    return Object.freeze({
        normalizePolicy: normalizePolicy, normalizePreference: normalizePreference, wantedMode: wantedMode,
        avc444Remembered: avc444Remembered, rememberAvc444Failure: rememberAvc444Failure, AVC444_MEMORY_KEY: AVC444_MEMORY_KEY, AVC444_MEMORY_MS: AVC444_MEMORY_MS,
        isGfxFailure: isGfxFailure, GraphicsFallback: GraphicsFallback
    });
});
