/**
* @description Web-RDP limits and budgets (server side)
* @license Apache-2.0
*
* Contract file: the limits are part of the interfaces documented in rdp/WIRE.md and rdp/IPC.md; change code and documentation together.
* Limits shared with the browser live in public/rdp/shared/limits.js and are re-exported here.
*
* Rules for every module:
* - check a length against the limit BEFORE allocating or copying;
* - on violation throw RdpError('RDP_ERROR_RESOURCE_LIMIT') (budgets) or RdpError('RDP_ERROR_PROTOCOL')
*   (a value the specification forbids); the session closes, the process does not;
* - never drop GFX or bitmap data to stay within a budget: stop reading upstream instead (backpressure).
*
* Queue budgets use the rule "send while in flight < budget": a producer may send one more message
* while the amount in flight is below the budget. Every path therefore also has a maximum message
* size, and the worst case in flight is budget + one maximal message (documented in rdp/IPC.md).
*/
'use strict';

const shared = require('../../public/rdp/shared/limits.js');

const KiB = 1024, MiB = 1024 * 1024;

const server = {
    // Wire framing
    TPKT_MAX_BYTES: 65535,                      // 16-bit length field (header included)
    FASTPATH_MAX_BYTES: 0x7FFF,                 // 15-bit length field
    FASTPATH_REASSEMBLY_MAX_BYTES: 8 * MiB,     // also advertised as MultifragMaxRequestSize
    CREDSSP_MAX_MESSAGE_BYTES: 64 * KiB,        // one TSRequest (DER) during NLA

    // Channels
    MCS_MAX_STATIC_CHANNELS: 31,                // CS_NET channelCount upper bound (MS-RDPBCGR 2.2.1.3.4)
    SVC_MAX_MESSAGE_BYTES: shared.CLIPBOARD_MAX_BYTES + (64 * KiB),  // reassembled SVC message: clipboard text + CLIPRDR_HEADER and margin
    DVC_MAX_CHANNELS: 32,
    DVC_MAX_MESSAGE_BYTES: 16 * MiB,            // reassembled DVC message (DATA_FIRST totalLength)
    REASSEMBLY_MAX_BYTES: 32 * MiB,             // sum of all incomplete fast-path, SVC and DVC messages of a session

    // RDP8 bulk compression (MS-RDPEGFX 3.1.9.1)
    ZGFX_HISTORY_BYTES: 2500000,
    ZGFX_MAX_OUTPUT_BYTES: shared.GFX_PDU_MAX_BYTES,

    // Engine memory: sum of large buffers the engine reserves through its session budget
    // (reassembly, ZGFX history and output, GFX message queue, TLS write jobs, frames being built or waiting in the engine queue).
    // Posted frames not yet acknowledged live in the IPC pipe and the main process, not here (ENGINE_OUTPUT_QUEUE_BYTES, global budget).
    ENGINE_ALLOC_MAX_BYTES: 96 * MiB,
    ENGINE_MAX_OLD_SPACE_MB: 96,                // V8 heap only; ArrayBuffers are covered by the RSS limit
    ENGINE_MAX_RSS_BYTES: 320 * MiB,            // reported in 'heartbeat', the main process kills above it

    // Message sizes per path (rdp/IPC.md)
    RELAY_MSG_MAX_BYTES: 1 * MiB,               // one websocket message from the agent relay (ws maxPayload)
    IPC_CHUNK_MAX_BYTES: 256 * KiB,             // one 'net' message in either direction

    // Timeouts
    CONNECT_TIMEOUT_MS: 30000,                  // from 'start' to 'connect' (engine), +CONNECT_GRACE_MS in the main process
    CONNECT_GRACE_MS: 5000,
    GFX_CONFIRM_TIMEOUT_MS: 5000,               // first activation to GFX CapsConfirm; then use-legacy (CAPABILITIES_REJECTED)
    NLA_TIMEOUT_MS: 20000,                      // CredSSP exchange (engine)
    ENGINE_START_TIMEOUT_MS: 10000,             // 'hello' after launch
    ENGINE_HEARTBEAT_MS: 1000,                  // engine sends 'heartbeat' this often
    ENGINE_WATCHDOG_MS: 5000,                   // main kills an engine silent for this long
    NET_END_DRAIN_MS: 2000,                     // after 'net-end', time for the engine to report 'close' / 'error'
    ENGINE_QUIT_KILL_MS: 2000,                  // SIGKILL (or worker.terminate) after 'quit'
    ENGINE_ADMISSION_BYTES: 128 * MiB,          // memory reserved per live engine when admitting a session (a measured larger RSS replaces it)
    ENGINE_MESSAGES_PER_SECOND: 5000,           // engine → main messages per second (token bucket rate); excess ends the session, engine killed
    ENGINE_MESSAGE_BURST: 10000,                // ... and its capacity
    ENGINE_OUT_FRAMES_PER_SECOND: 1000,         // WIRE frames the engine posts per second (token bucket rate); excess waits (backpressure)
    ENGINE_OUT_FRAME_BURST: 2000,               // ... and its capacity

    // Per session queues (bytes), see rdp/IPC.md "Flow control"
    ENGINE_INPUT_QUEUE_BYTES: 4 * MiB,          // relay → engine, not yet acknowledged by the engine
    ENGINE_OUTPUT_QUEUE_BYTES: 8 * MiB,         // engine → main process, not yet handed to the websocket
    RELAY_OUTPUT_QUEUE_BYTES: 1 * MiB,          // engine → relay, not yet written
    IPC_CONTROL_QUEUE_BYTES: 16 * MiB,          // main → engine control messages (input, clipboard, ...) not yet acknowledged
    ENGINE_INPUT_EVENTS_MAX: 512,               // input events queued inside the engine while relay output is full
    ENGINE_TLS_WRITE_JOBS_MAX: 512,             // queued TLS write jobs of the connection (its own name, was ENGINE_INPUT_EVENTS_MAX)
    ENGINE_EARLY_FRAMES_MAX: 512,               // frames received before the first activation completes
    GFX_QUEUE_MAX_MESSAGES: 512,                // decompressed GFX messages waiting for activation or output credit
    WS_HIGH_WATER_BYTES: 8 * MiB,               // websocket bufferedAmount: stop acknowledging engine output
    WS_LOW_WATER_BYTES: 2 * MiB,                // resume below this

    // Global (main process)
    MAX_SESSIONS_DEFAULT: 32,
    MAX_SESSIONS_LIMIT: 1000,
    GLOBAL_QUEUED_MAX_BYTES: 512 * MiB,         // sum of all per session queues in the main process
    MAX_SESSIONS_PER_USER_DEFAULT: 8,           // settings.webRdp.maxSessionsPerUser, never above maxSessions
    LAUNCHES_PER_USER_PER_MINUTE: 10,           // engine launches per user in a sliding minute

    // Browser websocket admission (main process, rdp/WIRE.md "Transport")
    INFOS_TIMEOUT_MS: 30000,                    // a socket that sent no valid infos by then is closed
    INFOS_MSG_MAX_BYTES: 64 * KiB,              // ws maxPayload until infos is accepted
    CLIENT_SMALL_MSG_MAX_BYTES: 4 * KiB,        // larger messages only for clipboard / utype, checked before parsing
    CLIENT_BYTES_PER_SECOND: 2 * ((12 * MiB) + (4 * KiB)),  // browser bytes per sliding second (two maximal messages)
    CLIENT_MESSAGES_PER_SECOND: 4000,           // browser messages per second per websocket, counted before parsing (token bucket rate)
    CLIENT_MESSAGE_BURST: 8192,                 // ... and its capacity
    CLIENT_OVERRATE_MAX: 8192,                  // messages dropped for lack of tokens, without recovery in between, before the session is closed
    CLIENT_PREACTIVE_IGNORED_MAX: 1024,         // messages ignored in AUTHORIZING / CONNECTING (anything but ping, pong, disconnect) before the session is closed
    WS_PING_INTERVAL_MS: 30000,                 // websocket ping to the browser
    WS_PONG_TIMEOUT_MS: 60000,                  // no pong for this long: the socket is terminated
    DESKTOP_CHANGE_GRACE_MS: 2000,              // after a desktop size change, pointer coordinates up to the larger size are clamped

    // Main → engine acknowledgement queue (browser ack / gfx-ack), coalesced and bounded
    ACK_QUEUE_MAX_ENTRIES: 2 * (1024 + 1),      // gfx-acks for GFX_MAX_UNACKED_FRAMES frames, interleaved with coalesced acks
    IPC_BACKLOG_MAX_MESSAGES: 64                // process mode: posted messages not yet written to the pipe before acks wait
};

// Defaults merged with the shared limits. Shared names must not be redefined here.
for (const name of Object.keys(server)) { if (Object.prototype.hasOwnProperty.call(shared, name)) { throw new Error('Duplicate limit ' + name); } }
const limits = Object.freeze(Object.assign({}, shared, server));

// Settings that may be changed in config.json (settings.webRdp). Everything else is fixed.
// MeshCentral lowercases config keys; only lowercase keys are read here.
// Returns { maxSessions, maxSessionsPerUser, isolation, security, gfx, maxEngineMemoryMb }.
// The obsolete engine setting is ignored; apprelays.CheckWebRdpIsolation warns at startup for "legacy".
// security: start.config.security (rdp/IPC.md): 'nla' when requireNla is true, otherwise 'auto'.
// gfx (settings.webRdp.gfx): 'on' (default) lets the browser use GFX and H.264, with an automatic legacy fallback in the browser;
//   'off' keeps legacy bitmap updates only; 'dev' is 'on' plus the developer features (RemoteFX Surface Commands, statistics). Strings are
//   case-insensitive, unset/null and true mean 'on', false means 'off'; every other value fails closed to 'off'.
let warnedInvalidGfx = false;
function resolveGfx(value) {
    if ((value == null) || (value === true)) { return 'on'; }
    if (value === false) { return 'off'; }
    if (typeof value == 'string') { const v = value.toLowerCase(); if ((v === 'on') || (v === 'off') || (v === 'dev')) { return v; } }
    return 'off';
}

// Engine memory budget (MiB) admitting sessions: settings.webRdp.maxEngineMemoryMb (config key maxenginememorymb) when valid,
// otherwise half of the memory this process may use: process.constrainedMemory() when the OS limits it (Docker / cgroup, > 0),
// else os.totalmem() (never below ENGINE_ADMISSION_BYTES, so one session is always possible).
// mem (tests): { total, constrained } in place of os.totalmem() and process.constrainedMemory().
function defaultEngineMemoryMb(mem) {
    let total = 0, constrained = 0;
    if (mem != null) { total = mem.total || 0; constrained = mem.constrained || 0; }
    else {
        try { total = require('os').totalmem(); } catch (ex) { }
        try { if (typeof process.constrainedMemory == 'function') { constrained = process.constrainedMemory(); } } catch (ex) { }
    }
    let base = total;
    if (Number.isFinite(constrained) && (constrained > 0)) { base = (total > 0) ? Math.min(constrained, total) : constrained; }
    return Math.max(limits.ENGINE_ADMISSION_BYTES / MiB, Math.floor((base / MiB) / 2));
}

function resolveSettings(webRdp) {
    const out = { maxSessions: limits.MAX_SESSIONS_DEFAULT, maxSessionsPerUser: limits.MAX_SESSIONS_PER_USER_DEFAULT, isolation: 'process', security: 'auto', gfx: 'on', h264: true, maxEngineMemoryMb: defaultEngineMemoryMb() };
    const valid = (webRdp != null) && (typeof webRdp == 'object');
    if (valid) {
        const m = webRdp.maxsessions;
        if ((typeof m == 'number') && Number.isInteger(m) && (m >= 1) && (m <= limits.MAX_SESSIONS_LIMIT)) { out.maxSessions = m; }
        const u = webRdp.maxsessionsperuser;
        if ((typeof u == 'number') && Number.isInteger(u) && (u >= 1) && (u <= limits.MAX_SESSIONS_LIMIT)) { out.maxSessionsPerUser = u; }
        if ((webRdp.isolation === 'process') || (webRdp.isolation === 'thread')) { out.isolation = webRdp.isolation; }
        if (webRdp.requirenla === true) { out.security = 'nla'; }
        out.gfx = resolveGfx(webRdp.gfx);
        if (webRdp.h264 === false) { out.h264 = false; }      // only the boolean false switches H.264 (AVC420 / AVC444) off; every other value keeps the default
        const mem = webRdp.maxenginememorymb;
        if ((typeof mem == 'number') && Number.isInteger(mem) && (mem >= (limits.ENGINE_ADMISSION_BYTES / MiB)) && (mem <= (1024 * 1024))) { out.maxEngineMemoryMb = mem; }
        const v = webRdp.gfx;
        if (!warnedInvalidGfx && (v != null) && (v !== false) && (out.gfx === 'off') && !((typeof v === 'string') && (v.toLowerCase() === 'off'))) {
            warnedInvalidGfx = true;
            // Config only; never serialize objects or other settings. Escape and bound even an invalid scalar.
            const bad = ((typeof v === 'string') || (typeof v === 'number')) ? JSON.stringify(String(v).slice(0, 80)) : typeof v;
            console.warn('Web-RDP: settings.webRdp.gfx ' + bad + ' is not on|off|dev, using "off"');
        }
    }
    out.maxSessionsPerUser = Math.min(out.maxSessionsPerUser, out.maxSessions);
    return out;
}

// require('rdp/core/limits').X for a limit, .limits for the plain table, .resolveSettings() for config
module.exports = Object.freeze(Object.assign({ limits: limits, resolveSettings: resolveSettings, resolveGfx: resolveGfx, defaultEngineMemoryMb: defaultEngineMemoryMb }, limits));
