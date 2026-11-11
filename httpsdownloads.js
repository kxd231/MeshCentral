'use strict';

// HTTPS downloads and GitHub API access with private-address guards. Shared by the default agent release
// downloads (agentbuilds.js) and the server self-update (serverupdates.js).

const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const httpsDownloads = (function () {
    const blocked = new net.BlockList();
    for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
        blocked.addSubnet(address, prefix, 'ipv4');
        blocked.addSubnet('64:ff9b::' + address, 96 + prefix, 'ipv6');
    }
    const global6 = new net.BlockList();
    global6.addSubnet('2000::', 3, 'ipv6');
    // DNS64 on IPv6-only networks answers with the IPv4 address inside the NAT64 well-known prefix. Those count
    // as public when the IPv4 address does, which the blocked list above checks.
    global6.addSubnet('64:ff9b::', 96, 'ipv6');
    for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(address, prefix, 'ipv6');
    function publicAddress(address) {
        const family = net.isIP(address);
        return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
    }
    function parseUrl(value) {
        if (typeof value !== 'string' || value.length > 4096) throw new Error('Enter a public HTTPS download URL.');
        let url;
        try { url = new URL(value); } catch (ex) { throw new Error('Enter a public HTTPS download URL.'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Use HTTPS on port 443 without a username, password or fragment.');
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(host) && !publicAddress(host)) throw new Error('Downloads from private or reserved addresses are not allowed.');
        return url;
    }
    function sourceUrl(value) {
        const url = parseUrl(value);
        url.search = '';
        return url.href;
    }
    function createClient(transport = https, lookup = dns.lookup, proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy, userAgent = 'MeshCentral-AgentBuilds') {
        // A forward proxy, from npmProxy in config.json or from the environment, carries each request through a
        // CONNECT tunnel. The proxy resolves the host itself, so the address checks on DNS answers do not apply behind it.
        function tunnel(options, callback) {
            let target;
            try { target = new URL(proxy); } catch (ex) { return callback(new Error('The proxy URL is not valid.')); }
            const host = options.hostname || options.host, authority = (net.isIPv6(host) ? '[' + host + ']' : host) + ':' + options.port, headers = { Host: authority };
            if (target.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(target.username) + ':' + decodeURIComponent(target.password)).toString('base64');
            const secure = target.protocol === 'https:';
            const request = (secure ? https : http).request({ host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (secure ? 443 : 80), method: 'CONNECT', path: authority, headers, agent: false, timeout: 10000 });
            request.on('connect', (res, socket) => {
                if (res.statusCode !== 200) { socket.destroy(); return callback(new Error('The proxy refused the connection (HTTP ' + res.statusCode + ').')); }
                callback(null, tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host }));
            });
            request.on('timeout', () => request.destroy(new Error('The proxy timed out.')));
            request.on('error', err => callback(new Error(/proxy/.test(err.message) ? err.message : 'Unable to reach the proxy' + (/^[A-Z0-9_]+$/.test(err.code) ? ' (' + err.code + ')' : '') + '.')));
            request.end();
        }
        async function response(value, options, redirects = 0, authenticated = true) {
            const url = parseUrl(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
            const headers = { 'User-Agent': userAgent, Accept: options.json ? 'application/vnd.github+json' : 'application/octet-stream', 'Accept-Encoding': 'identity' };
            if (url.hostname === 'api.github.com') {
                headers['X-GitHub-Api-Version'] = '2022-11-28';
                if (/\/actions\/artifacts\/\d+\/zip$/.test(url.pathname)) headers.Accept = 'application/vnd.github+json';
                if (options.token && authenticated) headers.Authorization = 'Bearer ' + options.token;
                if (options.etag) headers['If-None-Match'] = options.etag;
            }
            const res = await new Promise((resolve, reject) => {
                let timer, connecting;
                const request = transport.get(url, { headers, agent: proxy ? undefined : false, createConnection: proxy ? tunnel : undefined, defaultPort: 443, signal: options.signal, lookup: function (host, settings, callback) {
                    lookup(host, { all: true, verbatim: true }, (err, addresses) => {
                        if (err || !addresses || !addresses.length) return callback(new Error('Unable to resolve the download host.'));
                        if (addresses.some(x => !publicAddress(x.address))) return callback(new Error('Downloads from private or reserved addresses are not allowed.'));
                        // Return the checked addresses to the socket so a second lookup cannot change the destination. All
                        // of them, so a host without IPv4 still reaches a DNS64 address after the IPv4 one fails.
                        callback(null, settings.all ? addresses : addresses[0].address, addresses[0].family);
                    });
                } }, res => { clearTimeout(timer); clearTimeout(connecting); resolve(res); });
                timer = setTimeout(() => request.destroy(new Error('Download timed out.')), 20000);
                // A firewall that drops packets leaves the connection pending rather than refusing it, so connecting
                // gets less time than a slow response.
                connecting = setTimeout(() => request.destroy(new Error('Connection timed out.')), 10000);
                request.once('socket', socket => socket.once('secureConnect', () => clearTimeout(connecting)));
                request.setTimeout(20000, () => request.destroy(new Error('Download timed out.')));
                request.on('error', err => {
                    clearTimeout(timer); clearTimeout(connecting);
                    if (err.name === 'AbortError') return reject(Object.assign(new Error('Download cancelled or timed out.'), { name: 'AbortError' }));
                    // Nothing came back, so other downloads from this host will fail the same way.
                    const code = /^[A-Z0-9_]+$/.test(err.code) ? ' (' + err.code + ')' : '';
                    reject(Object.assign(new Error(/private or reserved|resolve the download|timed out|proxy/.test(err.message) ? err.message : 'Unable to download from this host' + code + '.'), { unreachable: true }));
                });
            });
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.destroy();
                if (redirects >= 5 || options.json) throw new Error('Too many redirects or an unexpected API redirect.');
                const next = parseUrl(new URL(res.headers.location || '', url).href);
                return response(next.href, options, redirects + 1, authenticated && next.origin === url.origin);
            }
            if (res.statusCode === 304 && options.conditional) {
                res.destroy();
                return { res, url: sourceUrl(url.href) };
            }
            if (res.statusCode !== 200) {
                res.destroy();
                if (options.conditional && (res.statusCode === 403 || res.statusCode === 429)) {
                    const error = new Error('GitHub denied the release check or its rate limit was reached. The next check has been delayed.');
                    error.retryAt = Math.min(Date.now() + 7 * 86400000, Math.max(Date.now() + 3600000, (Number(res.headers['x-ratelimit-reset']) || 0) * 1000, Date.now() + (Number(res.headers['retry-after']) || 0) * 1000));
                    throw error;
                }
                let message = 'Download failed (HTTP ' + res.statusCode + ').';
                if (res.statusCode === 401 || res.statusCode === 403) message = 'Download denied or API rate limit reached. Check the GitHub token and repository read permissions.';
                if (res.statusCode === 404) message = 'File or GitHub resource not found, or the token cannot access it.';
                if (res.statusCode === 410) message = 'This GitHub artifact has expired. Select a newer build.';
                const error = new Error(message);
                error.statusCode = res.statusCode;
                throw error;
            }
            if ((res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length']) > options.limit) {
                res.destroy(); throw new Error('Download exceeds the size limit or uses unsupported HTTP compression.');
            }
            return { res, url: sourceUrl(url.href) };
        }
        async function download(url, filename, options) {
            const { res, url: finalUrl } = await response(url, options), hash = crypto.createHash('sha256');
            let size = 0;
            const meter = new Transform({ transform(chunk, encoding, callback) {
                size += chunk.length;
                if (size > options.limit) return callback(new Error('Download exceeds the size limit.'));
                hash.update(chunk);
                if (options.progress) options.progress(size, Number(res.headers['content-length']) || null);
                callback(null, chunk);
            } });
            await pipeline(res, meter, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
            const sha256 = hash.digest('hex');
            if (options.sha256 && sha256 !== options.sha256) throw new Error('The downloaded SHA256 does not match the expected digest.');
            return { url: sourceUrl(url), finalUrl, size, sha256, digestVerified: !!options.sha256 };
        }
        async function readJsonBody(res) {
            const chunks = []; let length = 0;
            try {
                for await (const chunk of res) {
                    length += chunk.length;
                    if (length > 4 * 1024 * 1024) throw new Error('GitHub response exceeds the size limit.');
                    chunks.push(chunk);
                }
                return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (ex) { res.destroy(); throw new Error('Unable to read the GitHub response.'); }
        }
        async function getJson(url, token, signal) {
            const { res } = await response(url, { json: true, token, signal, limit: 4 * 1024 * 1024 });
            return readJsonBody(res);
        }
        async function getJsonIfChanged(url, etag, signal) {
            const { res } = await response(url, { json: true, conditional: true, etag, signal, limit: 4 * 1024 * 1024 });
            return { unchanged: res.statusCode === 304, etag: res.headers.etag, data: res.statusCode === 304 ? null : await readJsonBody(res) };
        }
        return { download, getJson, getJsonIfChanged };
    }
    return { publicAddress, parseUrl, sourceUrl, createClient };
})();

module.exports = { httpsDownloads };
