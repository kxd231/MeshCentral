/**
* @description CodecError, the only exception type thrown by Web-RDP decoders (see README.md)
* @license Apache-2.0
*
* Contract file: the interface is documented in README.md; change code and documentation together.
*/
(function (root, factory) {
    'use strict';
    if ((typeof module === 'object') && module.exports) { module.exports = factory(); }
    else { root.RdpCodecs = root.RdpCodecs || {}; root.RdpCodecs.errors = factory(); }
})((typeof self !== 'undefined') ? self : this, function () {
    'use strict';

    const CODES = Object.freeze(['TRUNCATED', 'INVALID', 'LIMIT', 'UNSUPPORTED', 'INTERNAL']);

    class CodecError extends Error {
        constructor(code, message) {
            if (CODES.indexOf(code) < 0) { code = 'INTERNAL'; }
            super(code + ((message != null) ? (': ' + String(message).substring(0, 200)) : ''));
            this.name = 'CodecError';
            this.code = code;
        }
    }

    // Any exception → CodecError (a decoder bug becomes INTERNAL, its message is not kept)
    function toCodecError(err) { return (err instanceof CodecError) ? err : new CodecError('INTERNAL'); }

    return Object.freeze({ CODES: CODES, CodecError: CodecError, toCodecError: toCodecError });
});
