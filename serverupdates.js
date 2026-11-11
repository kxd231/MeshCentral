'use strict';

// Server self-update from GitHub releases of the fork (settings.serverUpdateSource = "github", the default),
// next to the original npm based update ("npm"). A release is usable when it carries an asset named exactly
// meshcentral-<version>.tgz. The asset is downloaded in the parent process, checked against the sha256 digest
// that the GitHub API reports for it and then handed to "npm install" as a local file.

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
const FAILURE_RETRY_MS = 24 * 3600 * 1000; // An automatic update to a version that failed is not retried for this long

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

// "sha256:<64 hex>" as reported by the GitHub API, returned as lower case hex or null
function parseDigest(digest) {
    if (typeof digest !== 'string') { return null; }
    const match = /^sha256:([A-Fa-f0-9]{64})$/.exec(digest);
    return (match == null) ? null : match[1].toLowerCase();
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
        const entry = { version: version.text, parts: version.parts, form: version.form, tag: tag, prerelease: (release.prerelease === true), asset: { name: asset.name, size: asset.size, digest: parseDigest(asset.digest) }, publishedAt: release.published_at || null };
        // One version can have several usable tags ("1.3.2" and "1.3.2.0", "1.3.1.1" and "1.3.1-custom.1"). The -custom form is
        // preferred, otherwise the first one in the list stays. A tag without a usable asset never hides the other one.
        const key = version.parts.join('.'), index = usable.findIndex(function (r) { return r.parts.join('.') === key; });
        if (index < 0) { usable.push(entry); } else if ((entry.form === 'custom') && (usable[index].form !== 'custom')) { usable[index] = entry; }
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

// settings: { source: 'github' | 'npm' | null, repository, error } from the (lower case) server arguments
function resolveSettings(args) {
    args = args || {};
    const given = (args.serverupdatesource == null) ? 'github' : args.serverupdatesource;
    const source = (typeof given === 'string') ? given.trim().toLowerCase() : given;
    if ((source !== 'github') && (source !== 'npm')) { return { source: null, repository: null, error: 'Invalid serverUpdateSource "' + String(given).substring(0, 40) + '", use "github" or "npm". Server updates are disabled.' }; }
    if (source === 'npm') { return { source: 'npm', repository: null, error: null }; }
    const repository = (args.serverupdaterepository == null) ? DEFAULT_REPOSITORY : args.serverupdaterepository;
    if (!validRepository(repository)) { return { source: null, repository: null, error: 'Invalid serverUpdateRepository, expected "owner/repo". GitHub server update checks are disabled.' }; }
    return { source: 'github', repository: repository, error: null };
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
    return base + ' install --save-exact --no-audit ' + shellQuote(tarball, platform) + ((typeof npmproxy === 'string') ? (' --proxy ' + shellQuote(npmproxy, platform)) : '');
}

// Version of the package.json inside a .tgz made by npm pack (entry package/package.json), read without extracting.
function readTgzPackageJson(file, limit) {
    limit = limit || (1024 * 1024);
    return new Promise(function (resolve, reject) {
        const input = fs.createReadStream(file), gunzip = zlib.createGunzip();
        let header = Buffer.alloc(0), skip = 0, capture = null, settled = false;
        const finish = function (err, value) { if (settled) { return; } settled = true; input.destroy(); gunzip.destroy(); if (err) { reject(err); } else { resolve(value); } };
        gunzip.on('data', function (chunk) {
            let pos = 0;
            while (!settled && pos < chunk.length) {
                if (capture != null) {
                    const take = Math.min(capture.remaining, chunk.length - pos);
                    capture.chunks.push(chunk.subarray(pos, pos + take)); capture.remaining -= take; pos += take;
                    if (capture.remaining === 0) { try { return finish(null, JSON.parse(Buffer.concat(capture.chunks).toString('utf8'))); } catch (ex) { return finish(new Error('package/package.json in the package is not valid JSON.')); } }
                } else if (skip > 0) {
                    const take = Math.min(skip, chunk.length - pos); skip -= take; pos += take;
                } else {
                    const need = 512 - header.length, take = Math.min(need, chunk.length - pos);
                    header = Buffer.concat([header, chunk.subarray(pos, pos + take)]); pos += take;
                    if (header.length < 512) { continue; }
                    const block = header; header = Buffer.alloc(0);
                    if (block.every(function (b) { return b === 0; })) { continue; }
                    const cut = function (from, to) { const x = block.subarray(from, to); const z = x.indexOf(0); return x.subarray(0, z < 0 ? x.length : z).toString('utf8'); };
                    const name = cut(0, 100), prefix = cut(345, 500), type = String.fromCharCode(block[156] || 48);
                    const size = parseInt(cut(124, 136).trim() || '0', 8);
                    if (!Number.isFinite(size) || size < 0) { return finish(new Error('The package is not a valid tar archive.')); }
                    if (((prefix ? prefix + '/' : '') + name === 'package/package.json') && (type === '0')) {
                        if (size === 0 || size > limit) { return finish(new Error('package/package.json in the package has an unexpected size.')); }
                        capture = { remaining: size, chunks: [] };
                    } else { skip = Math.ceil(size / 512) * 512; }
                    // capture ends exactly at size; the padding after it does not matter because we stop there
                }
            }
        });
        gunzip.on('end', function () { finish(new Error('package/package.json was not found in the package.')); });
        gunzip.on('error', function () { finish(new Error('The package is not a valid gzip archive.')); });
        input.on('error', function (err) { finish(err); });
        input.pipe(gunzip);
    });
}

function createServerUpdater(options) {
    options = options || {};
    const settings = resolveSettings(options.args);
    const log = options.log || function (m) { console.log(m); };
    const now = options.now || Date.now;
    const folder = options.folder; // absolute path of the download folder
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

    return {
        settings: settings,
        folder: folder,
        getSelection: getSelection,

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

        // Resolve a version to an installable release. version: null/'latest'/'stable' = newest stable release.
        resolve: async function (version) {
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
        },

        // Download and verify the release asset. Resolves to { path, assetName, version, tag, sha256, size }.
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
            if (release.asset.digest == null) { throw new Error('Release ' + release.tag + ' has no sha256 digest for ' + release.asset.name + ' in the GitHub API; it will not be installed.'); }
            if (typeof folder !== 'string') { throw new Error('No download folder.'); }
            await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
            const target = path.join(folder, release.asset.name);
            const temp = path.join(folder, '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
            const url = 'https://github.com/' + settings.repository + '/releases/download/' + encodeURIComponent(release.tag) + '/' + encodeURIComponent(release.asset.name);
            try {
                const result = await client.download(url, temp, { limit: release.asset.size, signal: options.signal, sha256: release.asset.digest });
                if (result.size !== release.asset.size) { throw new Error('The downloaded size does not match the release (' + result.size + ' of ' + release.asset.size + ' bytes).'); }
                if (result.sha256 !== release.asset.digest) { throw new Error('The downloaded SHA256 does not match the release digest.'); }
                // The package must be the version the release announces, or the server would update again and again
                let inner;
                try { inner = await readTgzPackageJson(temp); } catch (ex) { throw new Error('Unable to read package.json from ' + release.asset.name + ': ' + ex.message); }
                // The text must match exactly: 1.3.1-custom.1 and 1.3.1.1 are one version in ordering but different packages
                if ((inner == null) || (inner.version !== release.version)) { throw new Error('The package ' + release.asset.name + ' holds version ' + String(inner && inner.version).substring(0, 40) + ', not ' + release.version + '.'); }
                if (inner.name !== 'meshcentral') { throw new Error('The package ' + release.asset.name + ' is named ' + String(inner.name).substring(0, 40) + ', not meshcentral.'); }
                await fs.promises.chmod(temp, 0o600);
                await fs.promises.rename(temp, target);
            } finally { await fs.promises.unlink(temp).catch(function () { }); }
            return { path: target, assetName: release.asset.name, version: release.version, tag: release.tag, sha256: release.asset.digest, size: release.asset.size };
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

module.exports = {
    DEFAULT_REPOSITORY, FOLDER_NAME, MAX_ASSET_BYTES, parseVersion, compareVersions, validRepository, assetNameFor, parseDigest,
    selectReleases, resolveSettings, updateNeeded, selfUpdateValid, selfUpdateIsCurrent, selfUpgradeRequest, npmCommandLine, buildLocalInstall, shellQuote, readTgzPackageJson, createServerUpdater, FAILURE_RETRY_MS
};
