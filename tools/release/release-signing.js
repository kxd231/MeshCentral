#!/usr/bin/env node
/**
* @description Signing of server releases of the fork: keys, manifests and signatures for serverupdates.js. Run by the release owner through
* keygen.sh and sign-release.sh (Docker, no network). The formats and the verification are the ones of the server (serverupdates.js).
* The passphrase of a key is read from the first line of stdin, never from an argument or the environment. Nothing here is part of the package.
* @license Apache-2.0
*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const su = require('../../serverupdates.js');

const KEY_TYPE = 'meshcentral-release-key';
const KDF = { name: 'scrypt', N: 131072, r: 8, p: 1 };  // 128 MiB of memory; no other parameters are accepted when a key is opened
const MIN_PASSPHRASE = 16;
const MAX_ENVELOPE_BYTES = 8192;

function aadFor(envelope) { return Buffer.from([envelope.type, envelope.schemaVersion, envelope.keyId, envelope.algorithm, envelope.publicKey].join('\n'), 'utf8'); }
function deriveKey(passphrase, salt) { return crypto.scryptSync(passphrase, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 }); }
function checkPassphrase(passphrase) {
    if ((typeof passphrase !== 'string') || (passphrase.length < MIN_PASSPHRASE)) { throw new Error('The passphrase must have at least ' + MIN_PASSPHRASE + ' characters.'); }
}
function checkComment(comment) {
    if ((typeof comment !== 'string') || (comment.length < 1) || (comment.length > 80) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(comment)) { throw new Error('The comment must have 1 to 80 characters and no control characters.'); }
}
function utcSecond(date) { return (date || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
// The 32 raw bytes of an ed25519 public key
function rawPublicKey(publicKey) { return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'); }

// A new ed25519 key pair, its private key encrypted with the passphrase (scrypt, AES-256-GCM; the identity of the key is the associated data).
// Returns { keyId, envelope, entry }: envelope is the content of <keyId>.key.json, entry the line for "keys" in serverupdate-keys.json (<keyId>.pub.json).
function generateKey(passphrase, comment, now) {
    checkPassphrase(passphrase); checkComment(comment);
    const pair = crypto.generateKeyPairSync('ed25519');
    const raw = rawPublicKey(pair.publicKey), publicKey = raw.toString('base64url'), keyId = su.keyIdFor(raw);
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const envelope = { type: KEY_TYPE, schemaVersion: 1, keyId: keyId, algorithm: 'ed25519', comment: comment, createdAt: utcSecond(now), publicKey: publicKey,
        kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: '' }, ciphertext: '' };
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    cipher.setAAD(aadFor(envelope));
    const der = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
    envelope.ciphertext = Buffer.concat([cipher.update(der), cipher.final()]).toString('base64');
    envelope.cipher.tag = cipher.getAuthTag().toString('base64');
    der.fill(0);
    return { keyId: keyId, envelope: envelope, entry: { keyId: keyId, algorithm: 'ed25519', publicKey: publicKey, comment: comment } };
}

function canonicalBase64(text, length, what) {
    if ((typeof text !== 'string') || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) { throw new Error('The key file has an invalid ' + what + '.'); }
    const raw = Buffer.from(text, 'base64');
    if ((raw.length !== length) || (raw.toString('base64') !== text)) { throw new Error('The key file has an invalid ' + what + '.'); }
    return raw;
}

// Opens a key envelope with the passphrase. Returns { keyId, comment, privateKey, publicKey } (KeyObjects). Throws when the passphrase is wrong, the
// file was changed (the GCM tag covers the identity of the key) or the public key that follows from the private key is not the one in the file.
function openKey(envelope, passphrase) {
    checkPassphrase(passphrase);
    const bad = function (what) { return new Error('The key file has an invalid ' + what + '.'); };
    if ((envelope == null) || (typeof envelope !== 'object') || (envelope.type !== KEY_TYPE) || (envelope.schemaVersion !== 1) || (envelope.algorithm !== 'ed25519')) { throw bad('type'); }
    if ((envelope.kdf == null) || (envelope.kdf.name !== KDF.name) || (envelope.kdf.N !== KDF.N) || (envelope.kdf.r !== KDF.r) || (envelope.kdf.p !== KDF.p)) { throw bad('key derivation'); }
    if ((envelope.cipher == null) || (envelope.cipher.name !== 'aes-256-gcm')) { throw bad('cipher'); }
    const salt = canonicalBase64(envelope.kdf.salt, 16, 'salt'), iv = canonicalBase64(envelope.cipher.iv, 12, 'iv'), tag = canonicalBase64(envelope.cipher.tag, 16, 'tag');
    const raw = su.decodeBase64Url(envelope.publicKey, 32);
    if ((raw == null) || (typeof envelope.keyId !== 'string') || (su.keyIdFor(raw) !== envelope.keyId)) { throw bad('keyId or publicKey'); }
    if ((typeof envelope.ciphertext !== 'string') || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext) || (envelope.ciphertext.length > 4096)) { throw bad('ciphertext'); }
    let der;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
        decipher.setAAD(aadFor(envelope));
        decipher.setAuthTag(tag);
        der = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    } catch (ex) { throw new Error('Unable to open the key: wrong passphrase, or the key file was changed.'); }
    let privateKey;
    try { privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); } catch (ex) { throw new Error('The key file does not hold an ed25519 private key.'); } finally { der.fill(0); }
    if ((privateKey.asymmetricKeyType !== 'ed25519') || !rawPublicKey(crypto.createPublicKey(privateKey)).equals(raw)) { throw new Error('The private key in the key file does not belong to its public key.'); }
    return { keyId: envelope.keyId, comment: envelope.comment, privateKey: privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

// The manifest file (bytes) for a release package: the fields in a fixed order, 2 spaces, a line feed at the end. The result is checked with the
// rules of the server, so a manifest that the server would refuse is never made. fields: repository, version, tag, channel, size, sha256, sha384, commit, issued (default now).
function buildManifest(fields) {
    const manifest = {
        type: 'meshcentral-server-release', schemaVersion: 1, repository: fields.repository, version: fields.version, tag: fields.tag, channel: fields.channel,
        asset: su.assetNameFor(fields.version), size: fields.size, sha256: fields.sha256, sha384: fields.sha384, commit: fields.commit, issued: fields.issued || utcSecond()
    };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    su.checkManifest(bytes, null, fields.repository);
    return bytes;
}

// A signature entry for the raw bytes of the manifest
function signManifest(bytes, privateKey, keyId) {
    return { keyId: keyId, algorithm: 'ed25519', signature: crypto.sign(null, bytes, privateKey).toString('base64') };
}

// The signature file with the entries (a signature object like parseSignatureFile reads), as { type, schemaVersion, signatures }
function appendSignature(sigObject, entry) {
    const signatures = (sigObject && Array.isArray(sigObject.signatures)) ? sigObject.signatures.slice() : [];
    if (signatures.some(function (e) { return e.keyId === entry.keyId; })) { throw new Error('The signature file already holds a signature of the key ' + entry.keyId + '.'); }
    signatures.push(entry);
    if (signatures.length > 4) { throw new Error('A signature file holds at most 4 signatures.'); }
    return { type: 'meshcentral-release-signature', schemaVersion: 1, signatures: signatures };
}
function signatureFileBytes(sigObject) { const bytes = Buffer.from(JSON.stringify(sigObject, null, 2) + '\n', 'utf8'); su.parseSignatureFile(bytes); return bytes; }

// ---- command line ----
function parseArguments(argv, allowed) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i];
        if (!name.startsWith('--') || !allowed.includes(name.substring(2))) { throw new Error('Unknown or unexpected argument: ' + name.substring(0, 40)); }
        const key = name.substring(2);
        if ((key === 'append') || (key === 'check-only')) { options[key] = true; continue; } // flags without a value
        if (i + 1 >= argv.length) { throw new Error('Missing value for ' + name); }
        options[key] = argv[++i];
    }
    return options;
}
function need(options, names) { for (const n of names) { if (typeof options[n] !== 'string' || options[n].length === 0) { throw new Error('Missing --' + n); } } }

// The first line of stdin, without the line end
function readPassphrase() {
    const input = fs.readFileSync(0, 'utf8');
    const line = input.split('\n')[0].replace(/\r$/, '');
    return line;
}
function writeNew(file, data, mode) { fs.writeFileSync(file, data, { flag: 'wx', mode: mode }); }
function readSmallFile(file, limit) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.size > limit)) { throw new Error(file + ' is not a regular file of at most ' + limit + ' bytes.'); }
    return fs.readFileSync(file);
}
function hashFile(file) {
    const sha256 = crypto.createHash('sha256'), sha384 = crypto.createHash('sha384');
    let size = 0;
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (n === 0) { break; } size += n; sha256.update(buffer.subarray(0, n)); sha384.update(buffer.subarray(0, n)); }
    } finally { fs.closeSync(fd); }
    return { size: size, sha256: sha256.digest('hex'), sha384: sha384.digest('hex') };
}

// The manifest fields of a release: the values given by the owner and what the package file is
function manifestFields(o, hashes) {
    return { repository: o.repository, version: o.version, tag: o.tag, channel: o.channel, size: hashes.size, sha256: hashes.sha256, sha384: hashes.sha384, commit: o.commit };
}
// The manifest bytes must be exactly the manifest of this package and these values (the tool's own format, no other fields), only the time is free
function checkManifestFor(manifestBytes, o, hashes) {
    let issued;
    try { issued = su.checkManifest(manifestBytes, null, o.repository).issued; } catch (ex) { throw new Error('The manifest is not valid: ' + ex.message); }
    const expected = buildManifest(Object.assign(manifestFields(o, hashes), { issued: issued }));
    if (!expected.equals(manifestBytes)) { throw new Error('The manifest does not describe this package and these release values (version, tag, channel, repository, commit, size, sha256, sha384).'); }
}
// The folder of the signature files: ours, and closed to others (the manifest must not be changed between the checks and the signature)
function checkOutDirectory(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory()) { throw new Error(directory + ' is not a folder.'); }
    if ((typeof process.getuid === 'function') && (stat.uid !== process.getuid())) { throw new Error(directory + ' does not belong to the user that signs.'); }
    if ((process.platform !== 'win32') && ((stat.mode & 0o077) !== 0)) { throw new Error(directory + ' must not be accessible for group and others (chmod 700).'); }
}

async function main(argv) {
    const command = argv[0], rest = argv.slice(1);
    if (command === 'keygen') {
        const o = parseArguments(rest, ['out', 'comment']); need(o, ['out', 'comment']);
        const made = generateKey(readPassphrase(), o.comment);
        writeNew(path.join(o.out, made.keyId + '.key.json'), JSON.stringify(made.envelope, null, 2) + '\n', 0o600);
        writeNew(path.join(o.out, made.keyId + '.pub.json'), JSON.stringify(made.entry, null, 2) + '\n', 0o644);
        console.log(made.keyId);
        console.log(JSON.stringify(made.entry, null, 2));
        return 0;
    }
    if (command === 'manifest') {
        const o = parseArguments(rest, ['tgz', 'version', 'tag', 'commit', 'repository', 'channel', 'out']); need(o, ['tgz', 'version', 'tag', 'commit', 'repository', 'channel', 'out']);
        const hashes = hashFile(o.tgz);
        const bytes = buildManifest({ repository: o.repository, version: o.version, tag: o.tag, channel: o.channel, size: hashes.size, sha256: hashes.sha256, sha384: hashes.sha384, commit: o.commit });
        if (path.basename(o.tgz) !== su.assetNameFor(o.version)) { throw new Error('The package file must be named ' + su.assetNameFor(o.version) + '.'); }
        writeNew(o.out, bytes, 0o644);
        console.log('Manifest written: ' + o.out);
        return 0;
    }
    if (command === 'sign') {
        // The manifest is made from the package and signed in this one process, from the same bytes: nothing between the check and the signature can be changed.
        // With --append the existing manifest must be exactly what the package and the values give, and every signature that is there must be valid.
        const o = parseArguments(rest, ['key', 'tgz', 'version', 'tag', 'commit', 'repository', 'channel', 'out', 'keys', 'append', 'check-only']); need(o, ['key', 'tgz', 'version', 'tag', 'commit', 'repository', 'channel', 'out']);
        if (path.basename(o.tgz) !== su.assetNameFor(o.version)) { throw new Error('The package file must be named ' + su.assetNameFor(o.version) + '.'); }
        checkOutDirectory(o.out);
        const manifestFile = path.join(o.out, su.manifestAssetName(o.version)), sigFile = manifestFile + '.sig';
        const hashes = hashFile(o.tgz);
        let manifest, existing = null;
        if (o.append) {
            need(o, ['keys']);
            manifest = readSmallFile(manifestFile, su.MAX_SIGNED_BYTES);
            checkManifestFor(manifest, o, hashes);
            const existingBytes = readSmallFile(sigFile, su.MAX_SIGNED_BYTES);
            const entries = su.parseSignatureFile(existingBytes);
            const trusted = su.loadTrustedKeys(o.keys, null);
            if (trusted.error) { throw new Error('Invalid key list: ' + trusted.error); }
            for (const entry of entries) { if (su.verifySignatures(manifest, [entry], trusted).code !== 'signed') { throw new Error('The existing signature of the key ' + entry.keyId + ' does not verify on this manifest.'); } }
            existing = JSON.parse(existingBytes.toString('utf8'));
        } else {
            if (fs.existsSync(manifestFile) || fs.existsSync(sigFile)) { throw new Error('The manifest or the signature file exists already in ' + o.out + '; not overwriting.'); }
            manifest = buildManifest(manifestFields(o, hashes));
        }
        if (o['check-only']) { console.log('Checked: the manifest describes ' + path.basename(o.tgz) + '.'); return 0; }
        const key = openKey(JSON.parse(readSmallFile(o.key, MAX_ENVELOPE_BYTES).toString('utf8')), readPassphrase());
        const entry = signManifest(manifest, key.privateKey, key.keyId);
        if (!crypto.verify(null, manifest, key.publicKey, Buffer.from(entry.signature, 'base64'))) { throw new Error('The signature does not verify with the public key.'); }
        const signatureBytes = signatureFileBytes(appendSignature(existing, entry));
        if (o.append) {
            // The signatures of the existing file stay as they are, ours is added; written to a temporary file and moved
            const temp = sigFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
            writeNew(temp, signatureBytes, 0o644);
            fs.renameSync(temp, sigFile);
        } else {
            writeNew(manifestFile, manifest, 0o644);
            try { writeNew(sigFile, signatureBytes, 0o644); } catch (ex) { try { fs.unlinkSync(manifestFile); } catch (ex2) { } throw ex; }
        }
        console.log('Signed with key ' + key.keyId + ': ' + sigFile);
        return 0;
    }
    if (command === 'verify') {
        // Without --tgz: what a server does (one valid signature of a trusted key). With --tgz and the release values: the manifest must be
        // exactly what the package gives, and every signature in the file must be valid and from a trusted key.
        const o = parseArguments(rest, ['manifest', 'sig', 'keys', 'tgz', 'version', 'tag', 'commit', 'repository', 'channel']); need(o, ['manifest', 'sig', 'keys']);
        const trusted = su.loadTrustedKeys(o.keys, null);
        if (trusted.error) { console.log('Invalid key list: ' + trusted.error); return 1; }
        const manifest = readSmallFile(o.manifest, su.MAX_SIGNED_BYTES);
        let signatures;
        try { signatures = su.parseSignatureFile(readSmallFile(o.sig, su.MAX_SIGNED_BYTES)); } catch (ex) { console.log('Invalid signature file: ' + ex.message); return 1; }
        const verdict = su.verifySignatures(manifest, signatures, trusted);
        if (verdict.code !== 'signed') { console.log('Not verified: ' + verdict.code + ' ' + (verdict.keyIds || []).join(' ')); return 1; }
        try { su.checkManifest(manifest, null, null); } catch (ex) { console.log('The manifest is not valid: ' + ex.message); return 1; }
        if (o.tgz) {
            need(o, ['version', 'tag', 'commit', 'repository', 'channel']);
            try { checkManifestFor(manifest, o, hashFile(o.tgz)); } catch (ex) { console.log('Not verified: ' + ex.message); return 1; }
            for (const entry of signatures) { if (su.verifySignatures(manifest, [entry], trusted).code !== 'signed') { console.log('Not verified: the signature of the key ' + entry.keyId + ' is not valid or its key is not trusted.'); return 1; } }
        }
        console.log(verdict.keyId);
        return 0;
    }
    if (command === 'extract-keys') {
        // The key list that is inside a release package (what the servers will trust once the package is installed), written to a new file
        const o = parseArguments(rest, ['tgz', 'out']); need(o, ['tgz', 'out']);
        const bytes = await su.readTgzEntry(o.tgz, 'package/serverupdate-keys.json', 64 * 1024);
        su.parseKeysDocument(bytes.toString('utf8'), 'serverupdate-keys.json in the package');
        writeNew(o.out, bytes, 0o644);
        return 0;
    }
    if (command === 'keys') {
        // The key list of a file, for the owner to read: key id and comment of every key, and the revoked ids
        const o = parseArguments(rest, ['keys']); need(o, ['keys']);
        const list = su.readKeysFile(o.keys, false);
        for (const key of list.keys) { console.log(key.keyId + ' (' + key.comment + ')'); }
        for (const id of list.revoked) { console.log(id + ' revoked'); }
        return 0;
    }
    throw new Error('Usage: release-signing.js keygen|manifest|sign|verify ...');
}

module.exports = { generateKey, openKey, buildManifest, checkManifestFor, manifestFields, checkOutDirectory, signManifest, appendSignature, signatureFileBytes, KDF };

if (require.main === module) {
    main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (ex) { console.error('ERROR: ' + ex.message); process.exitCode = 2; });
}
