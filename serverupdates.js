'use strict';

// Server self-update from GitHub releases of the fork (settings.serverUpdateSource = "github", the default),
// next to the original npm based update ("npm"). A release is usable when it carries an asset named exactly
// meshcentral-<version>.tgz. The asset is downloaded in the parent process, checked against the size and SHA-384
// of a local pin in meshcentral-data/serverupdate-pins.json and against the sha256 digest that the GitHub API
// reports for it, and then handed to "npm install" as a local file. A version without a local pin is never
// installed: the digest from the release alone would trust whoever can publish the release.
//
// The pin comes from one of two places. The administrator can write it by hand (a manual pin, the way that always
// works). Or the release owner signs a manifest of the release (size, sha256, sha384, tag, commit) with an ed25519
// key: when the signature verifies against a public key shipped in serverupdate-keys.json (or in the data folder), the
// server writes the pin itself (source "signature"). The key is not on GitHub, so someone who only controls the
// repository or its Actions cannot make a server install anything. Formats and procedures: docs/fork-updates.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { httpsDownloads } = require('./httpsdownloads');

const DEFAULT_REPOSITORY = 'kxd231/MeshCentral';
const CACHE_MS = 5 * 60 * 1000;            // Release list is reused for 5 minutes, so the UI dialog and the nightly check do not burn the unauthenticated rate limit
const MAX_ASSET_BYTES = 256 * 1024 * 1024; // Hard ceiling on top of the size the API reports for the asset
const FOLDER_NAME = 'serverupdates';
const FAILURE_FILE = 'last-failure.json';
const REFUSAL_FILE = 'last-refusal.json'; // Written by the parent process, read by the server process (see recordRefusal)
const FAILURE_RETRY_MS = 24 * 3600 * 1000; // An automatic update to a version that failed is not retried for this long
const PINS_FILE = 'serverupdate-pins.json'; // In the data folder, written by the administrator
const MAX_PINS_BYTES = 1024 * 1024;
const MAX_PINS = 256;
const MAX_SIGNATURE_PINS = 20;              // Pins written from signatures that are kept; manual pins are never removed
const KEYS_FILE = 'serverupdate-keys.json'; // In the package (built in keys) and optionally in the data folder (local keys)
const MAX_KEYS_BYTES = 64 * 1024;
const MAX_KEYS = 16;
const MAX_REVOKED = 64;
const MAX_SIGNED_BYTES = 16384;             // Manifest and signature files
const INSPECT_CACHE_MS = 5 * 60 * 1000;
const PARENT_API_VERSION = 1;               // Version of the contract between meshcentral.js (parent process) and createParentUpdate()
// The npm source can still report versions, but installing from it is refused: the registry package has no local pin
const NPM_INSTALL_BLOCKED = 'Server update from serverUpdateSource "npm" is blocked: a package from the npm registry has no local size and SHA-384 pin. Nothing was installed. Use serverUpdateSource "github" (the default) with a pin in meshcentral-data/' + PINS_FILE + ', or update by hand.';

// Version scheme of the fork: <upstream base>-custom.<n>, e.g. 1.3.1-custom.1, 1.3.1-custom.2, later 1.3.5-custom.1.
// Accepted forms, each with an optional leading "v" (tags only):
//   X.Y.Z            plain, e.g. an upstream version
//   X.Y.Z.W          older fork form, e.g. 1.3.1.1; ordered like X.Y.Z-custom.W
//   X.Y.Z-custom.N   N >= 1
// Numbers have no leading zeros. Anything else (1.3.1-beta, 1.3.1-custom, 1.3.1-custom.01, latest) is not a version.
const VERSION_PATTERN = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:\.(0|[1-9]\d{0,5})|-custom\.([1-9]\d{0,5}))?$/;

// Returns { parts: [X, Y, Z, fork], text, form } or null. parts[3] is the fork number (0 for a plain version), which makes
// "1.3.1.1" and "1.3.1-custom.1" the same in ordering. text is the canonical text: as written, without the "v". form is
// 'plain', 'dotted' (X.Y.Z.W) or 'custom'.
function parseVersion(text) {
    if (typeof text !== 'string') { return null; }
    const match = VERSION_PATTERN.exec(text);
    if (match == null) { return null; }
    const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || match[5] || 0)];
    return { parts: parts, text: (text.charAt(0) === 'v') ? text.substring(1) : text, form: (match[5] != null) ? 'custom' : ((match[4] != null) ? 'dotted' : 'plain') };
}

// Numeric, part by part: the upstream base first, then the fork number (plain < -custom.1 < -custom.2). A newer upstream base
// always wins, 1.3.2 > 1.3.1-custom.9. Accepts version strings or parseVersion() results. Unparsable values sort below everything.
function compareVersions(a, b) {
    const pa = (typeof a === 'string') ? parseVersion(a) : a, pb = (typeof b === 'string') ? parseVersion(b) : b;
    if ((pa == null) && (pb == null)) { return 0; }
    if (pa == null) { return -1; }
    if (pb == null) { return 1; }
    for (let i = 0; i < 4; i++) { if (pa.parts[i] !== pb.parts[i]) { return pa.parts[i] < pb.parts[i] ? -1 : 1; } }
    return 0;
}

// GitHub owner/repository: owner is alphanumeric with single inner hyphens (max 39), repository is [A-Za-z0-9._-] (max 100)
function validRepository(value) {
    if ((typeof value !== 'string') || (value.length > 140)) { return false; }
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(value);
    return (match != null) && (match[2] !== '.') && (match[2] !== '..');
}

function assetNameFor(version) { return 'meshcentral-' + version + '.tgz'; }
function manifestAssetName(version) { return 'meshcentral-' + version + '.manifest.json'; }
function signatureAssetName(version) { return manifestAssetName(version) + '.sig'; }

// "sha256:<64 hex>" as reported by the GitHub API, returned as lower case hex or null
function parseDigest(digest) {
    if (typeof digest !== 'string') { return null; }
    const match = /^sha256:([A-Fa-f0-9]{64})$/.exec(digest);
    return (match == null) ? null : match[1].toLowerCase();
}

// Local pins of server packages, like agents/agent-defaults.json for agents:
//   { "schemaVersion": 1, "releases": [ { "version": "1.3.1-custom.2", "size": 69029801, "sha384": "<96 lower case hex>" } ] }
// version is the canonical text (as in the asset name, no "v"). A manual pin has these three fields. A pin that the server wrote
// from a signed release has more (source "signature", keyId, manifestSha256, addedAt); other fields are ignored here, so
// the older code reads such a file too.
// readPinEntries returns the validated entries as they are in the file (an empty array for a missing file); readPins returns a
// Map version -> { version, size, sha384 }. A file that is not valid throws, so a typo never turns into "no check".
function readPinEntries(file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (ex) { if (ex.code === 'ENOENT') { return []; } throw new Error('Unable to read ' + file + ': ' + ex.message); }
    if (!stat.isFile() || (stat.size > MAX_PINS_BYTES)) { throw new Error(file + ' is not a regular file of at most 1 MiB.'); }
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (ex) { throw new Error(file + ' is not valid JSON.'); }
    if ((data == null) || (data.schemaVersion !== 1) || !Array.isArray(data.releases) || (data.releases.length > MAX_PINS)) { throw new Error(file + ': expected { "schemaVersion": 1, "releases": [ ... ] }.'); }
    const seen = new Set();
    for (const entry of data.releases) {
        const version = ((entry != null) && (typeof entry === 'object')) ? parseVersion(entry.version) : null;
        if ((version == null) || (version.text !== entry.version)) { throw new Error(file + ': "' + String(entry && entry.version).substring(0, 40) + '" is not a release version (write it like the asset name, without "v").'); }
        if (!Number.isInteger(entry.size) || (entry.size <= 0) || (entry.size > MAX_ASSET_BYTES)) { throw new Error(file + ': invalid size for ' + entry.version + '.'); }
        if ((typeof entry.sha384 !== 'string') || !/^[a-f0-9]{96}$/.test(entry.sha384)) { throw new Error(file + ': invalid sha384 for ' + entry.version + ', expected 96 lower case hex characters.'); }
        if (seen.has(entry.version)) { throw new Error(file + ': ' + entry.version + ' is listed twice.'); }
        seen.add(entry.version);
    }
    return data.releases;
}
function readPins(file) {
    const pins = new Map();
    for (const entry of readPinEntries(file)) { pins.set(entry.version, { version: entry.version, size: entry.size, sha384: entry.sha384 }); }
    return pins;
}

function fileSha384(file) {
    return new Promise(function (resolve, reject) {
        const hash = crypto.createHash('sha384');
        let size = 0;
        fs.createReadStream(file).on('data', function (chunk) { size += chunk.length; hash.update(chunk); }).on('error', reject).on('end', function () { resolve({ size: size, sha384: hash.digest('hex') }); });
    });
}

// Usable releases, newest first. A release is usable when it is published (not a draft), its tag is a version and it
// has an asset named meshcentral-<tag without v>.tgz that is uploaded and not empty.
function selectReleases(releases) {
    const usable = [];
    if (!Array.isArray(releases)) { return { usable: usable, latest: null, prerelease: null }; }
    for (const release of releases) {
        if ((release == null) || (typeof release !== 'object') || (release.draft === true) || (typeof release.tag_name !== 'string')) { continue; }
        const version = parseVersion(release.tag_name);
        if ((version == null) || !Array.isArray(release.assets)) { continue; }
        const tag = release.tag_name, expected = assetNameFor(version.text);
        const asset = release.assets.find(function (a) {
            return (a != null) && (a.name === expected) && Number.isInteger(a.size) && (a.size > 0) && (a.size <= MAX_ASSET_BYTES) && ((a.state == null) || (a.state === 'uploaded'));
        });
        if (asset == null) { continue; }
        // The signed manifest and its signature are optional small assets (a release without them can only be installed with a manual pin)
        const small = function (name) {
            const found = release.assets.find(function (a) { return (a != null) && (a.name === name) && Number.isInteger(a.size) && (a.size > 0) && (a.size <= MAX_SIGNED_BYTES) && ((a.state == null) || (a.state === 'uploaded')); });
            return (found == null) ? null : { name: found.name, size: found.size, digest: parseDigest(found.digest) };
        };
        const entry = { version: version.text, parts: version.parts, form: version.form, tag: tag, prerelease: (release.prerelease === true), asset: { name: asset.name, size: asset.size, digest: parseDigest(asset.digest) }, manifest: small(manifestAssetName(version.text)), signature: small(signatureAssetName(version.text)), publishedAt: release.published_at || null };
        // One version can have several usable tags ("1.3.2" and "1.3.2.0", "1.3.1.1" and "1.3.1-custom.1"). The -custom form is
        // preferred, otherwise the first one in the list stays. A tag without a usable asset never hides the other one.
        const key = version.parts.join('.'), index = usable.findIndex(function (r) { return r.parts.join('.') === key; });
        // A tag with a signed manifest is kept over another tag of the same version that has none (a later, unsigned tag must not hide the signed release)
        const signedRank = function (r) { return ((r.manifest != null) && (r.signature != null)) ? 1 : 0; };
        if (index < 0) { usable.push(entry); }
        else if (signedRank(entry) !== signedRank(usable[index])) { if (signedRank(entry) > signedRank(usable[index])) { usable[index] = entry; } }
        else if ((entry.form === 'custom') && (usable[index].form !== 'custom')) { usable[index] = entry; }
    }
    usable.sort(function (a, b) { return compareVersions(b, a); });
    const latest = usable.find(function (r) { return !r.prerelease; }) || null;
    // A prerelease is only worth showing when it is newer than the newest stable release
    const pre = usable.find(function (r) { return r.prerelease && ((latest == null) || (compareVersions(r, latest) > 0)); }) || null;
    return { usable: usable, latest: latest, prerelease: pre };
}

// Whether the automatic self-update should run for these versions. npm: any difference (unchanged); github: a newer version
// only; any other source (invalid setting, updates disabled): never.
function updateNeeded(source, currentVer, latestVer) {
    if (source === 'npm') { return (currentVer != latestVer); }
    if (source !== 'github') { return false; }
    // Both must be versions of the scheme: an installed version outside it would otherwise look older than everything and be "updated" every day
    return (typeof latestVer === 'string') && (typeof currentVer === 'string') && (parseVersion(latestVer) != null) && (parseVersion(currentVer) != null) && (compareVersions(latestVer, currentVer) > 0);
}

// selfUpdate set to a string: for the github source it must be an exact release version. Versions are compared as versions
// ("v1.3.2", "1.3.2.0" and "1.3.2" are the same, so are "1.3.1.1" and "1.3.1-custom.1"), "latest", "stable" or "1.3.2-beta" are not valid. For npm the string is
// compared as written, like before.
function selfUpdateValid(source, value) { return (source !== 'github') || (parseVersion(value) != null); }
function selfUpdateIsCurrent(source, current, value) { return (source === 'github') ? (compareVersions(current, value) === 0) : (current === value); }

// The server child process announces an update to an exact version with the console line "Starting self upgrade to: <version>".
// The parent process reads that line and decides here whether to act on it. Returns null when the text is not a version the
// source accepts (the line is ignored), otherwise { upgrade } where upgrade says whether it is newer than the installed version.
// npm: the previous check, unchanged (digits, dots and hyphens; the part before the first hyphen compared in up to 4 parts).
// github: the strict release version (no "v", no other characters, so nothing reaches a shell), compared with compareVersions.
function selfUpgradeRequest(source, requested, current) {
    if (typeof requested !== 'string') { return null; }
    if (source === 'npm') {
        if (!/^[0-9\.\-]+$/i.test(requested)) { return null; }
        let isUpgrade = false;
        try {
            if (current) {
                const sVer = requested.split('-')[0].split('.');
                const cVer = current.split('-')[0].split('.');
                for (let i = 0; i <= 3; i++) {
                    const sVal = parseInt(sVer[i] || 0);
                    const cVal = parseInt(cVer[i] || 0);
                    if (sVal > cVal) { isUpgrade = true; break; }
                    else if (sVal < cVal) { break; }
                }
            }
        } catch (ex) { }
        return { upgrade: isUpgrade };
    }
    const wanted = parseVersion(requested);
    if ((wanted == null) || (wanted.text !== requested)) { return null; }
    const installed = parseVersion(current);
    return { upgrade: (installed != null) && (compareVersions(wanted, installed) > 0) };
}

// serverUpdateTrust: "signature" (the default) lets a signed release write its own pin; "pin" only accepts the pins that the
// administrator wrote. Any other value counts as "pin", the safer direction, and is an error in the log (trustSettingError).
function trustSetting(args) {
    if ((args == null) || (args.serverupdatetrust == null)) { return 'signature'; }
    const wanted = (typeof args.serverupdatetrust === 'string') ? args.serverupdatetrust.trim().toLowerCase() : args.serverupdatetrust;
    return ((wanted === 'signature') || (wanted === 'pin')) ? wanted : 'pin';
}
function trustSettingError(args) {
    if ((args == null) || (args.serverupdatetrust == null)) { return null; }
    const wanted = (typeof args.serverupdatetrust === 'string') ? args.serverupdatetrust.trim().toLowerCase() : args.serverupdatetrust;
    return ((wanted === 'signature') || (wanted === 'pin')) ? null : ('Invalid serverUpdateTrust "' + String(args.serverupdatetrust).substring(0, 40) + '", use "signature" or "pin". Only pins from ' + PINS_FILE + ' are trusted.');
}

// settings: { source: 'github' | 'npm' | null, repository, trust: 'signature' | 'pin', error } from the (lower case) server arguments
function resolveSettings(args) {
    args = args || {};
    const given = (args.serverupdatesource == null) ? 'github' : args.serverupdatesource;
    const source = (typeof given === 'string') ? given.trim().toLowerCase() : given;
    const trust = trustSetting(args);
    if ((source !== 'github') && (source !== 'npm')) { return { source: null, repository: null, trust: trust, error: 'Invalid serverUpdateSource "' + String(given).substring(0, 40) + '", use "github" or "npm". Server updates are disabled.' }; }
    if (source === 'npm') { return { source: 'npm', repository: null, trust: trust, error: null }; }
    const repository = (args.serverupdaterepository == null) ? DEFAULT_REPOSITORY : args.serverupdaterepository;
    if (!validRepository(repository)) { return { source: null, repository: null, trust: trust, error: 'Invalid serverUpdateRepository, expected "owner/repo". GitHub server update checks are disabled.' }; }
    return { source: 'github', repository: repository, trust: trust, error: null };
}

// ---- install layout and permission (who may update, and where) ----
const LAYOUT_MESSAGES = {
    'windows-service': 'MeshCentral runs as a Windows service and cannot update itself. Update it by hand.',
    'container': 'MeshCentral runs in a container. Update the container image to install a new version.',
    'not-package': 'MeshCentral is not installed as node_modules/meshcentral, so it cannot update itself. Update it by hand (see docs/fork-updates.md).'
};
const PERMISSION_MESSAGE = 'Only a full administrator of the default domain can start a server update.';
const MYSERVER_MESSAGE = 'Server updates are turned off for your account (My Server rights).';
const LOGIN_TOKEN_MESSAGE = 'Sign in with your password, not a login token, to start a server update.';

// Whether this installation can update itself. "npm install <tarball>" puts the new code in <parentpath>/node_modules/meshcentral,
// so the running code must be that very folder; in a container or a git clone the install would succeed but change nothing.
// dirname: __dirname of meshcentral.js; env: process.env; daemon: true when <dirname>/daemon exists (Windows service).
// Returns { allowed, reason, message }.
function installLayout(options) {
    options = options || {};
    const env = options.env || {};
    if (options.daemon === true) { return { allowed: false, reason: 'windows-service', message: LAYOUT_MESSAGES['windows-service'] }; }
    if (env.MESHCENTRAL_CONTAINER === '1') { return { allowed: false, reason: 'container', message: LAYOUT_MESSAGES['container'] }; }
    if ((typeof options.dirname !== 'string') || !/[\\/]node_modules[\\/]meshcentral[\\/]?$/.test(options.dirname)) { return { allowed: false, reason: 'not-package', message: LAYOUT_MESSAGES['not-package'] }; }
    return { allowed: true, reason: null, message: null };
}

// Whether the exit of the server process is a server update: it announced one in its output (xrestart 3) and ended with the exit code of
// performServerUpdate (200). The output alone is not enough: text printed by anything that reaches the console must not turn a crash into an update.
function isUpdateExit(xrestart, error) { return (xrestart === 3) && (error != null) && (error.code === 200); }

// The "update" field of the serverversion reply: whether this user may update this server now, and the first reason when not. A refusal of the user
// that is about who they are (another domain, a login token) comes before what the installation looks like, so it does not tell them about the installation.
// avail: { allowed, reason, message } of the server, perm: the same from updatePermission.
function updateStatus(avail, perm) {
    const first = (!perm.allowed && ((perm.reason === 'not-default-domain') || (perm.reason === 'login-token'))) ? perm : (avail.allowed ? perm : avail);
    return { allowed: (avail.allowed && perm.allowed), reason: first.reason, message: first.message };
}

// The login token of a session, or null for a login with a password. A login with the form sets loginToken; a login of a WebSocket
// (meshctrl with a token, scripts) sets tokenUser. Both mean "signed in with a login token".
function sessionLoginToken(session) {
    if (session == null) { return null; }
    if (session.loginToken != null) { return session.loginToken; }
    if (session.tokenUser != null) { return session.tokenUser; }
    return null;
}

// Who may start a server update: a full administrator of the default domain, not signed in with a login token, in a domain
// whose My Server settings allow the upgrade (true, an object with upgrade === true, or no setting at all).
// Returns { allowed, reason, message }.
function updatePermission(options) {
    options = options || {};
    const refuse = function (reason) { return { allowed: false, reason: reason, message: (reason === 'login-token') ? LOGIN_TOKEN_MESSAGE : ((reason === 'myserver') ? MYSERVER_MESSAGE : PERMISSION_MESSAGE) }; };
    if (options.loginToken != null) { return refuse('login-token'); }
    if (options.siteadmin !== 0xFFFFFFFF) { return refuse('not-full-admin'); }
    if (options.domainId !== '') { return refuse('not-default-domain'); }
    const myserver = options.myserver;
    if ((myserver === false) || ((myserver != null) && (myserver !== true) && (myserver.upgrade !== true))) { return refuse('myserver'); }
    return { allowed: true, reason: null, message: null };
}

// ---- npm command lines (source "npm"), exactly the strings the server always used ----
function npmProxyFlag(npmproxy) { return (typeof npmproxy === 'string') ? (' --proxy ' + npmproxy) : ''; }
function npmCommandLine(npmpath, npmproxy, kind, version) {
    const proxy = npmProxyFlag(npmproxy);
    switch (kind) {
        case 'latest': return npmpath + proxy + ' view meshcentral dist-tags.latest';
        case 'tags': return npmpath + proxy + ' dist-tag ls meshcentral';
        case 'versions': return npmpath + proxy + ' view meshcentral versions --json';
        case 'install': return npmpath + ' install --save-exact --no-audit meshcentral' + (version || '') + proxy;
    }
    throw new Error('Unknown npm command');
}

// ---- local install (source "github") ----
// The command line for "npm install <tarball>". Like for the npm source, npmPath is a shell command line (it may hold
// quotes, "node /path/npm-cli.js", environment variables), so the command is run by the shell. The only dynamic parts, the
// tarball path and the proxy, are quoted for the shell and refused when they hold a character that cannot be quoted safely.
// The tarball name is fixed (meshcentral-<validated version>.tgz); only the data folder, which the administrator
// configures, can contribute special characters.
function shellQuote(word, platform) {
    if (typeof word !== 'string' || word.length === 0 || /[\u0000-\u001f\u007f]/.test(word)) { throw new Error('A value in the npm command line is empty or holds control characters.'); }
    if (platform === 'win32') {
        // cmd.exe: inside double quotes only " and % (and ! with delayed expansion) are special
        if (/["%!^]/.test(word)) { throw new Error('A character in the npm command line or the file path is not supported on Windows (" % ! ^): ' + JSON.stringify(word).substring(0, 120)); }
        return '"' + word + '"';
    }
    if (word.indexOf("'") >= 0) { throw new Error("A single quote in the npm command line or the file path is not supported: " + JSON.stringify(word).substring(0, 120)); }
    return "'" + word + "'";
}
function buildLocalInstall(npmpath, npmproxy, tarball, platform) {
    const base = (typeof npmpath === 'string' && npmpath.length > 0) ? npmpath : 'npm';
    // --ignore-scripts: neither the package nor any dependency in its npm-shrinkwrap.json has an install script, so no
    // lifecycle script of the downloaded tree has to run (and none can).
    return base + ' install --save-exact --no-audit --ignore-scripts ' + shellQuote(tarball, platform) + ((typeof npmproxy === 'string') ? (' --proxy ' + shellQuote(npmproxy, platform)) : '');
}

// One file of a .tgz made by npm pack (an entry name such as package/package.json), as a Buffer, read without extracting. Rejects when it is missing or too large.
// The whole archive is read, and the answer is only given when the file is there exactly once, under exactly that name: tar tools (and npm) extract the LAST copy of
// a name, so a package with two entries of one name, or with a pax or GNU header that changes the path of an entry to that name, would show one file here and
// install another. Both are refused. Pax headers (x, g) and GNU long names (L) are read for that purpose only; a size in a pax header is honoured to stay in step.
function readTgzEntry(file, entryName, limit) {
    limit = limit || (1024 * 1024);
    const HEADER_LIMIT = 64 * 1024; // the data of a pax or GNU header
    return new Promise(function (resolve, reject) {
        const input = fs.createReadStream(file), gunzip = zlib.createGunzip();
        let header = Buffer.alloc(0), skip = 0, settled = false;
        let capture = null;      // { kind: 'file' | 'meta', remaining, chunks, type, padding }
        let pending = null;      // { path, size } from the pax or GNU header before the next entry
        let matches = 0, found = null;
        const finish = function (err, value) { if (settled) { return; } settled = true; input.destroy(); gunzip.destroy(); if (err) { reject(err); } else { resolve(value); } };
        const invalid = function () { return new Error('The package is not a valid tar archive.'); };
        const normal = function (name) { return path.posix.normalize(String(name).replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/^\/+/, ''); };
        // The records of a pax header: "<length> <key>=<value>\n"; text that does not parse is ignored
        const paxRecords = function (bytes) {
            const records = {}; let at = 0;
            while (at < bytes.length) {
                const space = bytes.indexOf(0x20, at); if (space < 0) { break; }
                const length = parseInt(bytes.subarray(at, space).toString('latin1'), 10);
                if (!Number.isInteger(length) || (length <= (space - at + 1)) || (at + length > bytes.length)) { break; }
                const record = bytes.subarray(space + 1, at + length - 1).toString('utf8'), eq = record.indexOf('=');
                if (eq > 0) { records[record.substring(0, eq)] = record.substring(eq + 1); }
                at += length;
            }
            return records;
        };
        const endOfData = function () {
            const done = capture; capture = null;
            skip = done.padding;
            const bytes = Buffer.concat(done.chunks);
            if (done.kind === 'file') { found = bytes; return true; }
            if (done.type === 'L') { pending = Object.assign(pending || {}, { path: bytes.toString('utf8').replace(/\0.*$/s, '') }); }
            else if (done.type === 'x') {
                const records = paxRecords(bytes);
                const next = pending || {};
                if (records.path !== undefined) { next.path = records.path; }
                if (records.size !== undefined) { const size = parseInt(records.size, 10); if (!Number.isInteger(size) || size < 0) { return finish(invalid()); } next.size = size; }
                pending = next;
            } else if (done.type === 'g') { if (paxRecords(bytes).path !== undefined) { return finish(new Error('The package has a global pax header with a path; it is refused.')); } }
            return true;
        };
        gunzip.on('data', function (chunk) {
            let pos = 0;
            while (!settled && pos < chunk.length) {
                if (capture != null) {
                    const take = Math.min(capture.remaining, chunk.length - pos);
                    capture.chunks.push(chunk.subarray(pos, pos + take)); capture.remaining -= take; pos += take;
                    if (capture.remaining === 0) { if (endOfData() !== true) { return; } }
                } else if (skip > 0) {
                    const take = Math.min(skip, chunk.length - pos); skip -= take; pos += take;
                } else {
                    const need = 512 - header.length, take = Math.min(need, chunk.length - pos);
                    header = Buffer.concat([header, chunk.subarray(pos, pos + take)]); pos += take;
                    if (header.length < 512) { continue; }
                    const block = header; header = Buffer.alloc(0);
                    if (block.every(function (b) { return b === 0; })) { continue; }
                    const cut = function (from, to) { const x = block.subarray(from, to); const z = x.indexOf(0); return x.subarray(0, z < 0 ? x.length : z).toString('utf8'); };
                    const rawName = cut(0, 100), prefix = cut(345, 500), type = String.fromCharCode(block[156] || 48);
                    let size = parseInt(cut(124, 136).trim() || '0', 8);
                    if (!Number.isFinite(size) || size < 0) { return finish(invalid()); }
                    const padding = function (n) { return Math.ceil(n / 512) * 512 - n; };
                    if ((type === 'x') || (type === 'g') || (type === 'L')) {
                        if (size > HEADER_LIMIT) { return finish(new Error('A header in the package is too large.')); }
                        if (size === 0) { continue; }
                        capture = { kind: 'meta', type: type, remaining: size, chunks: [], padding: padding(size) };
                        continue;
                    }
                    // An entry; the headers before it may have changed its name and its size
                    const override = pending; pending = null;
                    if ((override != null) && (override.size !== undefined)) { size = override.size; }
                    const rawFull = ((override != null) && (override.path !== undefined)) ? override.path : ((prefix ? prefix + '/' : '') + rawName);
                    if (normal(rawFull) === entryName) {
                        matches++;
                        if (matches > 1) { return finish(new Error(entryName + ' is in the package more than once; it is refused.')); }
                        if ((override != null) && (override.path !== undefined)) { return finish(new Error('A header of the package sets the path of ' + entryName + '; it is refused.')); }
                        if (rawFull !== entryName) { return finish(new Error(entryName + ' is in the package under another spelling of its name; it is refused.')); }
                        if ((type !== '0') && (type !== '\0')) { return finish(new Error(entryName + ' in the package is not a regular file.')); }
                        if (size === 0 || size > limit) { return finish(new Error(entryName + ' in the package has an unexpected size.')); }
                        capture = { kind: 'file', type: type, remaining: size, chunks: [], padding: padding(size) };
                    } else { skip = size + padding(size); }
                }
            }
        });
        gunzip.on('end', function () {
            if (settled) { return; }
            if (capture != null) { return finish(invalid()); }
            if (matches === 0) { return finish(new Error(entryName + ' was not found in the package.')); }
            finish(null, found);
        });
        gunzip.on('error', function () { finish(new Error('The package is not a valid gzip archive.')); });
        input.on('error', function (err) { finish(err); });
        input.pipe(gunzip);
    });
}

// Version of the package.json inside a .tgz made by npm pack (entry package/package.json), read without extracting.
function readTgzPackageJson(file, limit) {
    return readTgzEntry(file, 'package/package.json', limit).then(function (bytes) {
        try { return JSON.parse(bytes.toString('utf8')); } catch (ex) { throw new Error('package/package.json in the package is not valid JSON.'); }
    });
}

// The lowest Node.js version a package asks for in engines.node, as [major, minor, patch], or null. Only a plain lower bound is read
// (">=22.21.1", also followed by further terms such as "<26"). A missing field or any other form of range is not checked here: the new
// version still checks Node.js itself when it starts.
function requiredNodeVersion(pkg) {
    const range = (pkg != null) && (pkg.engines != null) && (typeof pkg.engines === 'object') ? pkg.engines.node : null;
    if ((typeof range !== 'string') || (range.length > 64) || (range.indexOf('||') >= 0)) { return null; }
    const m = /^\s*>=\s*v?(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?(?=\s|$)/.exec(range);
    return (m == null) ? null : [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}
// true when the Node.js version text (process.versions.node, "22.12.0") is at least the [major, minor, patch] a package asks for.
// The parts are read the way the start check of the server reads them (common.versionAtLeast): a part that is not a plain number counts
// as 0, so "22.21.1-pre" is below 22.21.1 here as it is there, and a text that cannot be read is 0.0.0.
function nodeVersionMeets(running, required) {
    const have = String(running).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { const x = have[i] || 0; if (x !== required[i]) { return x > required[i]; } }
    return true;
}

// ---- signed releases: keys, signature file, manifest ----
// An error with a code and a text for the user. The text never holds a checksum.
function updateError(code, uiMessage, detail) {
    const error = new Error(detail || uiMessage);
    error.code = code;
    error.uiMessage = uiMessage;
    return error;
}

// keyId: the first 16 hex characters of the sha256 of the 32 raw bytes of the public key
function keyIdFor(raw) { return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16); }

// Strict base64url (no padding, canonical): the text decodes to exactly length bytes and encodes back to the same text
function decodeBase64Url(text, length) {
    if ((typeof text !== 'string') || !/^[A-Za-z0-9_-]+$/.test(text)) { return null; }
    const raw = Buffer.from(text, 'base64url');
    return ((raw.length === length) && (raw.toString('base64url') === text)) ? raw : null;
}

function importPublicKey(raw) { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }); }

// A key list document (the built in file or the local one) as { keys: [{ keyId, comment, raw, publicKey }], revoked: [keyId] }.
// Throws with a readable message when anything is not as specified: a damaged list must never turn into "trust less strictly".
function parseKeysDocument(text, label) {
    let data;
    try { data = JSON.parse(text); } catch (ex) { throw new Error(label + ' is not valid JSON.'); }
    if ((data == null) || (typeof data !== 'object') || (data.schemaVersion !== 1) || !Array.isArray(data.keys) || !Array.isArray(data.revoked)) { throw new Error(label + ': expected { "schemaVersion": 1, "keys": [ ... ], "revoked": [ ... ] }.'); }
    if (data.keys.length > MAX_KEYS) { throw new Error(label + ' has more than ' + MAX_KEYS + ' keys.'); }
    if (data.revoked.length > MAX_REVOKED) { throw new Error(label + ' has more than ' + MAX_REVOKED + ' revoked keys.'); }
    const keys = [], byId = new Map();
    for (const entry of data.keys) {
        if ((entry == null) || (typeof entry !== 'object') || (typeof entry.keyId !== 'string') || !/^[a-f0-9]{16}$/.test(entry.keyId)) { throw new Error(label + ': a key has an invalid keyId.'); }
        if (entry.algorithm !== 'ed25519') { throw new Error(label + ': key ' + entry.keyId + ' has an unsupported algorithm.'); }
        const raw = ((typeof entry.publicKey === 'string') && (entry.publicKey.length === 43)) ? decodeBase64Url(entry.publicKey, 32) : null;
        if (raw == null) { throw new Error(label + ': key ' + entry.keyId + ' has an invalid publicKey.'); }
        if (keyIdFor(raw) !== entry.keyId) { throw new Error(label + ': the keyId ' + entry.keyId + ' does not belong to its publicKey.'); }
        const comment = (entry.comment == null) ? '' : entry.comment;
        if ((typeof comment !== 'string') || (comment.length > 80) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(comment)) { throw new Error(label + ': key ' + entry.keyId + ' has an invalid comment.'); }
        let publicKey;
        try { publicKey = importPublicKey(raw); } catch (ex) { throw new Error(label + ': key ' + entry.keyId + ' is not an ed25519 public key.'); }
        const before = byId.get(entry.keyId);
        if (before != null) {
            if (!before.raw.equals(raw)) { throw new Error(label + ': the keyId ' + entry.keyId + ' is listed with two different keys.'); }
            continue;
        }
        const key = { keyId: entry.keyId, comment: comment, raw: raw, publicKey: publicKey };
        byId.set(entry.keyId, key);
        keys.push(key);
    }
    const revoked = [];
    for (const id of data.revoked) {
        if ((typeof id !== 'string') || !/^[a-f0-9]{16}$/.test(id)) { throw new Error(label + ': a revoked entry is not a keyId.'); }
        revoked.push(id);
    }
    return { keys: keys, revoked: revoked };
}

// Reads one key list file. A missing file is null when optional (the local list), otherwise an error. Symlinks are refused.
function readKeysFile(file, optional) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (ex) {
        if ((ex.code === 'ENOENT') && optional) { return null; }
        throw new Error('Unable to read ' + file + ': ' + ex.message);
    }
    if (!stat.isFile() || (stat.size > MAX_KEYS_BYTES)) { throw new Error(file + ' is not a regular file of at most 64 KiB.'); }
    return parseKeysDocument(fs.readFileSync(file, 'utf8'), file);
}

// The trusted keys: (built in keys + local keys) - (built in revoked + local revoked). Returns
// { keys: Map keyId -> { keyId, comment, publicKey }, revoked: Set, error: string | null }. Any error disables trust from signatures.
function loadTrustedKeys(keysFile, localKeysFile) {
    const none = function (message) { return { keys: new Map(), revoked: new Set(), error: message }; };
    let builtin, local = null;
    try {
        if (typeof keysFile !== 'string') { throw new Error('No release key file is configured.'); }
        builtin = readKeysFile(keysFile, false);
        if (typeof localKeysFile === 'string') { local = readKeysFile(localKeysFile, true); }
    } catch (ex) { return none(ex.message); }
    const all = new Map(), revoked = new Set();
    for (const list of [builtin, local]) {
        if (list == null) { continue; }
        for (const key of list.keys) {
            const before = all.get(key.keyId);
            if ((before != null) && !before.raw.equals(key.raw)) { return none('The keyId ' + key.keyId + ' is listed with two different keys.'); }
            all.set(key.keyId, key);
        }
        for (const id of list.revoked) { revoked.add(id); }
    }
    const keys = new Map();
    for (const [id, key] of all) { if (!revoked.has(id)) { keys.set(id, { keyId: id, comment: key.comment, publicKey: key.publicKey }); } }
    return { keys: keys, revoked: revoked, error: null };
}

// The signature file: { "type": "meshcentral-release-signature", "schemaVersion": 1, "signatures": [ { keyId, algorithm, signature } ] }.
// Returns [{ keyId, signature: Buffer(64) }]. Throws on anything else, including base64 that is not canonical.
function parseSignatureFile(bytes) {
    if (!Buffer.isBuffer(bytes) || (bytes.length === 0) || (bytes.length > MAX_SIGNED_BYTES)) { throw new Error('The signature file has an invalid size.'); }
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch (ex) { throw new Error('The signature file is not valid JSON.'); }
    if ((data == null) || (typeof data !== 'object') || (data.type !== 'meshcentral-release-signature') || (data.schemaVersion !== 1) || !Array.isArray(data.signatures) || (data.signatures.length < 1) || (data.signatures.length > 4)) {
        throw new Error('The signature file has an unexpected format.');
    }
    // No other fields: the file has to be what the tool of the owner writes
    if (Object.keys(data).some(function (name) { return (name !== 'type') && (name !== 'schemaVersion') && (name !== 'signatures'); })) { throw new Error('The signature file has an unexpected field.'); }
    const seen = new Set(), result = [];
    for (const entry of data.signatures) {
        if ((entry == null) || (typeof entry !== 'object') || (typeof entry.keyId !== 'string') || !/^[a-f0-9]{16}$/.test(entry.keyId) || seen.has(entry.keyId)) { throw new Error('The signature file has an invalid or repeated keyId.'); }
        if (entry.algorithm !== 'ed25519') { throw new Error('The signature file has an unsupported algorithm.'); }
        if (Object.keys(entry).some(function (name) { return (name !== 'keyId') && (name !== 'algorithm') && (name !== 'signature'); })) { throw new Error('The signature file has an unexpected field.'); }
        if ((typeof entry.signature !== 'string') || !/^[A-Za-z0-9+/]{86}==$/.test(entry.signature)) { throw new Error('The signature file has an invalid signature.'); }
        const raw = Buffer.from(entry.signature, 'base64');
        if ((raw.length !== 64) || (raw.toString('base64') !== entry.signature)) { throw new Error('The signature file has an invalid signature.'); }
        seen.add(entry.keyId);
        result.push({ keyId: entry.keyId, signature: raw });
    }
    return result;
}

// Checks the signatures over the raw bytes of the manifest. Returns { code: 'signed', keyId, comment } for the first valid signature of a trusted
// key, otherwise { code: 'revoked' | 'invalid' | 'unknown-key', keyIds }. The order of the failures: a signature of a revoked key, then a
// trusted key whose signature does not match, otherwise only unknown keys.
function verifySignatures(manifestBytes, signatures, trusted) {
    let attempted = false;
    for (const entry of signatures) {
        const key = trusted.keys.get(entry.keyId);
        if (key == null) { continue; }
        attempted = true;
        let ok = false;
        try { ok = crypto.verify(null, manifestBytes, key.publicKey, entry.signature); } catch (ex) { ok = false; }
        if (ok) { return { code: 'signed', keyId: key.keyId, comment: key.comment }; }
    }
    const revoked = signatures.filter(function (entry) { return trusted.revoked.has(entry.keyId); }).map(function (entry) { return entry.keyId; });
    if (revoked.length > 0) { return { code: 'revoked', keyIds: revoked }; }
    if (attempted) { return { code: 'invalid', keyIds: [] }; }
    return { code: 'unknown-key', keyIds: signatures.map(function (entry) { return entry.keyId; }) };
}

// The manifest after its signature was verified: strict UTF-8 JSON object with the fields below. release (optional) is the release as
// selectReleases gives it and repository the configured one; with them the manifest must say exactly what GitHub says about the release.
// Throws an error with code 'mismatch' and .field. Fields that are not known are ignored.
function checkManifest(bytes, release, repository) {
    const fail = function (field) { const e = updateError('mismatch', 'The signed manifest does not match the release on GitHub (' + field + '). Do not install it; report it to the release owner.'); e.field = field; return e; };
    if (!Buffer.isBuffer(bytes) || (bytes.length === 0) || (bytes.length > MAX_SIGNED_BYTES)) { throw fail('size of the manifest'); }
    let m;
    try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch (ex) { throw fail('manifest'); }
    if ((m == null) || (typeof m !== 'object') || Array.isArray(m)) { throw fail('manifest'); }
    if (m.type !== 'meshcentral-server-release') { throw fail('type'); }
    if (m.schemaVersion !== 1) { throw fail('schemaVersion'); }
    if (!validRepository(m.repository) || ((repository != null) && (m.repository.toLowerCase() !== String(repository).toLowerCase()))) { throw fail('repository'); }
    const version = parseVersion(m.version);
    if ((version == null) || (version.text !== m.version) || ((release != null) && (m.version !== release.version))) { throw fail('version'); }
    if ((typeof m.tag !== 'string') || (parseVersion(m.tag) == null) || (parseVersion(m.tag).text !== m.version) || ((release != null) && (m.tag !== release.tag))) { throw fail('tag'); }
    if ((m.channel !== 'stable') && (m.channel !== 'prerelease')) { throw fail('channel'); }
    if (m.asset !== assetNameFor(m.version) || ((release != null) && (m.asset !== release.asset.name))) { throw fail('asset'); }
    if (!Number.isInteger(m.size) || (m.size <= 0) || (m.size > MAX_ASSET_BYTES) || ((release != null) && (m.size !== release.asset.size))) { throw fail('size'); }
    if ((typeof m.sha256 !== 'string') || !/^[a-f0-9]{64}$/.test(m.sha256) || ((release != null) && ((release.asset.digest == null) || (m.sha256 !== release.asset.digest)))) { throw fail('sha256'); }
    if ((typeof m.sha384 !== 'string') || !/^[a-f0-9]{96}$/.test(m.sha384)) { throw fail('sha384'); }
    if ((typeof m.commit !== 'string') || !/^[a-f0-9]{40}$/.test(m.commit)) { throw fail('commit'); }
    if ((typeof m.issued !== 'string') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.issued) || !Number.isFinite(Date.parse(m.issued))) { throw fail('issued'); }
    return { type: m.type, schemaVersion: 1, repository: m.repository, version: m.version, tag: m.tag, channel: m.channel, asset: m.asset, size: m.size, sha256: m.sha256, sha384: m.sha384, commit: m.commit, issued: m.issued };
}

// The text a user sees for a status of a release. No checksums in any of them.
function statusMessage(code, info) {
    info = info || {};
    switch (code) {
        case 'signed': return 'Signed release (key ' + info.keyId + ((info.comment) ? (' ' + info.comment) : '') + '), commit ' + String(info.commit || '').substring(0, 12) + ', signed ' + info.issued + '.';
        case 'pinned': return 'Pinned by hand in serverupdate-pins.json.';
        case 'unsigned': return 'This release has no signature. It can only be installed with a pin in serverupdate-pins.json.';
        case 'unknown-key': return 'Signed with a key this server does not trust (' + (info.keyIds || []).join(', ') + '). Install the release that adds this key first.';
        case 'revoked': return 'Signed with a revoked key (' + (info.keyIds || []).join(', ') + '). Do not install it.';
        case 'invalid': return 'The signature does not match this release. Do not install it; report it to the release owner.';
        case 'mismatch': return 'The signed manifest does not match the release on GitHub (' + info.field + '). Do not install it; report it to the release owner.';
        case 'no-pin': return 'serverUpdateTrust is "pin" and this release has no pin by hand in serverupdate-pins.json.';
        case 'conflict': return 'The pin in serverupdate-pins.json differs from the signed release. Nothing is installed.';
        case 'no-keys': return 'This server version has no release keys. Updates need a pin in serverupdate-pins.json.';
        case 'keys-invalid': return 'The release key list is invalid; signed updates are disabled.';
        case 'download': return 'Unable to check the signature: ' + info.reason + '.';
    }
    return 'Unknown status.';
}

// A short reason from an error of the download client for the user: no long hex strings (checksums), no line breaks
function reasonOf(ex) {
    const text = ((ex && ex.message) ? String(ex.message) : 'unknown error').replace(/[a-f0-9]{32,}/gi, '...').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/[.]+$/, '');
    return text.substring(0, 120);
}

function createServerUpdater(options) {
    options = options || {};
    const settings = resolveSettings(options.args);
    const log = options.log || function (m) { console.log(m); };
    const now = options.now || Date.now;
    const folder = options.folder; // absolute path of the download folder
    const pinsFile = options.pinsFile; // absolute path of serverupdate-pins.json
    const nodeVersion = (typeof options.nodeVersion === 'string') ? options.nodeVersion : process.versions.node; // the Node.js that will run the installed package
    const proxy = (options.args && (typeof options.args.npmproxy === 'string')) ? options.args.npmproxy : undefined;
    const client = options.client || httpsDownloads.createClient(undefined, undefined, proxy, 'MeshCentral-ServerUpdate');
    const loggedErrors = new Map();
    let cache = null, etag = null, fetchedAt = 0, retryAt = 0, pending = null;

    function logOnce(message) {
        const last = loggedErrors.get(message) || 0;
        if (now() - last > 3600000) { loggedErrors.set(message, now()); log(message); }
    }
    if (settings.error) { log('ERROR: ' + settings.error); }

    // Release list from GitHub (cached, ETag revalidated). Resolves to the selection, or null on any failure.
    function getSelection(force) {
        if (settings.source !== 'github') { return Promise.resolve(null); }
        if (!force && cache && ((now() - fetchedAt) < CACHE_MS)) { return Promise.resolve(cache); }
        if (now() < retryAt) { return Promise.resolve(cache); }
        if (pending) { return pending; }
        const controller = new AbortController(), deadline = setTimeout(function () { controller.abort(); }, 60000);
        if (deadline.unref) { deadline.unref(); }
        pending = (async function () {
            try {
                const response = await client.getJsonIfChanged('https://api.github.com/repos/' + settings.repository + '/releases?per_page=100', etag, controller.signal);
                if (!response.unchanged) { cache = selectReleases(response.data); }
                if (response.etag) { etag = response.etag; }
                fetchedAt = now();
                return cache;
            } catch (ex) {
                if (ex && ex.retryAt) { retryAt = ex.retryAt; }
                logOnce('Server update check failed: ' + ((ex && ex.message) ? ex.message : 'unknown error'));
                return null;
            } finally { clearTimeout(deadline); pending = null; }
        })();
        return pending;
    }

    // The local pin of an exact version (canonical text) that counts now: a pin written by hand, or a pin written from a signature whose key is
    // still trusted (not revoked, listed in the key lists). With serverUpdateTrust "pin" a pin from a signature does not count. Throws a readable
    // error when there is none or the pins file is broken.
    function pinFor(version) {
        const found = pinLookup(version);
        if (found.pin == null) { throw new Error('MeshCentral ' + version + ' has no local pin in ' + pinsFile + found.reason + '. Add its size and sha384 there to allow this update (see docs/fork-updates.md).'); }
        return found.pin;
    }
    // { pin: {version,size,sha384} | null, origin: 'manual' | 'signature' | null, keyId, reason (text, why a pin was ignored) }
    function pinLookup(version) {
        if (typeof pinsFile !== 'string') { throw new Error('No server update pins file is configured.'); }
        readPins(pinsFile); // a file that is not valid stops here, whatever the entries are
        const entry = readPinEntries(pinsFile).find(function (r) { return r.version === version; });
        const none = function (reason) { return { pin: null, origin: null, keyId: null, reason: reason || '' }; };
        if (entry == null) { return none(''); }
        const pin = { version: entry.version, size: entry.size, sha384: entry.sha384 };
        if (entry.source !== 'signature') { return { pin: pin, origin: 'manual', keyId: null, reason: '' }; }
        if (settings.trust === 'pin') { return none(' (a pin from a signature does not count with serverUpdateTrust "pin")'); }
        const trusted = trustedKeys();
        if (trusted.error || (typeof entry.keyId !== 'string') || !trusted.keys.has(entry.keyId)) {
            // Whatever the reason (revoked, no longer in the lists, the lists are broken) the pin is ignored and that is reported; reason tells which
            const revoked = (typeof entry.keyId === 'string') && trusted.revoked.has(entry.keyId);
            const result = revoked ? 'revoked' : (trusted.error ? 'keys-invalid' : 'unknown-key');
            const keyId = ((typeof entry.keyId === 'string') && /^[a-f0-9]{16}$/.test(entry.keyId)) ? entry.keyId : null;
            try { onSuspicious({ version: version, result: result, keyId: keyId, reason: revoked ? 'key revoked' : (trusted.error ? 'key list invalid' : 'key not in the key lists'), message: statusMessage(result, { keyIds: [keyId || 'unknown'] }) }); } catch (ex) { }
            return none(' (its pin was written from a signature of the key ' + String(entry.keyId).substring(0, 16) + ', which is not trusted now)');
        }
        return { pin: pin, origin: 'signature', keyId: entry.keyId, reason: '' };
    }

    // ---- signed releases ----
    const keysFile = (typeof options.keysFile === 'string') ? options.keysFile : path.join(__dirname, KEYS_FILE);
    const localKeysFile = (typeof options.localKeysFile === 'string') ? options.localKeysFile : null;
    const onSuspicious = (typeof options.onSuspicious === 'function') ? options.onSuspicious : function () { };
    const onWarning = (typeof options.onWarning === 'function') ? options.onWarning : function () { };
    const inspectCache = new Map(), inspecting = new Map();
    const warned = new Set();
    let pinChain = Promise.resolve();
    if (trustSettingError(options.args)) { log('ERROR: ' + trustSettingError(options.args)); }

    function warnOnce(message) { if (!warned.has(message)) { warned.add(message); onWarning(message); } }

    // Trusted keys, read again at every use (the files are small). A broken list is one ERROR line and one warning.
    function trustedKeys() {
        const trusted = loadTrustedKeys(keysFile, localKeysFile);
        if (trusted.error) {
            logOnce('ERROR: The release key list is invalid: ' + trusted.error);
            warnOnce('The release key list is invalid: ' + trusted.error + ' Signed updates are disabled; pins in ' + PINS_FILE + ' still work.');
        }
        return trusted;
    }

    // Small text asset of a release as a Buffer: downloaded to a temporary file in the download folder, read, deleted
    async function fetchAsset(release, asset) {
        if (typeof folder !== 'string') { throw new Error('No download folder.'); }
        await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
        const temp = path.join(folder, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
        const url = 'https://github.com/' + settings.repository + '/releases/download/' + encodeURIComponent(release.tag) + '/' + encodeURIComponent(asset.name);
        try {
            const request = { limit: asset.size, signal: AbortSignal.timeout(60000) };
            if (asset.digest != null) { request.sha256 = asset.digest; }
            await client.download(url, temp, request);
            const bytes = await fs.promises.readFile(temp);
            if (bytes.length !== asset.size) { throw new Error('The size of ' + asset.name + ' does not match the release'); }
            return bytes;
        } finally { await fs.promises.unlink(temp).catch(function () { }); }
    }

    // What the signature of a release says: { code, keyId, comment, manifest, manifestSha256, keyIds, field, reason, message }. Never throws.
    // Codes: signed, no-keys, keys-invalid, unsigned, download, invalid, revoked, unknown-key, mismatch. Only the answers that come from the
    // bytes of the release are kept for 5 minutes; a failed download is not.
    async function inspect(release) {
        const trusted = trustedKeys();
        const finish = function (code, extra) { return Object.assign({ code: code, message: statusMessage(code, extra) }, extra); };
        if (trusted.error) { return finish('keys-invalid', {}); }
        if (trusted.keys.size === 0) { return finish('no-keys', {}); }
        if ((release.manifest == null) || (release.signature == null)) { return finish('unsigned', {}); }
        const fingerprint = Array.from(trusted.keys.keys()).sort().join(',') + '/' + Array.from(trusted.revoked).sort().join(',');
        const cacheKey = [release.tag, release.asset.size, release.asset.digest, release.manifest.size, release.manifest.digest, release.signature.size, release.signature.digest, fingerprint].join('|');
        const cached = inspectCache.get(cacheKey);
        if ((cached != null) && (cached.until > now())) { return cached.result; }
        if (inspecting.has(cacheKey)) { return inspecting.get(cacheKey); }
        const work = (async function () {
            let manifestBytes, signatureBytes;
            try {
                // Both are waited for, so that no temporary file is left behind when one of them fails
                const both = await Promise.allSettled([fetchAsset(release, release.manifest), fetchAsset(release, release.signature)]);
                const failed = both.find(function (r) { return r.status === 'rejected'; });
                if (failed) { throw failed.reason; }
                manifestBytes = both[0].value; signatureBytes = both[1].value;
            } catch (ex) { return finish('download', { reason: reasonOf(ex) }); }
            let result;
            try {
                // The signature first, on the raw bytes; the manifest is parsed only after it verified
                let signatures;
                try { signatures = parseSignatureFile(signatureBytes); } catch (ex) { result = finish('invalid', {}); }
                if (result == null) {
                    const verdict = verifySignatures(manifestBytes, signatures, trusted);
                    if (verdict.code !== 'signed') { result = finish(verdict.code, { keyIds: verdict.keyIds, keyId: (verdict.keyIds && verdict.keyIds[0]) || null }); }
                    else {
                        const manifest = checkManifest(manifestBytes, release, settings.repository);
                        result = finish('signed', { keyId: verdict.keyId, comment: verdict.comment, manifest: manifest, commit: manifest.commit, issued: manifest.issued, manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') });
                    }
                }
            } catch (ex) { result = finish((ex && ex.code === 'mismatch') ? 'mismatch' : 'invalid', { field: ex && ex.field }); }
            if (result.code !== 'download') { inspectCache.set(cacheKey, { until: now() + INSPECT_CACHE_MS, result: result }); }
            return result;
        })();
        inspecting.set(cacheKey, work);
        try { return await work; } finally { inspecting.delete(cacheKey); }
    }

    // Writes the pin of a verified release into the pins file, atomically. Manual pins and their unknown fields stay as they are.
    // Resolves to true when the file changed, false when the same pin was there. Rejects with code 'conflict' when the version has a
    // different pin, and with 'disabled' when the file cannot be used.
    function writeSignaturePin(entry) {
        const run = pinChain.then(function () { return writePinNow(entry); });
        pinChain = run.catch(function () { });
        return run;
    }
    function writePinNow(entry) {
        if (typeof pinsFile !== 'string') { throw updateError('disabled', 'No server update pins file is configured.'); }
        let releases;
        try {
            let stat = null;
            try { stat = fs.lstatSync(pinsFile); } catch (ex) { if (ex.code !== 'ENOENT') { throw ex; } }
            if ((stat != null) && !stat.isFile()) { throw new Error(pinsFile + ' is not a regular file.'); }
            releases = (stat == null) ? [] : readPinEntries(pinsFile).slice();
        } catch (ex) { throw updateError('disabled', 'The pins file cannot be used: ' + reasonOf(ex) + '.', ex.message); }
        const same = releases.find(function (r) { return r.version === entry.version; });
        if (same != null) {
            if ((same.size !== entry.size) || (same.sha384 !== entry.sha384)) { throw updateError('conflict', statusMessage('conflict')); }
            // The same package: nothing to write, unless the pin was written from a signature of another key (a key that was replaced since):
            // then the pin takes the key that verified it now, or it would stay unusable
            if ((same.source !== 'signature') || (same.keyId === entry.keyId)) { return false; }
            releases.splice(releases.indexOf(same), 1);
        }
        releases.push(entry);
        // Prune: at most 20 pins from signatures (the newest versions stay) and 256 in all. Manual pins are never removed.
        const fromSignature = releases.filter(function (r) { return r.source === 'signature'; }).sort(function (a, b) { return compareVersions(b.version, a.version); });
        const drop = new Set(fromSignature.slice(MAX_SIGNATURE_PINS).map(function (r) { return r.version; }));
        let kept = releases.filter(function (r) { return !drop.has(r.version); });
        if (kept.length > MAX_PINS) {
            const extra = kept.length - MAX_PINS;
            const oldest = kept.filter(function (r) { return r.source === 'signature'; }).sort(function (a, b) { return compareVersions(a.version, b.version); }).slice(0, extra).map(function (r) { return r.version; });
            const gone = new Set(oldest);
            kept = kept.filter(function (r) { return !gone.has(r.version); });
        }
        if ((kept.length > MAX_PINS) || !kept.some(function (r) { return r.version === entry.version; })) { throw updateError('disabled', 'The pins file has no room for this pin.'); }
        const directory = path.dirname(pinsFile);
        fs.mkdirSync(directory, { recursive: true });
        const temp = path.join(directory, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
        let fd = null;
        try {
            fd = fs.openSync(temp, 'wx', 0o600);
            fs.writeSync(fd, JSON.stringify({ schemaVersion: 1, releases: kept }, null, 2) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd); fd = null;
            fs.renameSync(temp, pinsFile);
            try { const dirFd = fs.openSync(directory, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch (ex2) { } // keep the rename after a power loss (not possible on every system)
        } catch (ex) {
            if (fd != null) { try { fs.closeSync(fd); } catch (ex2) { } }
            try { fs.unlinkSync(temp); } catch (ex2) { }
            throw updateError('disabled', 'The pins file cannot be written: ' + reasonOf(ex) + '.', ex.message);
        }
        log('Pinned MeshCentral ' + entry.version + ' from its signed manifest (key ' + entry.keyId + ').');
        return true;
    }

    // The pin an administrator wrote by hand for a version (no source "signature"), or null
    function manualPin(version) {
        const entry = readPinEntries(pinsFile).find(function (r) { return (r.version === version) && (r.source !== 'signature'); });
        return (entry == null) ? null : entry;
    }

    // A result that points to a wrong or hostile release: the caller makes an event and a warning of it
    function suspicious(release, result, keyId, message) {
        try { onSuspicious({ version: release.version, result: result, keyId: keyId || null, message: message }); } catch (ex) { }
    }

    // The release the server may install now, with its pin on disk: { version, size, sha384, source: 'signature' | 'pin', keyId }.
    // Throws errors with .code and .uiMessage. options.current: installed version (a release must be newer, unless options.allowOlder);
    // options.automatic: nightly update; options.stableOnly: the administrator chose "Stable". Both need a stable release by the signed manifest
    // (the flag of GitHub alone cannot make a test release stable, and a pin by hand does not change that, unless the pin says allowAutomatic: true).
    async function ensureTrusted(version, options) {
        options = options || {};
        if (settings.source !== 'github') { throw updateError('disabled', settings.error || 'GitHub updates are not enabled.'); }
        let release;
        try { release = await resolve(version); } catch (ex) { throw updateError('release', reasonOf(ex) + '.', ex.message); }
        if ((options.current != null) && (options.allowOlder !== true) && (compareVersions(release, options.current) <= 0)) {
            throw updateError('not-newer', 'Release ' + release.version + ' is not newer than the installed version ' + options.current + '.');
        }
        let manual;
        try { manual = manualPin(release.version); } catch (ex) { throw updateError('disabled', 'The pins file cannot be used: ' + reasonOf(ex) + '.', ex.message); }
        const fromPin = function (pin, keyId) { return { version: release.version, size: pin.size, sha384: pin.sha384, source: 'pin', keyId: keyId || null }; };
        // Channel rule for the automatic update and for "Stable": a signed manifest that says stable, and no prerelease flag on GitHub. The flag alone is never enough
        // (it can be changed on GitHub): a release without a signed manifest needs a pin by hand with allowAutomatic: true. That setting is also the one exception for a
        // release that the manifest calls a test release, and only for the automatic update.
        const channelRefusal = function (signedChannel) {
            if (!(options.automatic || options.stableOnly)) { return null; }
            const consent = ((manual != null) && (manual.allowAutomatic === true));
            if ((signedChannel === 'stable') && !release.prerelease) { return null; }
            if ((signedChannel == null) && consent && !release.prerelease) { return null; }
            if (options.automatic && consent) { return null; }
            return updateError('prerelease', (signedChannel == null) ? ('Release ' + release.version + ' has no signed manifest that says it is stable; the pin needs "allowAutomatic": true for ' + (options.automatic ? 'the automatic update.' : 'the stable choice.')) : ('Release ' + release.version + ' is a test release and is not installed ' + (options.automatic ? 'automatically.' : 'as the stable version.')));
        };
        if (settings.trust === 'pin') {
            // Only pins written by hand count; signatures are not even downloaded
            if (manual == null) { throw updateError('no-pin', 'MeshCentral ' + release.version + ' has no pin by hand in ' + PINS_FILE + ' (serverUpdateTrust is "pin").'); }
            const refusal = channelRefusal(null);
            if (refusal) { throw refusal; }
            return fromPin(manual, null);
        }
        const verdict = await inspect(release);
        const bad = ((verdict.code === 'invalid') || (verdict.code === 'revoked') || (verdict.code === 'mismatch'));
        if (verdict.code !== 'signed') {
            if (bad) { suspicious(release, verdict.code, verdict.keyId, verdict.message); }
            if (manual != null) {
                const refusal = channelRefusal(null);
                if (refusal) { throw refusal; }
                return fromPin(manual, null);
            }
            throw updateError(verdict.code, verdict.message);
        }
        if (manual != null) {
            if ((manual.size === verdict.manifest.size) && (manual.sha384 === verdict.manifest.sha384)) {
                const refusal = channelRefusal(verdict.manifest.channel);
                if (refusal) { throw refusal; }
                return fromPin(manual, verdict.keyId);
            }
            suspicious(release, 'conflict', verdict.keyId, statusMessage('conflict'));
            throw updateError('conflict', statusMessage('conflict'));
        }
        const refusal = channelRefusal(verdict.manifest.channel);
        if (refusal) { throw refusal; }
        // The keys are read again now: a key that was revoked while the files were downloaded must not write a pin
        const latest = trustedKeys();
        if (latest.error || !latest.keys.has(verdict.keyId)) {
            const message = latest.revoked.has(verdict.keyId) ? statusMessage('revoked', { keyIds: [verdict.keyId] }) : statusMessage('unknown-key', { keyIds: [verdict.keyId] });
            if (latest.revoked.has(verdict.keyId)) { suspicious(release, 'revoked', verdict.keyId, message); }
            throw updateError(latest.revoked.has(verdict.keyId) ? 'revoked' : 'unknown-key', message);
        }
        try {
            await writeSignaturePin({ version: release.version, size: verdict.manifest.size, sha384: verdict.manifest.sha384, source: 'signature', keyId: verdict.keyId, manifestSha256: verdict.manifestSha256, addedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z') });
        } catch (ex) {
            if (ex.code === 'conflict') { suspicious(release, 'conflict', verdict.keyId, statusMessage('conflict')); }
            throw ex;
        }
        return { version: release.version, size: verdict.manifest.size, sha384: verdict.manifest.sha384, source: 'signature', keyId: verdict.keyId };
    }

    // What the version dialog shows: the key list and, for the newest stable and a newer prerelease, how far the release can be trusted. Writes nothing.
    // The answer is kept for 5 seconds and shared by all callers, so many connections make one check.
    let infoCache = null;
    function releaseInfo(current) {
        if ((infoCache != null) && (infoCache.current === current) && ((now() - infoCache.at) < 5000)) { return infoCache.promise; }
        const promise = releaseInfoNow(current);
        infoCache = { current: current, at: now(), promise: promise };
        return promise;
    }
    async function releaseInfoNow(current) {
        const trusted = trustedKeys();
        const result = { trust: settings.trust, keys: Array.from(trusted.keys.values()).map(function (k) { return { keyId: k.keyId, comment: k.comment }; }), keysError: trusted.error, releases: [] };
        const sel = await getSelection(false);
        if (sel == null) { return result; }
        for (const release of [sel.latest, sel.prerelease]) {
            if (release == null) { continue; }
            const row = { version: release.version, tag: release.tag, channel: release.prerelease ? 'prerelease' : 'stable', prerelease: release.prerelease, publishedAt: release.publishedAt, url: 'https://github.com/' + settings.repository + '/releases/tag/' + encodeURIComponent(release.tag), status: null, signature: null, keyId: null, keyComment: null, commit: null, issued: null, installable: false, message: '' };
            let manual = null, pinProblem = null;
            try { const entry = readPinEntries(pinsFile).find(function (r) { return (r.version === release.version) && (r.source !== 'signature'); }); manual = entry || null; } catch (ex) { pinProblem = reasonOf(ex); }
            if (settings.trust === 'pin') {
                row.status = (manual != null) ? 'pinned' : 'no-pin';
                row.message = statusMessage(row.status);
            } else {
                const verdict = await inspect(release);
                row.status = verdict.code;
                row.signature = verdict.code;
                row.message = verdict.message;
                if (verdict.code === 'signed') {
                    row.keyId = verdict.keyId; row.keyComment = verdict.comment; row.commit = verdict.commit; row.issued = verdict.issued; row.channel = verdict.manifest.channel;
                    if ((manual != null) && ((manual.size !== verdict.manifest.size) || (manual.sha384 !== verdict.manifest.sha384))) { row.status = 'conflict'; row.message = statusMessage('conflict'); suspicious(release, 'conflict', verdict.keyId, row.message); }
                } else if (manual != null) {
                    // A pin by hand makes the release installable, and the signature that is wrong stays visible: both are shown
                    row.status = 'pinned';
                    row.message = statusMessage('pinned') + (((verdict.code === 'invalid') || (verdict.code === 'revoked') || (verdict.code === 'mismatch')) ? (' But: ' + verdict.message) : '');
                    if ((verdict.code === 'invalid') || (verdict.code === 'revoked') || (verdict.code === 'mismatch')) { suspicious(release, verdict.code, verdict.keyId, verdict.message); }
                }
            }
            if (pinProblem != null) { row.message += ' (The pins file cannot be used: ' + pinProblem + '.)'; }
            row.installable = ((row.status === 'signed') || (row.status === 'pinned')) && (pinProblem == null) && (current != null) && (compareVersions(release, current) > 0);
            result.releases.push(row);
        }
        return result;
    }

    // Resolve a version to an installable release. version: null/'latest'/'stable' = newest stable release.
    async function resolve(version) {
        if (settings.source !== 'github') { throw new Error(settings.error || 'GitHub updates are not enabled.'); }
        const sel = await getSelection(false);
        if (sel == null) { throw new Error('Unable to read the release list of ' + settings.repository + '.'); }
        const newest = ((version == null) || (version === '') || (version === 'latest') || (version === 'stable'));
        let release;
        if (newest) { release = sel.latest; }
        else {
            const parsed = parseVersion(String(version));
            if (parsed == null) { throw new Error('"' + String(version).substring(0, 40) + '" is not a release version.'); }
            release = sel.usable.find(function (r) { return compareVersions(r, parsed) === 0; });
        }
        if (!release) { throw new Error('No usable ' + (newest ? 'stable' : String(version).substring(0, 40)) + ' release with a meshcentral-<version>.tgz asset in ' + settings.repository + '.'); }
        return release;
    }

    return {
        settings: settings,
        keysFile: keysFile,
        folder: folder,
        pinsFile: pinsFile,
        getSelection: getSelection,
        pinFor: pinFor,
        pinLookup: pinLookup,
        hasUsablePin: function (version) { try { return pinLookup(version).pin != null; } catch (ex) { return false; } },

        // cb(currentVersion, latestVersion | null)
        getLatest: function (current, callback) {
            getSelection(false).then(function (sel) { callback(current, (sel && sel.latest) ? sel.latest.version : null); }, function () { callback(current, null); });
        },

        // cb({ current, stable, latest, prerelease }) filtered by the npmTag setting like the npm path
        getTags: function (current, callback) {
            getSelection(false).then(function (sel) {
                const tags = { current: current };
                const all = {};
                if (sel && sel.latest) { all.stable = sel.latest.version; all.latest = sel.latest.version; }
                if (sel && sel.prerelease) { all.prerelease = sel.prerelease.version; }
                const wanted = (options.args && (typeof options.args.npmtag === 'string')) ? options.args.npmtag : null;
                for (const name in all) { if ((wanted == null) || (wanted === name)) { tags[name] = all[name]; } }
                callback(tags);
            }, function () { callback({ current: current }); });
        },

        // cb(jsonString): array of installable versions, oldest first. '[]' when unknown.
        getVersions: function (callback) {
            getSelection(false).then(function (sel) {
                callback(JSON.stringify(sel ? sel.usable.map(function (r) { return r.version; }).reverse() : []));
            }, function () { callback('[]'); });
        },

        resolve: resolve,
        ensureTrusted: ensureTrusted,
        releaseInfo: releaseInfo,
        writeSignaturePin: writeSignaturePin,

        // The parent process has no database: when it refuses a release because of its signature (a key revoked while it downloads), it leaves a marker that the
        // server process turns into the event serverupdateverify at its next start (consumeRefusal returns it once and deletes the file).
        recordRefusal: function (info) {
            if (typeof folder !== 'string') { return; }
            try {
                fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
                const temp = path.join(folder, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
                fs.writeFileSync(temp, JSON.stringify({ version: String(info.version).substring(0, 40), result: String(info.result).substring(0, 20), keyId: ((typeof info.keyId === 'string') && /^[a-f0-9]{16}$/.test(info.keyId)) ? info.keyId : null, reason: String(info.reason || '').substring(0, 60), message: String(info.message || '').substring(0, 300), time: now() }), { mode: 0o600 });
                fs.renameSync(temp, path.join(folder, REFUSAL_FILE));
            } catch (ex) { log('Unable to save the refusal marker: ' + ex.message); }
        },
        // The marker of a refusal by the parent process, or null when there is none. A marker that cannot be read (damaged, too large, not a plain file, an
        // unknown result) is returned as { corrupt: true, ... }: it is reported too, without any of its content. The file stays until clearRefusal(), which the
        // server process calls once the event is stored, so a failing database does not lose the report.
        consumeRefusal: function () {
            if (typeof folder !== 'string') { return null; }
            const file = path.join(folder, REFUSAL_FILE);
            const corrupt = { corrupt: true, version: null, result: 'corrupt refusal marker', keyId: null, reason: 'corrupt refusal marker', message: 'The refusal marker of a server update could not be read.' };
            let stat;
            try { stat = fs.lstatSync(file); } catch (ex) { return null; }
            if (!stat.isFile() || (stat.size > 4096)) { return corrupt; }
            let marker;
            try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (ex) { return corrupt; }
            if ((marker == null) || (typeof marker !== 'object') || (parseVersion(marker.version) == null) || (['invalid', 'revoked', 'mismatch', 'conflict', 'unknown-key', 'keys-invalid'].indexOf(marker.result) < 0)) { return corrupt; }
            return { version: marker.version, result: marker.result, keyId: ((typeof marker.keyId === 'string') && /^[a-f0-9]{16}$/.test(marker.keyId)) ? marker.keyId : null, reason: String(marker.reason || ''), message: String(marker.message || '') };
        },
        clearRefusal: function () { if (typeof folder === 'string') { try { fs.unlinkSync(path.join(folder, REFUSAL_FILE)); } catch (ex) { } } },

        // Download and verify the release asset against the local pin and the GitHub digest. Resolves to { path, assetName, version, tag, sha256, sha384, size }.
        // options.current: the installed version. Without a version ("newest") the release must be newer than it, and with
        // a version it must be newer too unless options.allowDowngrade (the administrator named that exact version).
        prepare: async function (version, options) {
            options = options || {};
            const release = await this.resolve(version);
            if (options.current != null) {
                const newest = ((version == null) || (version === '') || (version === 'latest') || (version === 'stable'));
                const order = compareVersions(release, options.current);
                if (newest && (order <= 0)) { throw new Error('The newest release ' + release.version + ' is not newer than the installed version ' + options.current + '.'); }
                if (!newest && (order === 0)) { throw new Error('Release ' + release.version + ' is already installed.'); }
                if (!newest && (order < 0) && !options.allowDowngrade) { throw new Error('Release ' + release.version + ' is older than the installed version ' + options.current + ', a downgrade is not done automatically.'); }
            }
            const pin = pinFor(release.version);
            if (pin.size !== release.asset.size) { throw new Error('Release ' + release.tag + ' has ' + release.asset.size + ' bytes in ' + release.asset.name + ', the local pin in ' + pinsFile + ' says ' + pin.size + ' bytes; nothing was downloaded.'); }
            if (release.asset.digest == null) { throw new Error('Release ' + release.tag + ' has no sha256 digest for ' + release.asset.name + ' in the GitHub API; it will not be installed.'); }
            if (typeof folder !== 'string') { throw new Error('No download folder.'); }
            await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
            const target = path.join(folder, release.asset.name);
            const temp = path.join(folder, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
            const url = 'https://github.com/' + settings.repository + '/releases/download/' + encodeURIComponent(release.tag) + '/' + encodeURIComponent(release.asset.name);
            try {
                const result = await client.download(url, temp, { limit: pin.size, signal: options.signal, sha256: release.asset.digest });
                if (result.size !== release.asset.size) { throw new Error('The downloaded size does not match the release (' + result.size + ' of ' + release.asset.size + ' bytes).'); }
                if (result.sha256 !== release.asset.digest) { throw new Error('The downloaded SHA256 does not match the release digest.'); }
                const local = await fileSha384(temp);
                if ((local.size !== pin.size) || (local.sha384 !== pin.sha384)) { throw new Error('The downloaded ' + release.asset.name + ' does not match the local pin in ' + pinsFile + ' (' + local.size + ' bytes, sha384 ' + local.sha384 + '; pinned ' + pin.size + ' bytes, sha384 ' + pin.sha384 + ').'); }
                // The package must be the version the release announces, or the server would update again and again
                let inner;
                try { inner = await readTgzPackageJson(temp); } catch (ex) { throw new Error('Unable to read package.json from ' + release.asset.name + ': ' + ex.message); }
                // The text must match exactly: 1.3.1-custom.1 and 1.3.1.1 are one version in ordering but different packages
                if ((inner == null) || (inner.version !== release.version)) { throw new Error('The package ' + release.asset.name + ' holds version ' + String(inner && inner.version).substring(0, 40) + ', not ' + release.version + '.'); }
                if (inner.name !== 'meshcentral') { throw new Error('The package ' + release.asset.name + ' is named ' + String(inner.name).substring(0, 40) + ', not meshcentral.'); }
                // The pin is looked at once more: a pin from a signature whose key was revoked during the download does not install anything
                const again = pinLookup(release.version);
                if ((again.pin != null) && ((again.pin.size !== pin.size) || (again.pin.sha384 !== pin.sha384))) { try { onSuspicious({ version: release.version, result: 'conflict', keyId: null, reason: 'pin changed during the download', message: statusMessage('conflict') }); } catch (ex) { } }
                if ((again.pin == null) || (again.pin.size !== pin.size) || (again.pin.sha384 !== pin.sha384)) { throw new Error('The pin of ' + release.version + ' does not count any more' + (again.reason || '') + '; nothing was installed.'); }
                // Last, the package must run on this Node.js: a server that installs it on an older one does not start again
                const needNode = requiredNodeVersion(inner);
                if ((needNode != null) && !nodeVersionMeets(nodeVersion, needNode)) { throw new Error('Release ' + release.version + ' needs Node.js ' + needNode.join('.') + ' or newer, this server runs Node.js ' + String(nodeVersion).substring(0, 20) + '. Update Node.js first; nothing was installed.'); }
                await fs.promises.chmod(temp, 0o600);
                await fs.promises.rename(temp, target);
            } finally { await fs.promises.unlink(temp).catch(function () { }); }
            return { path: target, assetName: release.asset.name, version: release.version, tag: release.tag, sha256: release.asset.digest, sha384: pin.sha384, size: release.asset.size };
        },

        // Remove downloaded packages other than the one that is installed now. The installed one must stay: npm records it
        // as a file: dependency in package.json and needs it for later installs.
        cleanup: async function (keepAssetName) {
            if (typeof folder !== 'string') { return; }
            let names;
            try { names = await fs.promises.readdir(folder); } catch (ex) { return; }
            for (const name of names) {
                if ((/^meshcentral-[0-9][0-9.]*(-custom\.[0-9]+)?\.tgz$/.test(name) && (name !== keepAssetName)) || /^\.[0-9a-f]{32}\.tmp$/.test(name)) { await fs.promises.unlink(path.join(folder, name)).catch(function () { }); }
            }
        },

        // Failure marker: an automatic update to this version is not tried again for FAILURE_RETRY_MS. The files are small and
        // the calls are synchronous so they can be used at server start. Returns the marker when it blocks, else null.
        failureBlocks: function (version) {
            if (typeof folder !== 'string') { return null; }
            try {
                const marker = JSON.parse(fs.readFileSync(path.join(folder, FAILURE_FILE), 'utf8'));
                const wanted = parseVersion(String(version));
                if ((marker == null) || (wanted == null) || (compareVersions(marker.version, wanted) !== 0)) { return null; }
                if (!Number.isFinite(marker.time) || (now() - marker.time >= FAILURE_RETRY_MS) || (marker.time > now() + 60000)) { return null; }
                return { version: marker.version, time: marker.time, reason: String(marker.reason || '') };
            } catch (ex) { return null; }
        },
        recordFailure: function (version, reason) {
            if ((typeof folder !== 'string') || (parseVersion(String(version)) == null)) { return; }
            try {
                fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
                const temp = path.join(folder, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
                fs.writeFileSync(temp, JSON.stringify({ version: parseVersion(String(version)).text, time: now(), reason: String(reason || '').substring(0, 500) }), { mode: 0o600 });
                fs.renameSync(temp, path.join(folder, FAILURE_FILE));
            } catch (ex) { log('Unable to save the update failure marker: ' + ex.message); }
        },
        clearFailure: function () { try { fs.unlinkSync(path.join(folder, FAILURE_FILE)); } catch (ex) { } }
    };
}


// ---- the parent process: installing a verified package ----
// The parent process (meshcentral.js, the one that restarts the server) runs this after the server process exited with the update code.
// meshcentral.js loads this module freshly from the installed package before it calls it (see loadParentUpdateModule), so the
// installing logic is the one of the running, already verified version and not the one the parent started with.
// ctx: { args, config, datapath, parentpath, dirname, platform, env, npmpath, getCurrentVersion, log, relaunch(delayMs), childProcess, fs, path }
// plus, for tests only, ctx.updater. Returns { run({ target, pinned }), onChildExit(info), onChildOutput(line) }. The last two do nothing yet.
function createParentUpdate(ctx) {
    const log = ctx.log || function (m) { console.log(m); };
    const fsModule = ctx.fs || fs, pathModule = ctx.path || path, childProcess = ctx.childProcess || require('child_process');
    const args = ctx.args || {};
    const npmpath = (typeof ctx.npmpath === 'string') ? ctx.npmpath : ((typeof args.npmpath === 'string') ? args.npmpath : 'npm');
    const getCurrentVersion = ctx.getCurrentVersion || function () { return null; };

    // target: the exact version the server decided on, or null for the newest release. pinned: the version came from the configuration
    // (selfUpdate: "<version>"), so it is installed even when it is older than the installed one.
    function run(request) {
        request = request || {};
        const target = (request.target == null) ? null : request.target, pinned = (request.pinned === true);
        const env = Object.assign({}, ctx.env || process.env); // Shallow clone
        if (typeof args.npmproxy === 'string') { env['HTTP_PROXY'] = env['HTTPS_PROXY'] = env['http_proxy'] = env['https_proxy'] = args.npmproxy; }
        // The key lists are the ones of the running package and of the data folder: a pin from a signature counts only while its key is trusted
        let created = null;
        const updater = ctx.updater || (created = createServerUpdater({ args: args, folder: pathModule.resolve(ctx.datapath, FOLDER_NAME), pinsFile: pathModule.resolve(ctx.datapath, PINS_FILE),
            keysFile: pathModule.join(ctx.dirname, KEYS_FILE), localKeysFile: pathModule.resolve(ctx.datapath, KEYS_FILE), log: log,
            // The parent has no database: the refusal is logged and left in a marker for the server process, which makes the event of it at its next start
            onSuspicious: function (info) { log('WARNING: Release ' + info.version + ' was refused: ' + info.message); if (created != null) { created.recordRefusal(info); } } }));

        // Runs after npm finished, or after the update was given up. Restarts the server in all cases.
        function finishUpdate(code) {
            if (code == 0) { log('Update completed...'); }

            // Run the server updated script if present
            if (ctx.config && ctx.config.settings && (typeof ctx.config.settings.runonserverupdated == 'string')) {
                var parentpath = ctx.dirname;
                if (/[\\/]node_modules[\\/]meshcentral[\\/]?$/.test(ctx.dirname)) { parentpath = pathModule.join(ctx.dirname, '../..'); }
                childProcess.exec(ctx.config.settings.runonserverupdated + ' ' + getCurrentVersion(), { maxBuffer: 512000, timeout: 120000, cwd: parentpath }, function (error, stdout, stderr) { });
            }

            if (args.cleannpmcacheonupdate === true) {
                // Perform NPM cache clean
                log('Cleaning NPM cache...');
                const xxxprocess = childProcess.exec(npmpath + ' cache clean --force', { maxBuffer: Infinity, cwd: ctx.parentpath, env: env }, function (error, stdout, stderr) { });
                xxxprocess.on('close', function (code) { ctx.relaunch(1000); });
            } else {
                // Run the updated server
                ctx.relaunch(1000);
            }
        }

        if (updater.settings.source !== 'github') {
            // Installing from the npm registry is blocked (performServerUpdate already refuses it); restart on the current version
            log('ERROR: ' + ((updater.settings.source === 'npm') ? NPM_INSTALL_BLOCKED : 'Server update is disabled.'));
            ctx.relaunch(1000);
            return;
        }

        // GitHub release of the fork: download and verify meshcentral-<version>.tgz, then install that file with npm.
        // The server stays on the current version when anything fails, and the failure is remembered so that the
        // automatic update does not retry the same version in a loop.
        const giveUp = function (v, message) { log('Update failed, nothing was installed: ' + message); if (v != null) { updater.recordFailure(v, message); } ctx.relaunch(5000); };
        // Without node_modules/meshcentral as the running folder, "npm install" would succeed and change nothing
        const layout = installLayout({ dirname: ctx.dirname, env: ctx.env || process.env, daemon: fsModule.existsSync(pathModule.join(ctx.dirname, 'daemon')) });
        if (!layout.allowed) { giveUp(target, layout.message); return; }
        var fileName = null;
        updater.prepare(target, { current: getCurrentVersion(), allowDowngrade: pinned, signal: AbortSignal.timeout(15 * 60 * 1000) }).then(function (pkg) {
            fileName = pkg.assetName;
            log('Installing MeshCentral ' + pkg.version + ' from ' + updater.settings.repository + ' (' + pkg.size + ' bytes, sha384 ' + pkg.sha384 + ' as pinned in ' + updater.pinsFile + ', sha256 ' + pkg.sha256 + ')...');
            var finished = false;
            const finish = function (code) {
                if (finished) return; finished = true;
                if (code != 0) { updater.recordFailure(pkg.version, 'npm install exited with code ' + code + '.'); return finishUpdate(code); }
                // The installed package must be the version that was announced, or the next check would install it again
                var installed = null;
                try { installed = JSON.parse(fsModule.readFileSync(pathModule.join(ctx.dirname, 'package.json'), 'utf8')).version; } catch (ex) { }
                if (installed !== pkg.version) {
                    log('ERROR: The installed MeshCentral version is ' + installed + ', not ' + pkg.version + ' as announced by the release.');
                    updater.recordFailure(pkg.version, 'The installed version is ' + installed + ' instead of ' + pkg.version + '.');
                } else { updater.clearFailure(); updater.cleanup(fileName).catch(function () { }); }
                finishUpdate(code);
            };
            const done = function (error, stdout, stderr) { if ((error != null) && (error != '')) { log('Update failed: ' + error); } };
            var command;
            try { command = buildLocalInstall(npmpath, args.npmproxy, pkg.path, ctx.platform); } catch (ex) { return giveUp(pkg.version, ex.message); }
            const xxprocess = childProcess.exec(command, { maxBuffer: Infinity, cwd: ctx.parentpath, env: env }, done);
            xxprocess.on('error', function (err) { log('Update failed: ' + err.message); finish(1); });
            xxprocess.on('close', finish);
        }).catch(function (err) { giveUp(target, (err && err.message) ? err.message : String(err)); });
    }

    return { run: run, onChildExit: function (info) { }, onChildOutput: function (line) { } };
}

// The parent process loads this module freshly from the installed package. requireFn() does that (it clears the cache entries of this module
// and of httpsdownloads.js first and requires again). Returns the fresh module, or fallback (the module the parent started with) when
// loading throws or the module does not speak the same API version. log gets the reason.
function loadParentUpdateModule(requireFn, fallback, log) {
    let reason = null, loaded = null;
    try { loaded = requireFn(); } catch (ex) { reason = 'loading failed: ' + ((ex && ex.message) ? String(ex.message).substring(0, 200) : 'unknown error'); }
    if (reason == null) {
        if ((loaded == null) || (loaded.PARENT_API_VERSION !== PARENT_API_VERSION)) { reason = 'it has another API version'; }
        else if (typeof loaded.createParentUpdate !== 'function') { reason = 'it has no createParentUpdate'; }
    }
    if (reason == null) { return loaded; }
    if (typeof log === 'function') { log('Using the loaded server update module: ' + reason); }
    return fallback;
}

module.exports = {
    DEFAULT_REPOSITORY, FOLDER_NAME, PINS_FILE, KEYS_FILE, NPM_INSTALL_BLOCKED, MAX_ASSET_BYTES, MAX_SIGNED_BYTES, PARENT_API_VERSION, readPins, readPinEntries, parseVersion, compareVersions, validRepository, assetNameFor, parseDigest,
    selectReleases, resolveSettings, trustSettingError, installLayout, updatePermission, updateStatus, sessionLoginToken, isUpdateExit, manifestAssetName, signatureAssetName, keyIdFor, decodeBase64Url, parseKeysDocument, readKeysFile, loadTrustedKeys, parseSignatureFile, verifySignatures, checkManifest, statusMessage, createParentUpdate, loadParentUpdateModule, updateNeeded, selfUpdateValid, selfUpdateIsCurrent, selfUpgradeRequest, npmCommandLine, buildLocalInstall, shellQuote, readTgzPackageJson, requiredNodeVersion, nodeVersionMeets, readTgzEntry, createServerUpdater, FAILURE_RETRY_MS
};
