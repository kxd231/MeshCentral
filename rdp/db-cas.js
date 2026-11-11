/**
* @description Conditional (compare-and-set on the version field `v`) document writes for the MeshCentral database backends that can do
* them atomically: NeDB / MongoJS (embedded collection API) and the MongoDB driver. Used by db.js as obj.SetIfVersion (rdp/trust.js).
* @license Apache-2.0
*
* setIfVersion(doc, expectedV, func): func(err, applied)
*   expectedV null / undefined: insert only, applied is false when a document with that _id exists (the first pin);
*   expectedV a number: replace the existing document only when it has exactly that `v`, applied is false when it is missing or changed.
* The other backends (SQL, AceBase) have no such primitive here; db.js leaves SetIfVersion undefined for them.
*/
'use strict';

function isDuplicate(err) {
    return (err != null) && ((err.errorType === 'uniqueViolated') || (err.code === 11000) || (err.code === 11001) || /E11000/.test(String(err.message || '')));
}
// Number of documents the update touched: NeDB passes a number, mongojs { n, nModified }, the MongoDB driver { matchedCount } or { result: { n } }
function affected(r) {
    if (typeof r == 'number') { return r; }
    if (r == null) { return 0; }
    if (typeof r.matchedCount == 'number') { return r.matchedCount; }
    if (typeof r.n == 'number') { return r.n; }
    if ((r.result != null) && (typeof r.result.n == 'number')) { return r.result.n; }
    return 0;
}

// NeDB Datastore or mongojs collection: file.insert(doc, cb), file.update(query, replacement, options, cb)
function embedded(file, doc, expectedV, func) {
    if ((expectedV === null) || (expectedV === undefined)) {
        file.insert(doc, function (err) { if (isDuplicate(err)) { func(null, false); } else { func(err || null, !err); } });
        return;
    }
    file.update({ _id: doc._id, v: expectedV }, doc, { upsert: false }, function (err, r) { func(err || null, !err && (affected(r) > 0)); });
}

// MongoDB driver collection: insertOne, replaceOne
function mongodb(collection, doc, expectedV, func) {
    if ((expectedV === null) || (expectedV === undefined)) {
        collection.insertOne(doc, function (err) { if (isDuplicate(err)) { func(null, false); } else { func(err || null, !err); } });
        return;
    }
    collection.replaceOne({ _id: doc._id, v: expectedV }, doc, { upsert: false }, function (err, r) { func(err || null, !err && (affected(r) > 0)); });
}

module.exports = { embedded: embedded, mongodb: mongodb, isDuplicate: isDuplicate, affected: affected };
