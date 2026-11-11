/**
* @description Web-RDP main process side of a session: launches the engine (process or worker thread),
* relays bytes between the agent relay and the engine, forwards frames to the browser and enforces
* flow control, budgets and deadlines (rdp/IPC.md). It never parses RDP.
* @license Apache-2.0
*/
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const LIMITS = require('./core/limits.js');
const schema = require('./core/ipc-schema.js');
const errors = require('./protocol/errors.js');
const constants = require('../public/rdp/shared/constants.js');

const RdpError = errors.RdpError;
const E = errors.names;
const PHASES = new Set(Object.values(errors.PHASE));
const WIRE_TYPES = new Set(Object.values(constants.WIRE));
const CTL_COST = 64;                        // rdp/IPC.md "Flow control"
const ACK_ENTRY_COST = 64;                  // budget charge of one queued ack / gfx-ack, also its ctl-ack cost
const TICK_MS = 100;                        // deadlines, stall and websocket low-water polling
const REFUSAL_LOG_INTERVAL_MS = 60000;      // one administrator log line per refusal reason and minute
const TICK_LATE_MS = 200;                   // a tick this much later than scheduled means the event loop was blocked
const LOG_MAX_CHARS = 1024;
const LOG_MAX_PER_SECOND = 50;
const GFX_END_FRAME_PDU_BYTES = 12;         // RDPGFX_HEADER (8) + frameId (4): a gfx-ack needs at least this much GFX data
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
// Agent relay control messages: text frames, exactly these strings (the agent sends the channel as a
// string, the server as a number). Anything else in a text frame is dropped; binary is RDP data.
const CTRL_IN = Object.freeze({
    '{"ctrlChannel":"102938","type":"ping"}': 'ping', '{"ctrlChannel":102938,"type":"ping"}': 'ping',
    '{"ctrlChannel":"102938","type":"pong"}': 'pong', '{"ctrlChannel":102938,"type":"pong"}': 'pong'
});

const ENGINE_PATH = require.resolve('./engine.js');

// ---- process wide state: session slots, launches, the global queue budget, live engines ----
const globalState = { refusal: null, refusalLogs: new Map(), slots: 0, users: new Map(), launches: new Map(), queued: 0, max: LIMITS.GLOBAL_QUEUED_MAX_BYTES, sessions: new Set(), engines: new Set() };

// Reserve a session slot: settings.maxSessions in total, maxPerUser per user and at most
// LAUNCHES_PER_USER_PER_MINUTE launches per user. Returns an idempotent release function, or null.
// The slot is held until the engine has exited (rdp/client.js releases it), or by the caller when
// the session fails before the engine is launched.
// memoryBytes (optional, settings.webRdp.maxEngineMemoryMb): the live engines (each ENGINE_ADMISSION_BYTES or its larger measured size),
// the slots admitted but not yet launched and the new engine must fit; otherwise null (TOO_MANY_SESSIONS).
function acquireSessionSlot(maxSessions, user, maxPerUser, now, memoryBytes) {
    const r = admit(maxSessions, user, maxPerUser, now, memoryBytes);
    globalState.refusal = (r.release != null) ? null : r.refusal;
    return r.release;
}

function admit(maxSessions, user, maxPerUser, now, memoryBytes) {
    const refuse = function (reason) { return { release: null, refusal: { reason: reason, maxSessions: maxSessions, maxPerUser: maxPerUser, memoryMb: (memoryBytes != null) ? Math.round(memoryBytes / 1048576) : null } }; };
    now = (now == null) ? Date.now() : now;
    user = String(user);
    if (maxPerUser == null) { maxPerUser = maxSessions; }
    if (globalState.slots >= maxSessions) { return refuse('maxSessions'); }
    if ((globalState.users.get(user) || 0) >= maxPerUser) { return refuse('perUser'); }
    if (memoryBytes != null) {
        let used = 0, alive = 0;
        for (const x of globalState.sessions) { const b = x.engineBytes(); if (b > 0) { used += b; alive++; } }
        if ((used + ((Math.max(0, globalState.slots - alive) + 1) * LIMITS.ENGINE_ADMISSION_BYTES)) > memoryBytes) { return refuse('memory'); }
    }
    // expired launch records are pruned for every user, so the map does not grow with past users
    for (const [u, t] of globalState.launches) { if ((t.length === 0) || ((now - t[t.length - 1]) >= 60000)) { globalState.launches.delete(u); } }
    const times = (globalState.launches.get(user) || []).filter(function (t) { return (now - t) < 60000; });
    if (times.length >= LIMITS.LAUNCHES_PER_USER_PER_MINUTE) { globalState.launches.set(user, times); return refuse('launches'); }
    times.push(now);
    globalState.launches.set(user, times);
    globalState.slots++;
    globalState.users.set(user, (globalState.users.get(user) || 0) + 1);
    let released = false;
    const release = function () {
        if (released) { return; }
        released = true;
        globalState.slots--;
        const n = globalState.users.get(user) - 1;
        if (n > 0) { globalState.users.set(user, n); } else { globalState.users.delete(user); }
    };
    return { release: release, refusal: null };
}

// Administrator log (not debug) for the refusal acquireSessionSlot just made: which limit it was, at most one line per reason per
// REFUSAL_LOG_INTERVAL_MS. The browser still gets RDP_ERROR_TOO_MANY_SESSIONS. No user, device or address is named.
// log(string): the server console; now (tests): a clock value.
function logRefusal(log, now) {
    const r = globalState.refusal;
    if ((r == null) || (typeof log != 'function')) { return false; }
    now = (now == null) ? Date.now() : now;
    const last = globalState.refusalLogs.get(r.reason);
    if ((last != null) && ((now - last) < REFUSAL_LOG_INTERVAL_MS)) { return false; }
    globalState.refusalLogs.set(r.reason, now);
    let text;
    switch (r.reason) {
        case 'memory': text = 'the engine memory budget is used up (' + r.memoryMb + ' MiB, ' + (LIMITS.ENGINE_ADMISSION_BYTES / 1048576) + ' MiB reserved per session); raise settings.webRdp.maxEngineMemoryMb or give the server more memory'; break;
        case 'maxSessions': text = 'settings.webRdp.maxSessions (' + r.maxSessions + ') sessions are open'; break;
        case 'perUser': text = 'a user reached settings.webRdp.maxSessionsPerUser (' + r.maxPerUser + ')'; break;
        case 'launches': text = 'a user started more than ' + LIMITS.LAUNCHES_PER_USER_PER_MINUTE + ' sessions in a minute'; break;
        default: return false;
    }
    try { log('Web-RDP: session refused (too many sessions): ' + text); } catch (ex) { }
    return true;
}

// Charge n bytes of a session queue before admitting them. While the budget is full the session with
// the largest queues (counting this charge) is evicted. Returns false when the charging session itself was.
function globalCharge(sess, n) {
    if (n <= 0) { return true; }
    while ((globalState.queued + n) > globalState.max) {
        let victim = sess, size = sess.charged + n;
        for (const s of globalState.sessions) { if ((s !== sess) && (s.charged > size)) { victim = s; size = s.charged; } }
        victim.evict();
        if (victim === sess) { return false; }
    }
    globalState.queued += n;
    sess.charged += n;
    return true;
}
function globalRelease(sess, n) {
    n = Math.min(n, sess.charged);
    if (n <= 0) { return; }
    sess.charged -= n;
    globalState.queued -= n;
}

// Engines still running when the server exits are killed (no orphan processes)
process.once('exit', function () { for (const e of globalState.engines) { try { e.kill(); } catch (ex) { } } });

// ---- engine launch ----

// Process mode hardening: the Node permission model (Node 20: --experimental-permission, 22.13+/24:
// --permission) with read access to the engine sources only and no fs write, child_process or worker;
// network globals and string code generation off where the version supports the flag.
function permissionArgs(enginePath) {
    const flags = process.allowedNodeEnvironmentFlags;
    const flag = flags.has('--permission') ? '--permission' : (flags.has('--experimental-permission') ? '--experimental-permission' : null);
    if (flag == null) { return []; }
    const dirs = new Set();
    for (const d of [__dirname, path.join(__dirname, '..', 'public', 'rdp', 'shared'), path.dirname(enginePath)]) {
        try { dirs.add(fs.realpathSync(d)); } catch (ex) { return []; }
    }
    const args = [flag];
    for (const d of dirs) {
        if (d.indexOf(',') >= 0) { return []; }     // Node 20 splits the value on commas
        args.push('--allow-fs-read=' + d + path.sep);
    }
    return args;
}
function hardeningArgs() {
    const flags = process.allowedNodeEnvironmentFlags;
    return ['--no-experimental-fetch', '--no-experimental-websocket', '--disallow-code-generation-from-strings', '--no-addons'].filter(function (f) { return flags.has(f); });
}

// What process isolation this Node offers; logged loudly at startup when the permission model is missing
function isolationReport(settings, enginePath) {
    const isolation = (settings && settings.isolation) || 'process';
    const perm = (isolation === 'process') ? permissionArgs(enginePath || ENGINE_PATH) : [];
    const r = { isolation: isolation, node: process.version, permission: perm.length > 0 ? perm[0] : null, hardening: (isolation === 'process') ? hardeningArgs() : [] };
    r.warning = (r.permission == null) ? ('Web-RDP: the engine runs WITHOUT the Node permission model (' + ((isolation === 'thread') ? 'isolation "thread"' : ('not available in Node ' + process.version + ' or the install path contains a comma')) + '); only process separation and the import rules apply') : null;
    return r;
}

// Linux: under memory pressure the kernel kills an engine before the MeshCentral process (oom_score_adj 1000 is the highest score;
// raising the score of a child needs no privilege). Best effort and asynchronous: any failure (no procfs, a sandbox) is ignored.
function lowerOomPriority(pid) {
    if ((process.platform !== 'linux') || (pid == null)) { return; }
    try { fs.writeFile('/proc/' + pid + '/oom_score_adj', '1000', function () { }); } catch (ex) { }
}

function launchProcess(enginePath, L, handlers) {
    const child_process = require('child_process');
    const execArgv = ['--max-old-space-size=' + L.ENGINE_MAX_OLD_SPACE_MB].concat(hardeningArgs(), permissionArgs(enginePath));
    // nothing inherited (no secrets, no NODE_OPTIONS); Windows needs SystemRoot for crypto / TLS
    const env = (process.platform === 'win32') ? { SystemRoot: process.env.SystemRoot } : {};
    const child = child_process.fork(enginePath, [], { serialization: 'advanced', execArgv: execArgv, env: env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let exited = false, backlog = 0;
    const h = {
        thread: false,
        pid: child.pid,
        // posted messages not yet written to the pipe (child.send callbacks pending)
        backlog: function () { return backlog; },
        post: function (msg) {
            if (!child.connected) { return false; }
            backlog++;
            child.send(msg, function () { backlog--; });
            return true;
        },
        kill: function () { try { child.kill('SIGKILL'); } catch (ex) { } }
    };
    globalState.engines.add(h);
    lowerOomPriority(child.pid);
    child.on('message', handlers.message);
    child.on('error', function () { });                         // spawn failure is followed by 'close'
    // 'close' fires after the IPC channel is drained, so every message sent before the exit is seen first
    child.on('close', function (code, signal) {
        if (exited) { return; }
        exited = true;
        globalState.engines.delete(h);
        // Heuristic: V8 heap exhaustion aborts (SIGABRT / 134); a SIGKILL we did not send is likely the OOM killer
        handlers.exit({ oom: (signal === 'SIGABRT') || (code === 134) || (signal === 'SIGKILL') });
    });
    return h;
}

function launchThread(enginePath, L, handlers) {
    const Worker = require('worker_threads').Worker;
    const w = new Worker(enginePath, {
        resourceLimits: { maxOldGenerationSizeMb: L.ENGINE_MAX_OLD_SPACE_MB },
        env: {}, argv: [], execArgv: [], stdout: true, stderr: true
    });
    w.stdout.resume(); w.stderr.resume();                       // read and discard
    let oom = false, exited = false;
    const h = {
        thread: true,
        backlog: function () { return 0; },
        post: function (msg) { w.postMessage(msg); return true; },
        kill: function () { try { w.terminate(); } catch (ex) { } }
    };
    globalState.engines.add(h);
    w.on('message', handlers.message);
    w.on('error', function (err) { if ((err != null) && (err.code === 'ERR_WORKER_OUT_OF_MEMORY')) { oom = true; } });
    w.on('exit', function () { if (!exited) { exited = true; globalState.engines.delete(h); handlers.exit({ oom: oom }); } });
    return h;
}

// Resident memory of a child process measured by the main process (Linux), or null
function measuredRss(pid) {
    if ((process.platform !== 'linux') || (pid == null)) { return null; }
    try {
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/' + pid + '/status', 'latin1'));
        return (m != null) ? Number(m[1]) * 1024 : null;
    } catch (ex) { return null; }
}

// ---- helpers ----
function isCount(v) { return Number.isSafeInteger(v) && (v >= 0); }
function isU32(v) { return Number.isInteger(v) && (v >= 0) && (v <= 0xFFFFFFFF); }
function isDim(v) { return Number.isInteger(v) && (v >= 1) && (v <= LIMITS.DESKTOP_MAX_DIM); }
function isStr(v, max) { return (typeof v == 'string') && (v.length <= max) && (v.indexOf('\u0000') < 0); }

// A view that does not own its ArrayBuffer is copied before a structured clone (thread mode),
// which would otherwise copy the whole buffer, possibly holding unrelated pooled data.
function owned(u8) {
    if ((u8.byteOffset === 0) && (u8.byteLength === u8.buffer.byteLength)) { return u8; }
    return new Uint8Array(u8);
}

// Dedicated array (never a pooled Buffer), UTF-16LE, no terminator
function encodeCredential(s) {
    const a = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a[2 * i] = c & 0xFF; a[(2 * i) + 1] = c >>> 8; }
    return a;
}

// ---- session ----

// rdp/IPC.md "rdp/client.js API". opts.slot: release function of acquireSessionSlot(), owned by the
// session once createSession returns (released when the engine has exited). opts.terminate: drops the
// browser socket (used when the global budget evicts a session whose socket still holds data).
// Tests only: limits (overrides), enginePath, launch(enginePath, limits, handlers), onIpc(direction, msg).
// Throws (TypeError or the launch error) with nothing left behind: credentials wiped, no timer, no listener.
function createSession(opts) {
    const config = schema.config(opts.config);
    if (config == null) { throw new TypeError('Invalid Web-RDP session config'); }
    const L = Object.assign({}, LIMITS.limits, opts.limits || {});
    const settings = opts.settings || LIMITS.resolveSettings(null);
    const relay = opts.relay;
    const debugFn = (typeof opts.debug == 'function') ? opts.debug : null;
    const tap = (typeof opts.onIpc == 'function') ? opts.onIpc : null;
    const s = new EventEmitter();

    // Credentials: encoded once into dedicated arrays; the caller's strings are dropped right away.
    let creds = null;
    {
        const c = opts.credentials || {};
        const fields = {};
        for (const k of ['domain', 'username', 'password']) {
            const v = (c[k] == null) ? '' : c[k];
            c[k] = null;
            if (!isStr(v, L.CREDENTIAL_FIELD_MAX_CHARS)) { for (const f of Object.values(fields)) { f.fill(0); } throw new TypeError('Invalid Web-RDP credentials'); }
            fields[k] = encodeCredential(v);
        }
        creds = fields;
    }
    function wipeCredentials() { if (creds != null) { creds.domain.fill(0); creds.username.fill(0); creds.password.fill(0); creds = null; } }

    let ended = false, disposed = false, helloSeen = false, started = false, connected = false, engineAlive = true, killedForMemory = false;
    let lastRss = 0;                            // last memory size of the engine (bytes), for admission
    // engine → main message rate (token bucket): a compromised engine cannot flood the main thread
    let engTokens = L.ENGINE_MESSAGE_BURST, engTokensAt = Date.now();
    let lastTickAt = Date.now();
    let phase = errors.PHASE.RELAY;
    let launchTime = Date.now();
    let startTime = 0, lastEngineMsg = launchTime;
    // relay → engine
    let netPosted = 0, netAcked = 0, relayPaused = true, relayClosed = false, netEndPending = false, drainDeadline = 0;
    const preStart = [];
    // relay control messages forwarded to the browser (sliding second)
    const ctrlTimes = [];
    // engine → relay
    let engineNet = 0, netOutWritten = 0, netOutAckPosted = 0;
    // engine → websocket
    let outSent = 0, outAckPosted = 0, outAckHeld = false, wsCharged = 0;
    let clipRecv = 0, clipAckPosted = 0;
    // browser window and acknowledgements (coalesced queue, rdp/IPC.md "Flow control")
    let browserAck = 0, lastAckProgress = 0, gfxBytesSent = 0, gfxAcks = 0;
    const ackQueue = [];
    const ackMarks = [];        // ctlPosted after each posted ack / gfx-ack: consumed when ctl-ack reaches it
    // control
    let ctlPosted = 0, ctlAcked = 0;
    let pendPointer = null, pendResize = null, pendVisibility = null, pendClipboard = null, pendClipboardCharge = 0, extraCharge = 0;
    let utype = null, utypeIndex = 0, utypeTimer = null;
    // logs
    let logWindow = 0, logCount = 0;
    let killTimer = null, ackImmediate = null, ackFlushImmediate = null, outAckImmediate = null;
    let slot = (typeof opts.slot == 'function') ? opts.slot : null;

    s.charged = 0;
    // Memory this session's engine is assumed to hold (admission, acquireSessionSlot): 0 once the engine is gone
    s.engineBytes = function () { return engineAlive ? Math.max(L.ENGINE_ADMISSION_BYTES, lastRss) : 0; };
    // Global budget eviction: a live session fails; an ended one drops the browser socket that still holds data
    s.evict = function () {
        if (!ended) { fail(new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: phase }), true); return; }
        if (typeof opts.terminate == 'function') { try { opts.terminate(); } catch (ex) { } }
        dispose();
    };

    function debug(msg) { if (debugFn != null) { try { debugFn(msg); } catch (ex) { } } }

    // ---- launch (transactional: on failure nothing is registered and the credentials are wiped) ----
    const launch = (typeof opts.launch == 'function') ? opts.launch : ((settings.isolation === 'thread') ? launchThread : launchProcess);
    let engine = null;
    try {
        engine = launch(opts.enginePath || ENGINE_PATH, L, { message: onEngineMessage, exit: onEngineExit });
    } catch (ex) {
        wipeCredentials();
        throw ex;
    }
    globalState.sessions.add(s);
    const tick = setInterval(onTick, TICK_MS);
    tick.unref();
    relay.on('message', onRelayMessage);
    relay.on('close', onRelayClosed);
    relay.on('error', onRelayClosed);

    function post(msg) {
        if (!engineAlive) { return; }
        if (tap != null) { tap('out', msg); }
        try { engine.post(msg); } catch (ex) { }
    }
    function postData(t, u8) { post({ t: t, data: engine.thread ? owned(u8) : u8 }); }

    // ---- relay (agent) ----
    function onRelayMessage(data, isBinary) {
        if (ended) { return; }
        // ws 8 passes isBinary; without it (ws 7) a text message is a string
        const binary = (typeof isBinary == 'boolean') ? isBinary : (typeof data != 'string');
        if (!binary) { return onRelayControl(String(data)); }
        if (Array.isArray(data)) { data = Buffer.concat(data); }
        else if (data instanceof ArrayBuffer) { data = new Uint8Array(data); }
        if (data.length === 0) { return; }
        if (data.length > L.RELAY_MSG_MAX_BYTES) { fail(new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: phase }), true); return; }
        if (!globalCharge(s, data.length)) { return; }
        for (let i = 0; i < data.length; i += L.IPC_CHUNK_MAX_BYTES) {
            const chunk = data.subarray(i, Math.min(data.length, i + L.IPC_CHUNK_MAX_BYTES));
            if (started) { netPosted += chunk.length; postData('net', chunk); } else { preStart.push(new Uint8Array(chunk)); netPosted += chunk.length; }
        }
        updateRelayPause();
    }

    // Agent ping / pong: exact strings only, rate limited, dropped while the browser socket is full
    function onRelayControl(text) {
        const type = Object.prototype.hasOwnProperty.call(CTRL_IN, text) ? CTRL_IN[text] : null;
        if (type == null) { debug('RDP: unexpected text message on the relay, dropped'); return; }
        const now = Date.now();
        while ((ctrlTimes.length > 0) && ((now - ctrlTimes[0]) >= 1000)) { ctrlTimes.shift(); }
        if (ctrlTimes.length >= L.CONTROL_MAX_MESSAGES_PER_SECOND) { return; }
        if (bufferedAmount() >= L.WS_HIGH_WATER_BYTES) { return; }
        ctrlTimes.push(now);
        sendJson([type]);
    }

    function updateRelayPause() {
        if (ended || relayClosed) { return; }
        const full = !started || ((netPosted - netAcked) >= L.ENGINE_INPUT_QUEUE_BYTES);
        if (full && !relayPaused) { relayPaused = true; try { relay.pause(); } catch (ex) { } }
        else if (!full && relayPaused) { relayPaused = false; try { relay.resume(); } catch (ex) { } }
    }

    function onRelayClosed() {
        if (relayClosed) { return; }
        relayClosed = true;
        if (ended) { return; }
        debug('RDP: relay closed by the peer');
        // forward what is left, then 'net-end'; the engine has NET_END_DRAIN_MS to report the reason
        if (started) { post({ t: 'net-end' }); } else { netEndPending = true; }
        drainDeadline = Date.now() + L.NET_END_DRAIN_MS;
    }

    function relaySend(data, cb) {
        try { relay.send(data, { binary: true }, cb); } catch (ex) { cb(ex); }
    }

    // ---- engine messages ----
    function onEngineMessage(m) {
        if (tap != null) { tap('in', m); }
        if (ended) { return; }
        const now = Date.now();
        lastEngineMsg = now;
        engTokens = Math.min(L.ENGINE_MESSAGE_BURST, engTokens + (((now - engTokensAt) * L.ENGINE_MESSAGES_PER_SECOND) / 1000));
        engTokensAt = now;
        if (engTokens < 1) { debug('RDP: engine message rate exceeded'); return fatal(); }
        engTokens -= 1;
        try { handleEngineMessage(m); } catch (ex) { fatal(); }
    }

    function handleEngineMessage(m) {
        if ((m == null) || (typeof m != 'object') || (typeof m.t != 'string')) { return fatal(); }
        if (!helloSeen && (m.t !== 'hello')) { return fatal(); }
        switch (m.t) {
            case 'hello':
                if (helloSeen || (m.v !== 1) || !isStr(m.node, 64)) { return fatal(); }
                helloSeen = true;
                return startEngine();
            case 'heartbeat': {
                if (!isCount(m.rss)) { return fatal(); }
                // Process mode: the larger of the reported and the measured value (a broken engine may under-report).
                // Thread mode: the worker reports its own heap plus external memory (ArrayBuffers), not the whole process.
                const rss = engine.thread ? m.rss : Math.max(m.rss, measuredRss(engine.pid) || 0);
                lastRss = rss;
                if (rss > L.ENGINE_MAX_RSS_BYTES) { killedForMemory = true; return fail(new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: phase }), true); }
                return;
            }
            case 'net': return onEngineNet(m);
            case 'net-ack':
                if (!isCount(m.total) || (m.total < netAcked) || (m.total > netPosted)) { return fatal(); }
                globalRelease(s, m.total - netAcked);
                netAcked = m.total;
                return updateRelayPause();
            case 'ctl-ack':
                if (!isCount(m.total) || (m.total < ctlAcked) || (m.total > ctlPosted)) { return fatal(); }
                globalRelease(s, m.total - ctlAcked);
                ctlAcked = m.total;
                while ((ackMarks.length > 0) && (ackMarks[0] <= ctlAcked)) { ackMarks.shift(); }
                flushAcks();
                return flushControl();
            case 'phase':
                if (!PHASES.has(m.phase)) { return fatal(); }
                phase = m.phase;
                debug('RDP: phase ' + phase);
                return;
            case 'connect': return onEngineConnect(m);
            case 'desktop':
                if (!connected || !isDim(m.width) || !isDim(m.height)) { return fatal(); }
                s.emit('desktop', { width: m.width, height: m.height });
                return;
            case 'resize':
                if (!connected || !isDim(m.width) || !isDim(m.height)) { return fatal(); }
                sendJson(['rdp-resize', { width: m.width, height: m.height }]);
                s.emit('resize', { width: m.width, height: m.height });
                return;
            case 'out': return onEngineOut(m);
            case 'clipboard': {
                if (!connected || (typeof m.text != 'string') || (((m.text.length + 1) * 2) > L.CLIPBOARD_MAX_BYTES) || (clipRecv > clipAckPosted)) { return fatal(); }
                // the serialized message is charged before it is handed to the websocket
                const json = JSON.stringify(['rdp-clipboard', m.text]);
                if (!globalCharge(s, json.length)) { return; }
                wsCharged += json.length;
                clipRecv++;
                if (typeof opts.sendText == 'function') { try { opts.sendText(json); } catch (ex) { } } else { sendJson(['rdp-clipboard', m.text]); }
                return wsProgress();
            }
            case 'end':
                if (typeof m.clean != 'boolean') { return fatal(); }
                if (m.clean) { return finish({ clean: true }, true, false); }
                {
                    const result = { clean: false, error: RdpError.fromWire(m.error).toWire() };
                    // the certificate the server presented instead of the pinned one (rdp/IPC.md end.cert), for the user and the audit log
                    if (m.cert !== undefined) {
                        if ((result.error.code !== E.RDP_ERROR_CERT_CHANGED) || (m.cert == null) || (typeof m.cert != 'object') || (typeof m.cert.fingerprint256 != 'string') || !FINGERPRINT.test(m.cert.fingerprint256)) { return fatal(); }
                        result.cert = { expected: config.trust.fingerprint256, actual: m.cert.fingerprint256 };
                    }
                    return finish(result, true, false);
                }
            case 'log':
                if ((config.debug !== true) || ((m.level !== 'debug') && (m.level !== 'warn')) || (typeof m.msg != 'string')) { return; }
                if (m.msg.length > LOG_MAX_CHARS) { return; }
                { const w = Math.floor(Date.now() / 1000); if (w !== logWindow) { logWindow = w; logCount = 0; } if (++logCount > LOG_MAX_PER_SECOND) { return; } }
                debug('RDP engine ' + m.level + ': ' + m.msg.replace(/[\u0000-\u001F\u007F]/g, ' '));
                return;
            default: return fatal();
        }
    }

    function startEngine() {
        const msg = { t: 'start', v: 1, config: config, credentials: creds };
        try { post(msg); } finally { wipeCredentials(); msg.credentials = null; }
        started = true;
        startTime = Date.now();
        for (const c of preStart) { postData('net', c); }
        preStart.length = 0;
        if (netEndPending) { netEndPending = false; post({ t: 'net-end' }); }
        updateRelayPause();
        debug('RDP: engine started (' + (engine.thread ? 'thread' : 'process') + ')');
    }

    function onEngineNet(m) {
        const d = m.data;
        if (!started || !(d instanceof Uint8Array) || (d.length === 0) || (d.length > L.IPC_CHUNK_MAX_BYTES)) { return fatal(); }
        engineNet += d.length;
        if ((engineNet - netOutWritten) > (L.RELAY_OUTPUT_QUEUE_BYTES + L.IPC_CHUNK_MAX_BYTES)) { return fatal(); }
        if (!globalCharge(s, d.length)) { return; }
        const n = d.length;
        const written = function () {
            globalRelease(s, n);
            netOutWritten += n;
            scheduleAcks();
        };
        if (relayClosed) { written(); return; }
        relaySend(d, written);
    }

    function onEngineConnect(m) {
        if (connected || !started || !isDim(m.width) || !isDim(m.height) || ((m.mode !== 'legacy') && (m.mode !== 'gfx'))) { return fatal(); }
        let gfx = null;
        if (m.gfx != null) {
            if ((typeof m.gfx != 'object') || !isU32(m.gfx.capsVersion) || !isU32(m.gfx.flags)) { return fatal(); }
            gfx = { capsVersion: m.gfx.capsVersion, flags: m.gfx.flags };
        }
        if ((m.tls == null) || (typeof m.tls != 'object') || (typeof m.tls.fingerprint256 != 'string') || !FINGERPRINT.test(m.tls.fingerprint256)) { return fatal(); }
        if (typeof m.nla != 'boolean') { return fatal(); }
        connected = true;
        phase = errors.PHASE.ACTIVE;
        sendJson(['rdp-connect', { wire: constants.WIRE_VERSION, width: m.width, height: m.height, mode: m.mode, gfx: gfx }]);
        debug('RDP: connected ' + m.width + 'x' + m.height + ' ' + m.mode);
        s.emit('connect', { width: m.width, height: m.height, mode: m.mode, gfx: gfx, tls: { fingerprint256: m.tls.fingerprint256 }, nla: m.nla });
    }

    function onEngineOut(m) {
        const d = m.data;
        if (!connected || !(d instanceof Uint8Array) || (d.length === 0) || (d.length > L.WIRE_FRAME_MAX_BYTES) || !WIRE_TYPES.has(d[0])) { return fatal(); }
        // engine sends while in flight < budget: at most one maximal frame over each budget
        if (((outSent + d.length - outAckPosted) > (L.ENGINE_OUTPUT_QUEUE_BYTES + L.WIRE_FRAME_MAX_BYTES)) ||
            ((outSent + d.length - browserAck) > (L.WINDOW_BYTES + L.WIRE_FRAME_MAX_BYTES))) { return fatal(); }
        if (!globalCharge(s, d.length)) { return; }
        wsCharged += d.length;
        if (outSent === browserAck) { lastAckProgress = Date.now(); }    // stall clock starts with data in flight
        outSent += d.length;
        if (d[0] === constants.WIRE.GFX) { gfxBytesSent += d.length; }
        try { opts.sendBinary(d); } catch (ex) { }
        wsProgress();
    }

    function bufferedAmount() { try { return Number(opts.bufferedAmount()) || 0; } catch (ex) { return 0; } }

    // Websocket charge follows bufferedAmount both ways (growth is charged, shrinkage released).
    // out-ack and clipboard-ack: posted while below the high water mark, then held until bufferedAmount
    // falls below the low water mark (polled by the tick).
    function wsProgress() {
        const b = bufferedAmount();
        if (b < wsCharged) { globalRelease(s, wsCharged - b); wsCharged = b; }
        else if (b > wsCharged) { if (!globalCharge(s, b - wsCharged)) { return; } wsCharged = b; }
        if (ended) { return; }
        if (outAckHeld) { if (b < L.WS_LOW_WATER_BYTES) { outAckHeld = false; } }
        else if (b >= L.WS_HIGH_WATER_BYTES) { outAckHeld = true; }
        if (outAckHeld) { return; }
        scheduleOutAck();
    }

    // out-ack and clipboard-ack are batched like net-out-ack: many small frames in one turn give one acknowledgement
    function scheduleOutAck() {
        if (outAckImmediate != null) { return; }
        outAckImmediate = setImmediate(function () {
            outAckImmediate = null;
            if (ended || outAckHeld) { return; }
            if (outSent > outAckPosted) { outAckPosted = outSent; post({ t: 'out-ack', total: outSent }); }
            if (clipRecv > clipAckPosted) { clipAckPosted = clipRecv; post({ t: 'clipboard-ack', total: clipRecv }); }
        });
    }

    // net-out-ack is batched: relay write callbacks can be many per turn
    function scheduleAcks() {
        if (ackImmediate != null) { return; }
        ackImmediate = setImmediate(function () {
            ackImmediate = null;
            if (!ended && (netOutWritten > netOutAckPosted)) { netOutAckPosted = netOutWritten; post({ t: 'net-out-ack', total: netOutWritten }); }
        });
    }

    // ---- browser acknowledgements: a bounded queue, consecutive cumulative acks coalesced, order kept
    // around gfx-acks, posted while the IPC backlog is small (rdp/IPC.md "Flow control") ----
    function queueAck(entry) {
        const last = ackQueue[ackQueue.length - 1];
        if ((entry.t === 'ack') && (last != null) && (last.t === 'ack')) { last.total = entry.total; scheduleAckFlush(); return; }
        if (ackQueue.length >= L.ACK_QUEUE_MAX_ENTRIES) { fail(new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: phase }), true); return; }
        if (!globalCharge(s, ACK_ENTRY_COST)) { return; }
        ackQueue.push(entry);
        scheduleAckFlush();
    }
    function scheduleAckFlush() {
        if (ackFlushImmediate != null) { return; }
        ackFlushImmediate = setImmediate(function () { ackFlushImmediate = null; flushAcks(); });
    }
    // Receipt-based credit (process and thread mode): at most IPC_BACKLOG_MAX_MESSAGES acknowledgements the
    // engine has not confirmed through ctl-ack; their charge moves to the control queue and is released
    // by ctl-ack. Process mode also waits while the pipe backlog is high.
    function flushAcks() {
        while ((ackQueue.length > 0) && !ended && (ackMarks.length < L.IPC_BACKLOG_MAX_MESSAGES) && (engine.backlog() < L.IPC_BACKLOG_MAX_MESSAGES)) {
            const e = ackQueue.shift();
            ctlPosted += ACK_ENTRY_COST;
            ackMarks.push(ctlPosted);
            post(e);
        }
    }

    // ---- deadlines (independent of the engine) ----
    function onTick() {
        if (ended) {
            // the browser socket may still hold data after the end: its charge is kept until it drains
            if (bufferedAmount() === 0) { dispose(); }
            return;
        }
        let now = Date.now();
        // The event loop was blocked (GC, a heavy database operation, other sessions): timers run before the poll phase delivers what
        // arrived meanwhile, so every deadline would look missed. The lateness is not the engine's, the browser's or the relay's fault:
        // all baselines move forward by it.
        const late = now - lastTickAt - TICK_MS;
        lastTickAt = now;
        if (late > TICK_LATE_MS) {
            lastEngineMsg = Math.min(now, lastEngineMsg + late); lastAckProgress = Math.min(now, lastAckProgress + late);
            launchTime += late; startTime = (startTime === 0) ? 0 : (startTime + late);
            if (drainDeadline !== 0) { drainDeadline += late; }
            engTokensAt = Math.min(now, engTokensAt + late);
        }
        if (!helloSeen) { if ((now - launchTime) > L.ENGINE_START_TIMEOUT_MS) { debug('RDP: engine did not start'); fail(new RdpError(E.RDP_ERROR_TIMEOUT, { phase: phase }), true); } return; }
        if ((now - lastEngineMsg) > L.ENGINE_WATCHDOG_MS) { debug('RDP: engine watchdog'); fail(new RdpError(E.RDP_ERROR_TIMEOUT, { phase: phase }), true); return; }
        if (!connected && started && ((now - startTime) > (L.CONNECT_TIMEOUT_MS + L.CONNECT_GRACE_MS))) { fail(new RdpError(E.RDP_ERROR_TIMEOUT, { phase: phase }), true); return; }
        if ((drainDeadline !== 0) && (now > drainDeadline)) { fail(new RdpError(E.RDP_ERROR_CONNECTION_LOST, { phase: phase }), false); return; }
        if (ackQueue.length > 0) { flushAcks(); }
        if (connected) {
            wsProgress();
            if (ended) { return; }
            if (outSent > browserAck) {
                const limit = L.STALL_TIMEOUT_MS + ((1000 * (outSent - browserAck)) / L.STALL_MIN_BYTES_PER_SECOND);
                if ((now - lastAckProgress) > limit) { debug('RDP: browser stalled'); fail(new RdpError(E.RDP_ERROR_CLIENT_STALLED), false); }
            }
        }
    }

    // ---- browser side (inputs already validated, rights applied: rdp/browser-messages.js) ----
    function ctlCredit() { return (ctlPosted - ctlAcked) < L.IPC_CONTROL_QUEUE_BYTES; }
    function postControl(msg, cost) {
        if (!globalCharge(s, cost)) { return false; }
        ctlPosted += cost;
        post(msg);
        return true;
    }
    function setPendingClipboard(t) {
        const n = (t == null) ? 0 : (2 * t.length);
        if (n > pendClipboardCharge) { if (!globalCharge(s, n - pendClipboardCharge)) { return false; } }
        else { globalRelease(s, pendClipboardCharge - n); }
        pendClipboardCharge = n;
        pendClipboard = t;
        return true;
    }
    // Pending control messages (latest wins), posted in this order when credit returns
    function flushControl() {
        if (ended || !connected) { return; }
        if ((pendPointer != null) && ctlCredit()) { const ev = pendPointer; pendPointer = null; if (!postControl({ t: 'input', ev: ev }, CTL_COST)) { return; } }
        if ((pendResize != null) && ctlCredit()) { const r = pendResize; pendResize = null; if (!postControl({ t: 'resize', width: r.width, height: r.height }, CTL_COST)) { return; } }
        if ((pendVisibility != null) && ctlCredit()) { const v = pendVisibility; pendVisibility = null; if (!postControl({ t: 'visibility', visible: v }, CTL_COST)) { return; } }
        if ((pendClipboard != null) && ctlCredit()) { const t = pendClipboard; setPendingClipboard(null); postControl({ t: 'clipboard', text: t }, CTL_COST + (2 * t.length)); }
    }

    s.input = function (ev) {
        if (ended || !connected) { return; }
        if ((ev.k === 'mouse') && (ev.button === 0)) { pendPointer = ev; flushControl(); return; }
        flushControl();
        // keys, buttons, wheel and sync are never dropped: a lost key-up leaves a key stuck
        if ((pendPointer != null) || !ctlCredit()) { fail(new RdpError(E.RDP_ERROR_RESOURCE_LIMIT, { phase: phase }), true); return; }
        postControl({ t: 'input', ev: ev }, CTL_COST);
    };

    // utype: one UTF-16 unit every UTYPE_INTERVAL_MS while control credit allows; '\n' → Enter, '\r' skipped
    s.typeText = function (text) {
        if (ended || !connected) { return; }
        utype = text; utypeIndex = 0;
        if (utypeTimer == null) { utypeTimer = setInterval(typeNext, L.UTYPE_INTERVAL_MS); utypeTimer.unref(); }
    };
    function typeNext() {
        if (ended || (utype == null) || (utypeIndex >= utype.length)) { clearInterval(utypeTimer); utypeTimer = null; utype = null; return; }
        if ((pendPointer != null) || ((ctlPosted + (2 * CTL_COST) - ctlAcked) > L.IPC_CONTROL_QUEUE_BYTES)) { return; }    // wait for credit
        let c = utype.charCodeAt(utypeIndex++);
        while (c === 13) { if (utypeIndex >= utype.length) { return; } c = utype.charCodeAt(utypeIndex++); }
        if (c === 10) {
            if (postControl({ t: 'input', ev: { k: 'scancode', code: 0x1C, down: true } }, CTL_COST)) { postControl({ t: 'input', ev: { k: 'scancode', code: 0x1C, down: false } }, CTL_COST); }
        } else if (postControl({ t: 'input', ev: { k: 'unicode', unit: c, down: true } }, CTL_COST)) {
            postControl({ t: 'input', ev: { k: 'unicode', unit: c, down: false } }, CTL_COST);
        }
    }

    s.clipboard = function (text) { if (ended || !connected) { return; } if (!setPendingClipboard(text)) { return; } flushControl(); };
    s.resize = function (width, height) { if (ended || !connected) { return; } pendResize = { width: width, height: height }; flushControl(); };
    s.visibility = function (visible) { if (ended || !connected) { return; } pendVisibility = (visible === true); flushControl(); };

    // Browser byte ack: safe integer, monotonic, ≤ bytes sent; queued only when it increased
    s.ack = function (total) {
        if (ended) { return; }
        if (!isCount(total) || (total < browserAck) || (total > outSent)) { fail(new RdpError(E.RDP_ERROR_CLIENT_PROTOCOL), false); return; }
        if (total === browserAck) { return; }
        browserAck = total;
        lastAckProgress = Date.now();
        queueAck({ t: 'ack', total: total });
    };

    // gfx-ack: ranges here, identity (oldest frame, once, channel generation) in the engine's ledger.
    // A gfx-ack needs an END_FRAME PDU already sent, so their number is bounded by the GFX bytes sent.
    s.gfxAck = function (frameId, queueDepth) {
        if (ended) { return; }
        if (!isU32(frameId) || !Number.isInteger(queueDepth) || (queueDepth < 0) || (queueDepth > 0xFFFFFFFE) ||
            ((gfxAcks + 1) * GFX_END_FRAME_PDU_BYTES > gfxBytesSent)) {
            fail(new RdpError(E.RDP_ERROR_CLIENT_PROTOCOL), false); return;
        }
        gfxAcks++;
        queueAck({ t: 'gfx-ack', frameId: frameId, queueDepth: queueDepth });
    };

    // Bytes held outside the session's own queues on its behalf (the browser protocol's pending clipboard):
    // delta > 0 charges (false when the session was evicted), delta < 0 releases.
    s.charge = function (delta) {
        if (ended) { return false; }
        if (delta > 0) { if (!globalCharge(s, delta)) { return false; } extraCharge += delta; return true; }
        const n = Math.min(-delta, extraCharge);
        extraCharge -= n;
        globalRelease(s, n);
        return true;
    };

    // Browser closed or 'disconnect'
    s.close = function () { finish({ clean: true }, false, false); };

    // End the session with an error decided outside (invalid browser messages, client-error)
    s.fail = function (err) { fail(err, false); };

    s.isConnected = function () { return connected; };

    // The browser socket is gone: release everything still charged
    s.dispose = function () { dispose(); };

    // ---- end ----
    function fatal() { debug('RDP: invalid message from the engine'); fail(new RdpError(E.RDP_ERROR_INTERNAL, { phase: phase }), true); }
    function fail(err, killNow) { finish({ clean: false, error: errors.toRdpError(err, phase).toWire() }, true, killNow); }

    // Exactly once: final message to the browser, quit, close the relay, kill after ENGINE_QUIT_KILL_MS.
    // Charges of the browser socket stay until it drains or is disposed; the slot until the engine exits.
    function finish(result, notifyBrowser, killNow) {
        if (ended) { return; }
        ended = true;
        if (utypeTimer != null) { clearInterval(utypeTimer); utypeTimer = null; }
        if (ackImmediate != null) { clearImmediate(ackImmediate); ackImmediate = null; }
        if (ackFlushImmediate != null) { clearImmediate(ackFlushImmediate); ackFlushImmediate = null; }
        if (outAckImmediate != null) { clearImmediate(outAckImmediate); outAckImmediate = null; }
        wipeCredentials();
        utype = null; pendPointer = null; preStart.length = 0; ackQueue.length = 0;
        setPendingClipboard(null);
        if (notifyBrowser) { sendJson(result.clean ? ['rdp-close'] : ['rdp-error', (result.cert != null) ? Object.assign({}, result.error, { cert: result.cert }) : result.error]); }
        debug('RDP: session end ' + (result.clean ? 'clean' : result.error.code));
        if (engineAlive) {
            post({ t: 'quit' });
            if (killNow) { engine.kill(); } else { killTimer = setTimeout(function () { killTimer = null; engine.kill(); }, L.ENGINE_QUIT_KILL_MS); killTimer.unref(); }
        }
        // the relay socket is destroyed, so its buffers are gone with it
        if (!relayClosed) { try { if (typeof relay.terminate == 'function') { relay.terminate(); } else { relay.close(); } } catch (ex) { } }
        globalRelease(s, s.charged - wsCharged);
        extraCharge = 0;
        s.emit('end', result);
        if (bufferedAmount() === 0) { dispose(); }
    }

    function dispose() {
        if (disposed) { return; }
        disposed = true;
        clearInterval(tick);
        globalRelease(s, s.charged);
        wsCharged = 0;
        globalState.sessions.delete(s);
    }

    function onEngineExit(info) {
        engineAlive = false;
        if (killTimer != null) { clearTimeout(killTimer); killTimer = null; }
        if (slot != null) { const r = slot; slot = null; r(); }
        s.emit('engine-exit');     // diagnostics and tests; the session result is always 'end'
        if (ended) { return; }
        const memory = killedForMemory || info.oom;
        debug('RDP: engine exited without end' + (memory ? ' (memory)' : ''));
        finish({ clean: false, error: new RdpError(memory ? E.RDP_ERROR_RESOURCE_LIMIT : E.RDP_ERROR_INTERNAL, { phase: phase }).toWire() }, true, false);
    }

    // opts.sendText(string) when given (no second serialization), otherwise opts.sendJson(array)
    function sendJson(a) { try { if (typeof opts.sendText == 'function') { opts.sendText(JSON.stringify(a)); } else { opts.sendJson(a); } } catch (ex) { } }

    return s;
}

module.exports = {
    createSession: createSession,
    acquireSessionSlot: acquireSessionSlot,
    logRefusal: logRefusal,
    encodeCredential: encodeCredential,
    permissionArgs: permissionArgs,
    hardeningArgs: hardeningArgs,
    isolationReport: isolationReport,
    lowerOomPriority: lowerOomPriority,
    ENGINE_PATH: ENGINE_PATH,
    _global: globalState            // tests: inspect and lower the global budget
};
