/**
* @description Web-RDP server-side trust (trust on first use): pinned certificate fingerprint and "NLA seen" flag per
* device, target and RDP port, kept in the MeshCentral database (never in the browser). Main process only.
* @license Apache-2.0
*
* One database document per (device, target, port), so a mutation of one target never rewrites another:
*   _id: 'rt' + nodeid + '|' + first 32 hex of SHA-256(key) (short: SQL backends limit ids to 256 characters), type: 'rdptrust',
*   domain, nodeid, key (the logical key), v (version, +1 per mutation), g (generation, +1 per reset), w (random token of the last writer),
*   fp (SHA-256 of the server certificate), nla (CredSSP succeeded once), t, by, pending?: { fp, t, by } (the certificate a refused
*   session presented, awaiting an administrator), accepted?: { t, by, old } (last rotation accepted by an administrator).
*   A reset leaves a tombstone { dead: true, v, g } instead of deleting the document, so nothing that started before the reset can restore
*   state of the old generation; tombstones are invisible to everything else. They are never pruned (a delete would restart the numbering of
*   the key: an ABA race for a stale deleter): the number of keys per device is capped and the caps count tombstones, a pin over a tombstone
*   continues its v and g, and only the removal of the device deletes documents.
* key = 'self/<port>' for the device's own address, or 'addr:<normalized tcpaddr>/<port>' when the session reaches a user-chosen
* address (RDP through the agent to another host of its LAN). A user-chosen address never touches a 'self' entry. Per device at most
* MAX_SELF_ENTRIES 'self' and MAX_ADDR_ENTRIES 'addr' documents, tombstones included (counted with GetAllTypeNodeFiltered); a new key beyond that fails closed.
* Documents are found with GetAllTypeNodeFiltered([nodeid], domain, 'rdptrust'), like the 'deviceshare' records, and removed with the device.
* No stored field name contains '.' or '$' (NeDB and MongoDB < 5 refuse them): the dots of an address live only in values.
*
* Several servers on one shared database (db.SetIfVersion, rdp/db-cas.js, NeDB and MongoDB): every mutation reads the entry, derives the
* new document from that state (nla is only ever raised, an accepted fingerprint is only replaced by the pending one of the state read,
* a session records only into the generation it started in) and writes it with a conditional write on the version. A write that loses
* (another server wrote meanwhile) is derived again from the fresh state, a few times, then fails with error.code 'stale'. Nothing is
* ever written from a stale state, so nothing needs repair.
* Backends without a conditional write (SQL, AceBase) keep a best-effort path: re-read before the write, write version+1 with a new
* token, read back immediately and after VERIFY_DELAY_MS, repair a stale overwrite with a monotone merge (never across a reset) and
* report it (onLate / error.code 'stale'); a stale write landing after the last read-back can still roll state back there.
* A document of the wrong shape is never treated as "not pinned": reads fail closed (error.code 'corrupt') and only an administrator's
* reset removes it.
*/
'use strict';

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const NODE_ID = /^node\/[^\/]{0,64}\/[A-Za-z0-9@$+\/=_-]{1,128}$/;
const KEY = /^(self|addr:[a-z0-9._:-]{1,255})\/([0-9]{1,5})$/;
const ADDR = /^[a-z0-9._:-]{1,255}$/;
const RECORD_TYPE = 'rdptrust';
const MAX_SELF_ENTRIES = 16;
const MAX_ADDR_ENTRIES = 32;
const VERIFY_DELAY_MS = 150;
const MAX_ATTEMPTS = 6;

function validPort(port) { return Number.isInteger(port) && (port >= 1) && (port <= 65535); }
function validNode(nodeid) { return (typeof nodeid == 'string') && NODE_ID.test(nodeid); }
function validFingerprint(fp) { return (typeof fp == 'string') && FINGERPRINT.test(fp); }
function validKey(key) { if (typeof key != 'string') { return false; } const m = KEY.exec(key); return (m !== null) && validPort(Number(m[2])) && (String(Number(m[2])) === m[2]); }

// The target of a session: undefined / null (the device's own address) → 'self'; a user-chosen tcpaddr → 'addr:<lowercase address>';
// anything that is not a plain host name or address (type, characters, length) → null (the caller refuses the session)
function targetOf(tcpaddr) {
    if ((tcpaddr === undefined) || (tcpaddr === null)) { return 'self'; }
    if (typeof tcpaddr != 'string') { return null; }
    const a = tcpaddr.trim().toLowerCase();
    return ADDR.test(a) ? ('addr:' + a) : null;
}
// key of a session, or null when the port is not an integer 1..65535 or the target is invalid
function keyOf(target, port) {
    if (!validPort(port)) { return null; }
    if (target === 'self') { return 'self/' + port; }
    return ((typeof target == 'string') && target.startsWith('addr:') && ADDR.test(target.slice(5))) ? (target + '/' + port) : null;
}
function splitKey(key) { const i = key.lastIndexOf('/'); return { target: key.slice(0, i), port: Number(key.slice(i + 1)) }; }
// Text for events and messages
function describeKey(key) { const k = splitKey(key); return 'port ' + k.port + ((k.target === 'self') ? '' : (' of host ' + k.target.slice(5))); }

// Document ids are short: the key goes into the document, only a hash of it into the id
function keyHash(key) { return require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 32); }
function entryId(nodeid, key) { return 'rt' + nodeid + '|' + keyHash(key); }
function domainOf(nodeid) { return nodeid.split('/')[1]; }

function fail(code) { const e = new Error(code); e.code = code; return e; }
function token() { return require('node:crypto').randomBytes(9).toString('hex'); }

// Result object without the undefined members
function result(o) { for (const k of Object.keys(o)) { if (o[k] === undefined) { delete o[k]; } } return o; }
function gen(doc) { return ((doc != null) && Number.isSafeInteger(doc.g) && (doc.g >= 0)) ? doc.g : 0; }

// Shape every stored document of ours has (live or tombstone); false when malformed. nodeid / key: what it has to be.
function wellFormedBase(doc, nodeid, key) {
    if ((doc == null) || (typeof doc != 'object') || (typeof doc.key != 'string') || !validKey(doc.key) || ((key !== undefined) && (doc.key !== key))) { return false; }
    if ((doc.type !== undefined) && (doc.type !== RECORD_TYPE)) { return false; }       // enumerations of some databases drop the type field
    if ((doc._id !== entryId(nodeid, doc.key)) || (doc.nodeid !== nodeid)) { return false; }
    if (!Number.isSafeInteger(doc.v) || (doc.v < 1)) { return false; }
    if ((doc.g !== undefined) && (!Number.isSafeInteger(doc.g) || (doc.g < 0))) { return false; }
    return true;
}
// Document → view; null when malformed or a tombstone (which is "nothing" for every reader)
function view(doc, nodeid, key) {
    if (!wellFormedBase(doc, nodeid, key) || (doc.dead === true)) { return null; }
    if (!validFingerprint(doc.fp) || (typeof doc.nla !== 'boolean')) { return null; }
    const k = splitKey(doc.key);
    const v = { target: k.target, port: k.port, fingerprint256: doc.fp, nlaSeen: doc.nla, pinnedTime: Number(doc.t) || 0, pinnedBy: (typeof doc.by == 'string') ? doc.by : null, version: doc.v, generation: gen(doc) };
    if (doc.pending !== undefined) {
        if ((doc.pending == null) || (typeof doc.pending != 'object') || !validFingerprint(doc.pending.fp)) { return null; }
        v.pending = { fingerprint256: doc.pending.fp, time: Number(doc.pending.t) || 0, by: (typeof doc.pending.by == 'string') ? doc.pending.by : null };
    }
    if ((doc.accepted != null) && (typeof doc.accepted == 'object')) { v.accepted = { time: Number(doc.accepted.t) || 0, by: (typeof doc.accepted.by == 'string') ? doc.accepted.by : null }; }
    return v;
}
function isTombstone(doc, nodeid) { return wellFormedBase(doc, nodeid) && (doc.dead === true); }
// Same content (what a stale writer could destroy): certificate, NLA flag, pending certificate, last acceptance
function sameContent(a, b) {
    return (a.fp === b.fp) && (a.nla === b.nla) && ((a.pending ? a.pending.fp : null) === (b.pending ? b.pending.fp : null)) && ((a.accepted ? a.accepted.t : 0) === (b.accepted ? b.accepted.t : 0));
}
function classOf(key) { return key.startsWith('self/') ? 'self' : 'addr'; }
function capOf(key) { return (classOf(key) === 'self') ? MAX_SELF_ENTRIES : MAX_ADDR_ENTRIES; }

// db: the MeshCentral database object (Get(id, func(err, docs)), Set(doc, func(err)), Remove(id, func),
// GetAllTypeNodeFiltered(nodes, domain, type, id, func(err, docs)) and, where the backend has it, SetIfVersion(doc, expectedV, func(err, applied)))
// options.verifyDelayMs: the second read-back of the best-effort path (default VERIFY_DELAY_MS)
// options.noConditionalWrite: use the best-effort path although db.SetIfVersion exists (tests)
function create(db, options) {
    const o = options || {};
    const verifyDelay = (o.verifyDelayMs !== undefined) ? o.verifyDelayMs : VERIFY_DELAY_MS;
    const conditional = (typeof db.SetIfVersion == 'function') && (o.noConditionalWrite !== true);
    const queues = new Map();      // node id → tail of the serialized operations on it
    const lateListeners = [];      // best-effort path: told about a stale overwrite found by a delayed read-back after the caller was answered

    // fn(done) runs after the earlier operations on the same device finished; done() lets the next one run
    function serialize(nodeid, fn) {
        const tail = queues.get(nodeid) || Promise.resolve();
        const next = tail.then(function () { return new Promise(function (resolve) { try { fn(resolve); } catch (ex) { resolve(); } }); });
        queues.set(nodeid, next);
        next.then(function () { if (queues.get(nodeid) === next) { queues.delete(nodeid); } });
    }

    function getDoc(id, func) {
        db.Get(id, function (err, docs) {
            if (err) { func(fail('db')); return; }
            func(null, ((docs != null) && (docs.length >= 1) && (docs[0] != null)) ? docs[0] : null);
        });
    }
    // All documents of a device, tombstones included: func(err, docs)
    function allDocs(nodeid, func) {
        db.GetAllTypeNodeFiltered([nodeid], domainOf(nodeid), RECORD_TYPE, null, function (err, docs) {
            if (err) { func(fail('db')); return; }
            func(null, (docs == null) ? [] : docs.filter(function (d) { return (d != null) && (typeof d == 'object'); }));
        });
    }
    // The document of a key: func(err, doc | null, view | null). A tombstone is returned as a document with a null view; a document that
    // exists but is malformed is error 'corrupt'.
    function readEntry(nodeid, key, func) {
        getDoc(entryId(nodeid, key), function (err, doc) {
            if (err) { func(err); return; }
            if (doc === null) { func(null, null, null); return; }
            if (isTombstone(doc, nodeid) && (doc.key === key)) { func(null, doc, null); return; }
            const v = view(doc, nodeid, key);
            if (v === null) { func(fail('corrupt')); return; }
            func(null, doc, v);
        });
    }
    // Does the device have room for one more key of the class of key? Tombstones count: they are never removed
    function room(nodeid, key, func) {
        allDocs(nodeid, function (err, docs) {
            if (err) { func(err); return; }
            let n = 0;
            for (const d of docs) { if ((typeof d.key == 'string') && validKey(d.key) && (classOf(d.key) === classOf(key)) && (d.key !== key)) { n++; } }
            func(null, n < capOf(key));
        });
    }

    // ---- writing ----
    // Monotone merge of our document into what the database holds after a stale overwrite (best-effort path only): nla is only raised; an
    // acceptance of ours that is newer than the stored one is restored; a pending certificate equal to the pinned one is dropped.
    function merged(got, ours) {
        const m = Object.assign({}, got);
        if (ours.nla === true) { m.nla = true; }
        if ((ours.accepted !== undefined) && (ours.accepted.t > ((got.accepted !== undefined) ? got.accepted.t : 0))) { m.fp = ours.fp; m.accepted = ours.accepted; }
        if ((m.pending !== undefined) && (m.pending.fp === m.fp)) { delete m.pending; }
        m.v = got.v + 1; m.w = token();
        return m;
    }
    function nextDoc(cur, changes) {
        const d = Object.assign({}, cur, changes);
        d.v = cur.v + 1; d.w = token();
        return d;
    }
    function tombstoneOf(cur) {
        return { _id: cur._id, type: RECORD_TYPE, domain: cur.domain, nodeid: cur.nodeid, key: cur.key, v: cur.v + 1, g: gen(cur) + 1, w: token(), dead: true, t: Date.now() };
    }

    // Best-effort write (no conditional write on the backend): re-read right before, write, read back immediately and after verifyDelay.
    // base: the document the change was derived from (null: a new entry). func(err, verdict, got):
    // verdict 'ok' | 'stale' (the content is not what the database holds) | 'other' (another certificate is stored: two first pins)
    function writeBestEffort(doc, base, func, late) {
        const verdictOf = function (got) {
            if (doc.dead === true) { return ((got !== null) && (got.dead === true) && (gen(got) >= gen(doc))) ? 'ok' : 'stale'; }     // our write is a reset
            if ((got === null) || (got.dead === true) || (view(got, doc.nodeid, doc.key) === null)) { return 'stale'; }
            if (got.w === doc.w) { return 'ok'; }
            if (gen(got) !== gen(doc)) { return 'stale'; }
            return sameContent(got, doc) ? 'ok' : (((base === null) && (got.fp !== doc.fp)) ? 'other' : 'stale');   // 'other': two first pins of different certificates
        };
        const repair = function (got, done) {
            // never across a reset: a document of another generation, or a tombstone, is left alone
            if ((doc.dead === true) || (got === null) || (got.dead === true) || (view(got, doc.nodeid, doc.key) === null) || (gen(got) !== gen(doc))) { done(); return; }
            const m = merged(got, doc);
            if (sameContent(m, got)) { done(); return; }
            db.Set(m, function () { done(); });
        };
        const second = function (report) {
            const run = function () {
                getDoc(doc._id, function (err, got) {
                    if (err) { report(err); return; }
                    const verdict = verdictOf(got);
                    if (verdict === 'stale') { repair(got, function () { report(null, 'stale', got); }); return; }
                    report(null, verdict, got);
                });
            };
            if (verifyDelay > 0) { setTimeout(run, verifyDelay); } else { run(); }
        };
        const check = function () {
            getDoc(doc._id, function (err, got) {
                if (err) { func(err); return; }
                const verdict = verdictOf(got);
                if (verdict === 'stale') { repair(got, function () { func(null, 'stale', got); }); return; }
                if (verdict !== 'ok') { func(null, verdict, got); return; }
                if (late === true) {
                    func(null, 'ok', got);
                    second(function (err, v, g) { if ((err == null) && (v !== 'ok')) { for (const l of lateListeners) { try { l({ nodeid: doc.nodeid, key: doc.key, verdict: v, expected: doc.fp, stored: ((g !== null) && g.fp) ? g.fp : null }); } catch (ex) { } } } });
                    return;
                }
                second(func);
            });
        };
        getDoc(doc._id, function (err, now) {
            if (err) { func(err); return; }
            const unchanged = (base === null) ? (now === null) : ((now !== null) && (now.v === base.v) && (now.w === base.w));
            if (!unchanged) {
                if ((base === null) && (now !== null) && (view(now, doc.nodeid, doc.key) !== null)) { func(null, sameContent(now, doc) ? 'ok' : ((now.fp !== doc.fp) ? 'other' : 'stale'), now); return; }
                func(null, 'stale', now); return;
            }
            db.Set(doc, function (err) { if (err) { func(fail('db')); return; } check(); });
        });
    }

    // One mutation of one entry, inside the device queue. decide(cur, view) is a pure function of the state read:
    //   { result }                                 nothing to write
    //   { error: code }                            fail
    //   { doc, result, isNew, onOther? }           write doc (derived from cur) ; isNew: the entry is created (the cap is checked first)
    // With a conditional write a lost race re-reads and decides again from the fresh state (so the monotone rules are applied to what is
    // really stored); the best-effort path writes once and reports what the read-backs found.
    // late: the best-effort path answers after the immediate read-back and verifies in the background (a session's own pin / NLA flag)
    function mutate(nodeid, key, decide, late, func) {
        let attempts = 0;
        const attempt = function () {
            readEntry(nodeid, key, function (err, cur, v) {
                if (err) { func(err); return; }
                const plan = decide(cur, v);
                if (plan.error) { func(fail(plan.error)); return; }
                if (plan.doc === undefined) { func(null, plan.result); return; }
                const write = function () {
                    if (conditional) {
                        db.SetIfVersion(plan.doc, (cur === null) ? null : cur.v, function (err, applied) {
                            if (err) { func(fail('db')); return; }
                            if (applied) { func(null, plan.result); return; }
                            if (++attempts >= MAX_ATTEMPTS) { func(fail('stale')); return; }
                            attempt();                                   // lost the race: decide again from the fresh state
                        });
                        return;
                    }
                    writeBestEffort(plan.doc, cur, function (err, verdict, got) {
                        if (err) { func(err); return; }
                        if (verdict === 'ok') { func(null, plan.result); return; }
                        if ((verdict === 'other') && plan.onOther) { func(null, plan.onOther(got)); return; }
                        func(fail('stale'));
                    }, late === true);
                };
                if (plan.isNew) {
                    room(nodeid, key, function (err, ok) {
                        if (err) { func(err); return; }
                        if (!ok) { func(fail('limit')); return; }
                        write();
                    });
                } else { write(); }
            });
        };
        attempt();
    }

    const bad = function (nodeid, key) { return !validNode(nodeid) || !validKey(key); };

    const api = {
        // fn({ nodeid, key, verdict: 'stale' | 'other', expected, stored }): the best-effort path found a stale overwrite after the session was
        // answered (the monotone merge has been written back); callers audit it. Never called with a conditional write.
        onLate: function (fn) { lateListeners.push(fn); },
        conditional: conditional,

        // func(err, { fingerprint256, nlaSeen, gen }): the pin of this device, target and port; { null, false } when none yet. gen is the
        // generation the session starts in (recordSuccess records only into it).
        // err.code: 'corrupt' (malformed document), 'limit' (a new key beyond the per-device cap), 'db'
        get: function (nodeid, key, func) {
            if (bad(nodeid, key)) { func(fail('arg')); return; }
            (function () {
                readEntry(nodeid, key, function (err, doc, v) {
                    if (err) { func(err); return; }
                    if (v !== null) { func(null, { fingerprint256: v.fingerprint256, nlaSeen: v.nlaSeen, gen: v.generation }); return; }
                    room(nodeid, key, function (err, ok) {
                        if (err) { func(err); return; }
                        func(ok ? null : fail('limit'), { fingerprint256: null, nlaSeen: false, gen: gen(doc) });
                    });
                });
            })();
        },

        // func(err, { corrupt: bool, entries: { [key]: view } }); a malformed document is reported, not hidden
        list: function (nodeid, func) {
            if (!validNode(nodeid)) { func(fail('arg')); return; }
            allDocs(nodeid, function (err, docs) {
                if (err) { func(err); return; }
                const out = {};
                let corrupt = false;
                for (const d of docs) {
                    if (isTombstone(d, nodeid)) { continue; }
                    const v = view(d, nodeid);
                    if (v === null) { corrupt = true; } else { out[d.key] = v; }
                }
                func(null, { corrupt: corrupt, entries: out });
            });
        },

        // A session connected: obs = { fingerprint256, nla, userid, gen? }. First connection pins (TOFU), CredSSP success sets nlaSeen (never lowered).
        // gen: the generation the session started in; after a reset (another generation) nothing is recorded.
        // func(err, { status: 'pinned' | 'nla-learned' | 'unchanged' | 'conflict' | 'reset' })
        // 'conflict': another session pinned a different certificate meanwhile; the caller ends this session.
        // err.code 'stale': the document kept changing under this write; the caller fails the session closed and audits.
        recordSuccess: function (nodeid, domain, key, obs, func) {
            if (bad(nodeid, key) || !validFingerprint(obs.fingerprint256)) { func(fail('arg')); return; }
            (function () {
                serialize(nodeid, function (done) {
                    mutate(nodeid, key, function (cur, v) {
                        const g = gen(cur);
                        if ((obs.gen !== undefined) && (obs.gen !== g)) { return { result: { status: 'reset' } }; }
                        if (cur === null || cur.dead === true) {
                            const d = { _id: entryId(nodeid, key), type: RECORD_TYPE, domain: domainOf(nodeid), nodeid: nodeid, key: key, v: (cur === null) ? 1 : cur.v + 1, g: g, w: token(), fp: obs.fingerprint256, nla: obs.nla === true, t: Date.now(), by: String(obs.userid || '') };
                            return { doc: d, isNew: true, result: { status: 'pinned' }, onOther: function (got) { return { status: 'conflict', expected: got.fp }; } };
                        }
                        if (cur.fp !== obs.fingerprint256) { return { result: { status: 'conflict', expected: cur.fp } }; }
                        if ((obs.nla === true) && (cur.nla !== true)) {
                            const d = nextDoc(cur, { nla: true }); delete d.pending;
                            return { doc: d, result: { status: 'nla-learned' } };
                        }
                        if (cur.pending !== undefined) {
                            const d = nextDoc(cur, {}); delete d.pending;
                            return { doc: d, result: { status: 'unchanged' } };
                        }
                        return { result: { status: 'unchanged' } };
                    }, true, function (err, r) { done(); func(err, r); });
                });
            })();
        },

        // A session was refused because the server presented another certificate: remembered so an administrator can accept exactly it.
        // sessionGen (optional): the generation the session started in; after a reset nothing is recorded. func(err, boolean stored)
        recordMismatch: function (nodeid, key, actual, userid, sessionGen, func) {
            if (typeof sessionGen == 'function') { func = sessionGen; sessionGen = undefined; }
            if (bad(nodeid, key) || !validFingerprint(actual)) { func(fail('arg')); return; }
            serialize(nodeid, function (done) {
                mutate(nodeid, key, function (cur, v) {
                    if ((cur === null) || (cur.dead === true) || (cur.fp === actual)) { return { result: false }; }
                    if ((sessionGen !== undefined) && (sessionGen !== gen(cur))) { return { result: false }; }      // the session started before a reset: it records nothing
                    if ((cur.pending !== undefined) && (cur.pending.fp === actual)) { return { result: true }; }
                    return { doc: nextDoc(cur, { pending: { fp: actual, t: Date.now(), by: String(userid || '') } }), result: true };
                }, false, function (err, r) { done(); func(err, r); });
            });
        },

        // An administrator accepts the certificate a refused session presented. func(err, { ok, reason?, old?, fingerprint256? })
        accept: function (nodeid, key, fingerprint256, userid, func) {
            if (bad(nodeid, key) || !validFingerprint(fingerprint256)) { func(fail('arg')); return; }
            (function () {
                serialize(nodeid, function (done) {
                    mutate(nodeid, key, function (cur, v) {
                        if ((cur === null) || (cur.dead === true)) { return { result: { ok: false, reason: 'not-pinned' } }; }
                        if (cur.fp === fingerprint256) { return { result: { ok: true, old: cur.fp, fingerprint256: cur.fp, unchanged: true } }; }
                        // only the certificate a refused session really presented can be accepted: never an arbitrary value
                        if ((cur.pending === undefined) || (cur.pending.fp !== fingerprint256)) { return { result: { ok: false, reason: 'not-presented', current: (cur.pending !== undefined) ? cur.pending.fp : null } }; }
                        const d = nextDoc(cur, { fp: fingerprint256, accepted: { t: Date.now(), by: String(userid || ''), old: cur.fp } }); delete d.pending;
                        return { doc: d, result: { ok: true, old: cur.fp, fingerprint256: fingerprint256 } };
                    }, false, function (err, r) { done(); func(err, r); });
                });
            })();
        },

        // Forget one pin (key) or, with key null, all of the device; the next connection pins again, in a new generation. The documents become
        // tombstones, nothing is deleted (the numbering of v and g of a key never restarts). A malformed document is replaced by a tombstone
        // too (an administrator's way out of the fail-closed state); its numbers continue from whatever valid counters it still has.
        // func(err, { ok, had, old?, corrupt? })
        reset: function (nodeid, key, func) {
            if (!validNode(nodeid) || ((key !== null) && !validKey(key))) { func(fail('arg')); return; }
            serialize(nodeid, function (done) {
                const end = function (err, r) { done(); func(err, r); };
                // one valid live document → tombstone (conditional write, decided again when it changed meanwhile); func(err, old fingerprint | null)
                const kill = function (k, cb) {
                    mutate(nodeid, k, function (cur, v) {
                        if ((cur === null) || (cur.dead === true)) { return { result: null }; }
                        return { doc: tombstoneOf(cur), result: cur.fp };
                    }, false, cb);
                };
                // a malformed document of a known key → tombstone with counters above the valid ones it has
                const bury = function (k, doc, cb) {
                    const d = { _id: entryId(nodeid, k), type: RECORD_TYPE, domain: domainOf(nodeid), nodeid: nodeid, key: k,
                        v: ((Number.isSafeInteger(doc.v) && (doc.v >= 1)) ? doc.v : 0) + 1, g: ((Number.isSafeInteger(doc.g) && (doc.g >= 0)) ? doc.g : 0) + 1, w: token(), dead: true, t: Date.now() };
                    db.Set(d, function () { cb(); });
                };
                if (key !== null) {
                    getDoc(entryId(nodeid, key), function (err, doc) {
                        if (err) { end(err); return; }
                        if (doc === null) { end(null, { ok: true, had: false }); return; }
                        if (!isTombstone(doc, nodeid) && (view(doc, nodeid, key) === null)) { bury(key, doc, function () { end(null, { ok: true, had: true, corrupt: true }); }); return; }
                        kill(key, function (err, old) { if (err) { end(err); return; } end(null, result({ ok: true, had: old !== null, old: (old !== null) ? old : undefined })); });
                    });
                    return;
                }
                allDocs(nodeid, function (err, docs) {
                    if (err) { end(err); return; }
                    let n = 0, had = false, corrupt = false;
                    const next = function () {
                        if (n >= docs.length) { end(null, result({ ok: true, had: had, corrupt: corrupt || undefined })); return; }
                        const d = docs[n++];
                        if (isTombstone(d, nodeid)) { next(); return; }
                        if (view(d, nodeid) === null) {
                            corrupt = true; had = true;
                            if ((typeof d.key == 'string') && validKey(d.key) && (d._id === entryId(nodeid, d.key))) { bury(d.key, d, next); } else { db.Remove(d._id, next); }   // no key to keep numbers for
                            return;
                        }
                        kill(d.key, function (err, old) { if (err) { end(err); return; } if (old !== null) { had = true; } next(); });
                    };
                    next();
                });
            });
        },

        // The device is deleted: every document of it (tombstones too), inside the device queue
        removeNode: function (nodeid) {
            if (!validNode(nodeid)) { return; }
            serialize(nodeid, function (done) {
                allDocs(nodeid, function (err, docs) {
                    if (err) { done(); return; }
                    let i = 0;
                    const next = function () { if (i >= docs.length) { done(); return; } const d = docs[i++]; if (typeof d._id == 'string') { db.Remove(d._id, next); } else { next(); } };
                    next();
                });
            });
        }
    };
    return api;
}

// One store per database object
const stores = new WeakMap();
function forDb(db) {
    let s = stores.get(db);
    if (s == null) { s = create(db); stores.set(db, s); }
    return s;
}

// Audit event of the MeshCentral event log. who: user id or null, action text without secrets (fingerprints are public values)
function auditEvent(parent, domain, nodeid, meshid, who, msg) {
    try {
        const user = (who != null) ? parent.users[who] : null;
        const event = { etype: 'node', action: 'webrdptrust', domain: domain.id, nodeid: nodeid, userid: who || undefined, username: (user != null) ? user.name : undefined, msg: msg };
        parent.parent.DispatchEvent(['*', nodeid, meshid, who].filter(function (x) { return x != null; }), { }, event);
    } catch (ex) { }
}

// The 'webrdptrust' control command (meshuser.js). o: { command, domain, user, db, getNode(nodeid, func(node, rights, visible)),
// rightsOk(rights), reply(object), audit(node, msg) }. Replies { action, op, nodeid, result: 'ok' | text, responseid?, entries?, corrupt? }.
// command: { op: 'list' | 'accept' | 'reset', nodeid, key (accept, reset: 'self/3389'), fingerprint256 (accept), all (reset: true removes the whole record) }
function handleCommand(o) {
    const command = o.command;
    const reply = function (r) { if (command.responseid != null) { r.responseid = command.responseid; } r.action = 'webrdptrust'; r.op = command.op; r.nodeid = command.nodeid; o.reply(r); };
    let err = null;
    try {
        if ((typeof command.nodeid != 'string') || (command.nodeid.length < 1) || (command.nodeid.length > 1024)) { err = 'Invalid nodeid'; }
        else {
            if (command.nodeid.indexOf('/') == -1) { command.nodeid = 'node/' + o.domain.id + '/' + command.nodeid; }
            if ((command.nodeid.split('/').length != 3) || (command.nodeid.split('/')[1] != o.domain.id) || !validNode(command.nodeid)) { err = 'Invalid nodeid'; }
            else if (['list', 'accept', 'reset'].indexOf(command.op) < 0) { err = 'Invalid operation'; }
            else if ((command.op == 'accept') && !validKey(command.key)) { err = 'Invalid target'; }
            else if ((command.op == 'reset') && (command.all !== true) && !validKey(command.key)) { err = 'Invalid target'; }
            else if ((command.op == 'accept') && !validFingerprint(command.fingerprint256)) { err = 'Invalid fingerprint'; }
        }
    } catch (ex) { err = 'Invalid request'; }
    if (err != null) { reply({ result: err }); return; }
    o.getNode(command.nodeid, function (node, rights, visible) {
        if ((node == null) || !o.rightsOk(rights)) { reply({ result: 'Access Denied' }); return; }
        const trust = forDb(o.db);
        if (command.op == 'list') {
            trust.list(node._id, function (err, r) { reply(err ? { result: 'Error' } : { result: 'ok', entries: r.entries, corrupt: r.corrupt }); });
        } else if (command.op == 'accept') {
            trust.accept(node._id, command.key, command.fingerprint256, o.user._id, function (err, r) {
                if (err) { if (err.code === 'stale') { o.audit(node, 'Accepting a Web-RDP certificate of ' + describeKey(command.key) + ' of device ' + node.name + ' failed: the trust record was changed at the same time by another server'); } reply({ result: (err.code === 'corrupt') ? 'The stored trust record is damaged, reset it' : ((err.code === 'stale') ? 'The trust record was changed at the same time, check it and try again' : 'Error') }); return; }
                if (r.ok !== true) { reply({ result: (r.reason == 'not-presented') ? 'The server presented another certificate since, connect again to see it' : 'Nothing to accept' }); return; }
                if (r.unchanged !== true) { o.audit(node, 'Accepted the new Web-RDP certificate of ' + describeKey(command.key) + ' of device ' + node.name + ': SHA-256 ' + r.old + ' replaced by ' + r.fingerprint256); }
                reply({ result: 'ok' });
            });
        } else {
            trust.reset(node._id, (command.all === true) ? null : command.key, function (err, r) {
                if (err) { reply({ result: 'Error' }); return; }
                if (r.had) { o.audit(node, 'Reset the Web-RDP certificate pin and NLA requirement of ' + ((command.all === true) ? 'all targets' : describeKey(command.key)) + ' of device ' + node.name + (r.old ? (' (was SHA-256 ' + r.old + ')') : (r.corrupt ? ' (the stored record was damaged)' : ''))); }
                reply({ result: 'ok' });
            });
        }
    });
}

module.exports = {
    create: create, forDb: forDb, auditEvent: auditEvent, handleCommand: handleCommand, validNode: validNode, validPort: validPort,
    validFingerprint: validFingerprint, validKey: validKey, targetOf: targetOf, keyOf: keyOf, describeKey: describeKey, splitKey: splitKey,
    FINGERPRINT: FINGERPRINT, MAX_SELF_ENTRIES: MAX_SELF_ENTRIES, MAX_ADDR_ENTRIES: MAX_ADDR_ENTRIES, VERIFY_DELAY_MS: VERIFY_DELAY_MS, entryId: entryId
};
