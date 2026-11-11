/**
* @description Embeds (or checks) the WebAssembly build of avc444-simd.c in public/rdp/codecs/avc444-simd.js. Run by build.sh in a node container.
* @license Apache-2.0
* Usage: node embed.js <module.wasm> <toolchain.txt> <avc444-simd.js> [--check]
* Without --check the GENERATED block of the JavaScript file is rewritten (toolchain, sha256 of the module, base64). With --check the file is
* not written: the exit code is 1 when the recorded sha256, the toolchain line or the embedded bytes differ from the module just built.
*/
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [wasmFile, toolFile, target, flag] = process.argv.slice(2);
const wasm = fs.readFileSync(wasmFile);
const toolchain = fs.readFileSync(toolFile, 'utf8').trim().split('\n')[0].replace(/'/g, '');
const sha = crypto.createHash('sha256').update(wasm).digest('hex');
const b64 = wasm.toString('base64');
const lines = b64.match(/.{1,120}/g).map((l) => '        "' + l + '"').join(' +\n');
const block = '/* GENERATED BEGIN */\n    // Built by tools/avc444-simd/build.sh from tools/avc444-simd/avc444-simd.c; `build.sh --check` rebuilds and compares\n' +
    "    const WASM_TOOLCHAIN = '" + toolchain + "';\n    const WASM_SHA256 = '" + sha + "';\n    const WASM_BASE64 =\n" + lines + ';\n    ';
const s = fs.readFileSync(target, 'utf8');
const a = s.indexOf('/* GENERATED BEGIN */'), z = s.indexOf('/* GENERATED END */');
if (a < 0 || z < 0) { throw new Error('markers missing'); }
const next = s.slice(0, a) + block + s.slice(z);
if (flag === '--check') {
    if (next === s) { console.log('OK: the embedded module equals the build (' + wasm.length + ' bytes, sha256 ' + sha + ', ' + toolchain + ')'); process.exit(0); }
    console.error('DIFFERENT: the embedded module is not the build of avc444-simd.c (built sha256 ' + sha + ', ' + toolchain + ')');
    process.exit(1);
}
fs.writeFileSync(target, next);
console.log('embedded ' + wasm.length + ' bytes, sha256 ' + sha + ', ' + toolchain);
