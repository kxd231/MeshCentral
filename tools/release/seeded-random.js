// Loaded with "node --require" before translate.js by build-server-tgz.sh. html-minifier-terser replaces "<? ... ?>" and
// "<% ... %>" fragments (such as "<?xml" in public/scripts/amt-wsman-0.2.0.js) by placeholders with a Math.random() id while
// terser minifies the script; terser names variables by character frequency, so the minified file depended on chance.
// A fixed-seed generator (mulberry32) makes the package byte-for-byte reproducible. The placeholders are removed again, so
// the output is a valid minification either way.
'use strict';
let state = 0x4d455348; // fixed seed
Math.random = function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
