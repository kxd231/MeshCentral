/**
* @description Byte budget of the browser worker (BROWSER_CODEC_STATE_MAX_BYTES): reserve() throws CodecError 'LIMIT'
* @license Apache-2.0
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(require('../shared/limits.js'), require('../codecs/errors.js')); }
    else { root.RdpGfx = root.RdpGfx || {}; root.RdpGfx.budget = factory(root.RdpShared.limits, root.RdpCodecs.errors); }
})((typeof self !== 'undefined') ? self : this, function (limits, codecErrors) {
    'use strict';
    const CodecError = codecErrors.CodecError;

    class Budget {
        constructor(max) { this.max = (max != null) ? max : limits.BROWSER_CODEC_STATE_MAX_BYTES; this.used = 0; }
        reserve(bytes) {
            if (!Number.isSafeInteger(bytes) || (bytes < 0)) { throw new CodecError('INTERNAL', 'budget request'); }
            if (this.used + bytes > this.max) {
                const e = new CodecError('LIMIT', 'browser memory budget');
                e.budget = true;    // the caller may wait for earlier work to release its share
                throw e;
            }
            this.used += bytes;
        }
        release(bytes) {
            if (!Number.isSafeInteger(bytes) || (bytes < 0) || (bytes > this.used)) { throw new CodecError('INTERNAL', 'budget release'); }
            this.used -= bytes;
        }
    }

    return Object.freeze({ Budget: Budget });
});
