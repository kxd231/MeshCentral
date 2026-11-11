/**
* @description Web-RDP relay for the JavaScript engine: the browser
* websocket (rdp/WIRE.md), the agent relay websocket and the session (rdp/client.js). Authorization,
* cookies, credential storage and relay logs stay in apprelays.js and are passed in as hooks.
* @license Apache-2.0
*/
'use strict';

const LIMITS = require('./core/limits.js');
const errors = require('./protocol/errors.js');
const bm = require('./browser-messages.js');

const E = errors.names;
const RdpError = errors.RdpError;
const STATE = bm.STATE;
const CTRL_PING = '{"ctrlChannel":102938,"type":"ping"}';
const CTRL_PONG = '{"ctrlChannel":102938,"type":"pong"}';
const DEFLATE = 'permessage-deflate';
const PING_LATE_MS = 1000;               // a ping tick this much later than scheduled means the event loop was blocked

// Size limit of one browser message, enforced by ws before the message is buffered or inflated.
// express-ws shares one ws server (and its maxPayload) for every route, so the limit of this socket is
// set on its receiver and on its permessage-deflate instance (ws 7 and ws 8 private fields).
// Returns false when the fields are missing: the caller refuses the session (fail closed).
function setMaxPayload(ws, n) {
    const r = ws._receiver;
    if ((r == null) || (typeof r._maxPayload != 'number')) { return false; }
    const ext = (ws._extensions != null) ? ws._extensions[DEFLATE] : null;
    if ((ext != null) && (typeof ext._maxPayload != 'number')) { return false; }
    r._maxPayload = n;
    if (ext != null) { ext._maxPayload = n; }
    return true;
}

// o: {
//   ws                         browser websocket (express-ws: ws 7; paused socket, as given to CreateMstscRelay)
//   settings                   resolveSettings(args.webrdp)
//   debug(msg) | null          'relay' debug log, null when disabled
//   log(msg)                   server console (errors an administrator must see)
//   authorize(infos, credentials, func(ctx | null))
//                              apprelays: rights, relay cookie, server stored credentials (written into
//                              credentials). ctx: { user, rights, relayUrl, serverName, trust }; null → not authorized.
//                              trust: { fingerprint256 | null, nlaSeen } of this device and port (rdp/trust.js, start.config.trust);
//                              { error: RdpError } instead of a context when it cannot be loaded (the session is refused with that error)
//   onTrust(info, done(conflict))   apprelays: the session connected (info.tls.fingerprint256, info.nla): pin on first use, remember NLA.
//                              done(true): another session pinned a different certificate meanwhile, the session is ended
//   onCertChanged(cert)        apprelays: the engine refused the session because of a changed certificate ({ expected, actual }), for the
//                              administrator's accept action and the audit log
//   onConnect(saved)           apprelays: credential saving ({ domain, username, password } or null) and relaylog 150
//   onEnd(bytesIn, bytesOut)   apprelays: relaylog 125 (only after onConnect)
//   onClosed()                 apprelays: the relay object is gone
//   WebSocket, client, limits  tests: replacements for require('ws'), require('./client.js') and timing limits
// }
function create(o) {
    const ws = o.ws;
    const WebSocket = o.WebSocket || testHooks.WebSocket || require('ws');
    const client = o.client || testHooks.client || require('./client.js');
    const debug = (typeof o.debug == 'function') ? o.debug : function () { };
    const L = Object.assign({}, LIMITS.limits, o.limits || testHooks.limits || {});
    const obj = { closed: false };
    let session = null, relay = null, releaseSlot = null, relayTimer = null, connected = false, ended = false;
    let infosTimer = null, pingTimer = null, lastPong = Date.now(), lastPingAt = Date.now();

    const proto = new bm.BrowserProtocol({
        infos: onInfos,
        input: function (ev) { if (session) { session.input(ev); } },
        typeText: function (t) { if (session) { session.typeText(t); } },
        clipboard: function (t) { if (session) { session.clipboard(t); } },
        resize: function (w, h) { if (session) { session.resize(w, h); } },
        visibility: function (v) { if (session) { session.visibility(v); } },
        ack: function (t) { if (session) { session.ack(t); } },
        gfxAck: function (f, q) { if (session) { session.gfxAck(f, q); } },
        charge: function (delta) { return (session != null) ? session.charge(delta) : (delta <= 0); },
        ping: function () { relayControl(CTRL_PING); },
        pong: function () { relayControl(CTRL_PONG); },
        disconnect: function () { close(null); },
        fail: function (err) { close(err); }
    });

    ws.on('error', function () { debug('Browser websocket error'); close(null, true); });
    ws.on('close', function () { debug('Browser websocket closed'); close(null, true); });
    ws.on('pong', function () { lastPong = Date.now(); });

    // Until infos is accepted a message may be at most INFOS_MSG_MAX_BYTES (raised after infos)
    if (!setMaxPayload(ws, L.INFOS_MSG_MAX_BYTES)) {
        if (typeof o.log == 'function') { o.log('Web-RDP: the websocket library does not expose the message size limit; session refused'); }
        close(new RdpError(E.RDP_ERROR_INTERNAL));
        return obj;
    }
    // any message proves the browser is alive (acks included), so a slow link that answers with acks is never cut off for a missing pong
    ws.on('message', function (data, isBinary) { lastPong = Date.now(); try { proto.handle(data, isBinary); } catch (ex) { close(new RdpError(E.RDP_ERROR_INTERNAL)); } });

    // No valid infos in time, or no pong from the browser: the socket is closed
    infosTimer = setTimeout(function () { if (proto.state() === STATE.AWAIT_INFOS) { close(new RdpError(E.RDP_ERROR_CLIENT_PROTOCOL)); } }, L.INFOS_TIMEOUT_MS);
    pingTimer = setInterval(function () {
        const now = Date.now();
        // A blocked event loop delays this timer before the poll phase reads the pongs that arrived meanwhile: forgive the lateness
        const late = now - lastPingAt - L.WS_PING_INTERVAL_MS;
        lastPingAt = now;
        if (late > PING_LATE_MS) { lastPong = Math.min(now, lastPong + late); }
        // The ping is written behind everything already queued for the socket, so on a slow link the pong comes after that data.
        // While data is queued the stall rule (WIRE.md "Stall", ack progress) decides; the pong clock restarts when the queue is empty
        if ((session != null) && connected && (Number(ws.bufferedAmount) > 0)) { lastPong = now; }
        if ((now - lastPong) > L.WS_PONG_TIMEOUT_MS) { debug('Browser websocket: no pong'); terminate(); close(null, true); return; }
        try { ws.ping(); } catch (ex) { }
    }, L.WS_PING_INTERVAL_MS);
    infosTimer.unref(); pingTimer.unref();      // the server stays up anyway; tests and shutdown do not wait

    function terminate() { try { if (typeof ws.terminate == 'function') { ws.terminate(); } else { ws.close(); } } catch (ex) { } }
    function sendText(t) { try { ws.send(t); } catch (ex) { } }
    function sendJson(a) { sendText(JSON.stringify(a)); }

    function onInfos(v) {
        clearTimeout(infosTimer);
        const credentials = v.credentials;
        o.authorize(v.infos, credentials, function (ctx) {
            if (obj.closed) { return; }
            if (ctx == null) { close(null); return; }                      // not authorized: closed as today
            if (ctx.error != null) { close(ctx.error); return; }
            const level = ctx.rights;
            proto.setRights(level);
            // the large message size (clipboard, utype) is granted only to an authorized peer (it stays at INFOS_MSG_MAX_BYTES until now)
            if (!setMaxPayload(ws, L.CLIENT_MSG_MAX_BYTES)) { close(new RdpError(E.RDP_ERROR_INTERNAL)); return; }
            const memoryBytes = (o.settings.maxEngineMemoryMb > 0) ? (o.settings.maxEngineMemoryMb * 1024 * 1024) : null;
            releaseSlot = client.acquireSessionSlot(o.settings.maxSessions, ctx.user, o.settings.maxSessionsPerUser, undefined, memoryBytes);
            if (releaseSlot == null) { debug('Too many Web-RDP sessions'); if (typeof client.logRefusal == 'function') { client.logRefusal(o.log); } close(new RdpError(E.RDP_ERROR_TOO_MANY_SESSIONS)); return; }
            proto.setState(STATE.CONNECTING);
            // settings.webRdp.gfx (o.settings.gfx, the server's word is final): 'off' always runs legacy graphics with plain bitmap updates,
            // 'on' lets the browser use GFX / H.264, 'dev' also allows RemoteFX through legacy Surface Commands (browser.rfx), which stays
            // a developer feature: production keeps plain bitmap updates in legacy mode
            const gfxPolicy = (o.gfx !== undefined) ? o.gfx : ((o.settings && o.settings.gfx) || 'off');
            if (gfxPolicy === 'off') { v.infos.options.gfx = 'legacy'; }
            if (gfxPolicy !== 'dev') { v.infos.options.browser.rfx = false; }
            // settings.webRdp.h264 = false: no AVC capability set is ever offered (the server's word is final, whatever the browser reports); the browser is then served GFX with
            // Progressive / ClearCodec (set A). Set D (AVC444) is on by default like set B: it needs the browser's own AVC444 probe.
            if (o.settings.h264 === false) {
                if (v.infos.options.gfx === 'h264') { v.infos.options.gfx = 'gfx'; }
                v.infos.options.browser.h264.ok = false; v.infos.options.browser.avc444.ok = false;
            }
            const config = bm.buildConfig(v.infos, level, ctx.serverName, o.debug != null, o.settings.security);
            if (ctx.trust != null) { config.trust = { fingerprint256: ctx.trust.fingerprint256, nlaSeen: ctx.trust.nlaSeen === true }; }
            config.displayControl = o.displayControl !== false;
            config.displayControlEvenHeight = o.displayControlEvenHeight === true;
            openRelay(ctx.relayUrl, function () { startSession(v.infos, credentials, config); });
        });
    }

    function openRelay(url, func) {
        debug('Opening the agent relay');
        try { relay = new WebSocket(url, { rejectUnauthorized: false, maxPayload: L.RELAY_MSG_MAX_BYTES }); }
        catch (ex) { close(new RdpError(E.RDP_ERROR_RELAY_FAILED, { phase: errors.PHASE.RELAY })); return; }
        relay.on('error', function () { });      // always handled: errors after the session took over the relay
        relayTimer = setTimeout(function () { close(new RdpError(E.RDP_ERROR_TIMEOUT, { phase: errors.PHASE.RELAY })); }, L.CONNECT_TIMEOUT_MS);
        relayTimer.unref();
        const onMessage = function (data, isBinary) {
            // the relay reports 'c' (or 'cr') in a text message once the agent has connected to the RDP server
            if ((isBinary !== true) && ((String(data) === 'c') || (String(data) === 'cr'))) {
                clearTimeout(relayTimer); relayTimer = null;
                relay.removeListener('message', onMessage); relay.removeListener('close', onEarlyClose); relay.removeListener('error', onEarlyClose);
                try { relay.pause(); } catch (ex) { }
                func();
            }
        };
        const onEarlyClose = function () { close(new RdpError(E.RDP_ERROR_RELAY_FAILED, { phase: errors.PHASE.RELAY })); };
        relay.on('message', onMessage);
        relay.on('close', onEarlyClose);
        relay.on('error', onEarlyClose);
    }

    function startSession(infos, credentials, config) {
        if (obj.closed) { return; }
        // Only a savepass session keeps a copy of the credentials, until 'connect'
        let saved = infos.options.savepass ? { domain: credentials.domain, username: credentials.username, password: credentials.password } : null;
        try {
            session = client.createSession({
                config: config, credentials: credentials, relay: relay, settings: o.settings, slot: releaseSlot,
                sendText: sendText,
                sendJson: sendJson,
                sendBinary: function (u8) { ws.send(u8, { binary: true }); },
                bufferedAmount: function () { return ws.bufferedAmount; },
                terminate: terminate,
                debug: (o.debug != null) ? function (m) { debug(m); } : null
            });
        } catch (ex) {
            session = null; saved = null;
            credentials.domain = credentials.username = credentials.password = null;
            if (typeof o.log == 'function') { o.log('Web-RDP: the engine could not be started (' + ((ex && ex.name) || 'Error') + ')'); }
            close(new RdpError(E.RDP_ERROR_INTERNAL));         // releases the slot: the engine never started
            return;
        }
        releaseSlot = null;                                     // owned by the session until the engine exits
        session.on('connect', function (info) {
            connected = true;
            const activate = function () {
                if (obj.closed) { return; }
                proto.setDesktop(info.width, info.height);
                proto.setState(STATE.ACTIVE);
                const s = saved; saved = null;
                try { o.onConnect(s); } catch (ex) { }
            };
            if (typeof o.onTrust != 'function') { activate(); return; }
            // Trust on first use: the first successful connection pins the certificate, before the credentials are saved and the
            // session is logged. A conflict (another session pinned a different certificate meanwhile) ends this session with a truthful
            // error: the credentials of this session already reached its endpoint. A failure to store the pin also ends it.
            let answered = false;
            const answer = function (conflict) {
                if (answered) { return; }
                answered = true;
                if (conflict === true) { saved = null; close(new RdpError(E.RDP_ERROR_TRUST_RACE, { phase: errors.PHASE.TLS })); }
                else if (conflict === 'error') { saved = null; close(new RdpError(E.RDP_ERROR_INTERNAL)); }
                else { activate(); }
            };
            try { o.onTrust(info, answer); } catch (ex) { answer('error'); }
        });
        session.on('desktop', function (r) { proto.setDesktop(r.width, r.height); });
        session.on('end', function (result) {
            saved = null; ended = true;
            if ((result != null) && (result.cert != null) && (typeof o.onCertChanged == 'function')) { try { o.onCertChanged(result.cert); } catch (ex) { } }
            close(null);
        });
    }

    function relayControl(text) { if ((relay != null) && (relay.readyState === 1)) { try { relay.send(text); } catch (ex) { } } }

    // err: RdpError to report (the session sends it when there is one), null for a plain close.
    // browserGone: the browser websocket is already closed.
    function close(err, browserGone) {
        if ((session != null) && !ended) {
            if (browserGone || (err == null)) { session.close(); } else { session.fail(err); }
            // the session's 'end' handler calls close() again
            if (!obj.closed) { close(null, browserGone); }
            return;
        }
        if (browserGone && (session != null)) { session.dispose(); }   // the socket's buffers are gone
        if (obj.closed) { return; }
        obj.closed = true;
        proto.close();
        clearTimeout(infosTimer); clearInterval(pingTimer);
        if (relayTimer != null) { clearTimeout(relayTimer); relayTimer = null; }
        if ((err != null) && !browserGone && (session == null)) { sendJson(['rdp-error', errors.toRdpError(err).toWire()]); }
        let bytesIn = 0, bytesOut = 0;
        try { bytesIn = ws._socket.bytesRead; bytesOut = ws._socket.bytesWritten; if (relay != null) { bytesIn += relay._socket.bytesRead; bytesOut += relay._socket.bytesWritten; } } catch (ex) { }
        if ((relay != null) && (session == null)) { try { relay.close(); } catch (ex) { } }
        if (releaseSlot != null) { releaseSlot(); releaseSlot = null; }   // failures before the engine was launched
        if (connected) { try { o.onEnd(bytesIn, bytesOut); } catch (ex) { } }
        if (!browserGone) { try { ws.close(); } catch (ex) { } }
        ws.removeAllListeners('message');
        if (typeof o.onClosed == 'function') { try { o.onClosed(); } catch (ex) { } }
    }

    obj.close = function () { close(null); };
    obj.state = function () { return proto.state(); };

    // start receiving browser messages
    try { ws._socket.resume(); } catch (ex) { }
    return obj;
}

// Tests only: replacements used when the caller (apprelays.js) does not pass them
const testHooks = { WebSocket: null, client: null, limits: null };

module.exports = { create: create, setMaxPayload: setMaxPayload, testHooks: testHooks };
