/**
* @description Web-RDP session tag and audit file for a SIEM (docs/webrdp.md "SIEM / Wazuh"). The tag is a one-time
* RDP client name drawn by the server for one session: it reaches the target in the GCC client name and the NTLM
* workstation name, and the SIEM in the audit line written before the agent is told to connect. A logon that carries
* a tag the server reported moments ago was started by this server. Main process only; the browser never sees a tag.
* @license Apache-2.0
*/
'use strict';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';     // RFC 4648: valid in a NetBIOS name, no lookalike digits
const PREFIX = 'MC';
const RANDOM_CHARS = 12;                                // 12 x 5 = 60 random bits; with the prefix 14 chars (RDP client name: at most 15)
const TAG = /^MC[A-Z2-7]{12}$/;
const FIELD_MAX_CHARS = 256;                            // names copied into an audit line

// A new tag. random(n): n random bytes (tests); default node:crypto.
function create(random) {
    const bytes = (typeof random == 'function') ? random(RANDOM_CHARS) : require('node:crypto').randomBytes(RANDOM_CHARS);
    if ((bytes == null) || (bytes.length !== RANDOM_CHARS)) { throw new Error('session tag: no random bytes'); }
    let out = PREFIX;
    for (let i = 0; i < RANDOM_CHARS; i++) { out += BASE32[bytes[i] & 31]; }   // 256 = 8 x 32: every character is uniform
    return out;
}

function isTag(v) { return (typeof v == 'string') && TAG.test(v); }

function text(v) { return (typeof v == 'string') ? v.slice(0, FIELD_MAX_CHARS) : ''; }

// One audit line (JSON, no newline) of a session about to start.
// o: { time (ms), tag | null, nodeid, device, hostname, userid, user, rdpUser, rdpDomain, target, port, ip }
//   device: the device name in MeshCentral; hostname: the computer name its agent reported ('' when unknown or when the
//   session goes to another host than the device itself); target: 'self' or the address the agent connects to.
// The "win" object repeats the tag and the computer name under the field names a SIEM decodes from the Windows
// Security log (workstationName, computer): Wazuh pairs two events only on fields of the same name (same_field).
function auditRecord(o) {
    const r = {
        timestamp: new Date(o.time).toISOString(),
        meshcentral: {
            action: 'webrdp-start', tag: isTag(o.tag) ? o.tag : '',
            nodeid: text(o.nodeid), device: text(o.device), hostname: text(o.hostname),
            userid: text(o.userid), user: text(o.user), rdpuser: text(o.rdpUser), rdpdomain: text(o.rdpDomain),
            target: text(o.target), port: Number.isSafeInteger(o.port) ? o.port : 0, ip: text(o.ip)
        }
    };
    if (isTag(o.tag)) {
        r.win = { eventdata: { workstationName: o.tag } };
        if (r.meshcentral.hostname !== '') { r.win.system = { computer: r.meshcentral.hostname }; }
    }
    return JSON.stringify(r);
}

// Appends one line to the audit file (created readable by its owner only: it names users and holds live tags).
// func(err) after the line is in the file.
function appendAuditLine(file, line, func, fs) {
    (fs || require('node:fs')).appendFile(file, line + '\n', { encoding: 'utf8', mode: 0o600, flag: 'a' }, function (err) { func(err || null); });
}

module.exports = { create: create, isTag: isTag, auditRecord: auditRecord, appendAuditLine: appendAuditLine, TAG: TAG };
