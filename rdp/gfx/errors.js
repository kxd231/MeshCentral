/** @description Preserve sanitized GFX errors with the legacy recovery hint. @license Apache-2.0 */
'use strict';
const { toRdpError } = require('../protocol/errors.js');
function useLegacy(error) {
    const err = toRdpError(error);
    err.hint = 'use-legacy';
    return err;
}
module.exports = { useLegacy };
