"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pouchdb_adapter_utils_1 = require("pouchdb-adapter-utils");
const pouchdb_merge_1 = require("pouchdb-merge");
const pouchdb_json_1 = require("pouchdb-json");
const pouchdb_errors_1 = require("pouchdb-errors");
const constants_1 = require("./constants");
const utils_1 = require("./utils");
function websqlBulkDocs(dbOpts, req, opts, api, db, websqlChanges, callback) {
    var newEdits = opts.new_edits;
    var userDocs = req.docs;
    // Parse the docs, give them a sequence number for the result
    var docInfos = userDocs.map(function (doc) {
        if (doc._id && (0, pouchdb_adapter_utils_1.isLocalId)(doc._id)) {
            return doc;
        }
        var newDoc = (0, pouchdb_adapter_utils_1.parseDoc)(doc, newEdits, dbOpts);
        return newDoc;
    });
    var docInfoErrors = docInfos.filter(function (docInfo) {
        return docInfo.error;
    });
    if (docInfoErrors.length) {
        return callback(docInfoErrors[0]);
    }
    var tx;
    var results = new Array(docInfos.length);
    var fetchedDocs = new Map();
    var preconditionErrored;
    function complete() {
        if (preconditionErrored) {
            return callback(preconditionErrored);
        }
        websqlChanges.notify(api._name);
        callback(null, results);
    }
    function verifyAttachment(digest, callback) {
        var sql = 'SELECT count(*) as cnt FROM ' + constants_1.ATTACH_STORE +
            ' WHERE digest=?';
        tx.executeSql(sql, [digest], function (tx, result) {
            if (result.rows.item(0).cnt === 0) {
                var err = (0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_STUB, 'unknown stub attachment with digest ' +
                    digest);
                callback(err);
            }
            else {
                callback();
            }
        });
    }
    function verifyAttachments(finish) {
        var digests = [];
        docInfos.forEach(function (docInfo) {
            if (docInfo.data && docInfo.data._attachments) {
                Object.keys(docInfo.data._attachments).forEach(function (filename) {
                    var att = docInfo.data._attachments[filename];
                    if (att.stub) {
                        digests.push(att.digest);
                    }
                });
            }
        });
        if (!digests.length) {
            return finish();
        }
        var numDone = 0;
        var err;
        function checkDone() {
            if (++numDone === digests.length) {
                finish(err);
            }
        }
        digests.forEach(function (digest) {
            verifyAttachment(digest, function (attErr) {
                if (attErr && !err) {
                    err = attErr;
                }
                checkDone();
            });
        });
    }
    function writeDoc(docInfo, winningRev, winningRevIsDeleted, newRevIsDeleted, isUpdate, delta, resultsIdx, callback) {
        function finish() {
            var data = docInfo.data;
            var deletedInt = newRevIsDeleted ? 1 : 0;
            var id = data._id;
            var rev = data._rev;
            var json = (0, utils_1.stringifyDoc)(data);
            var sql = 'INSERT INTO ' + constants_1.BY_SEQ_STORE +
                ' (doc_id, rev, json, deleted) VALUES (?, ?, ?, ?);';
            var sqlArgs = [id, rev, json, deletedInt];
            // map seqs to attachment digests, which
            // we will need later during compaction
            function insertAttachmentMappings(seq, callback) {
                var attsAdded = 0;
                var attsToAdd = Object.keys(data._attachments || {});
                if (!attsToAdd.length) {
                    return callback();
                }
                function checkDone() {
                    if (++attsAdded === attsToAdd.length) {
                        callback();
                    }
                    return false; // ack handling a constraint error
                }
                function add(att) {
                    var sql = 'INSERT INTO ' + constants_1.ATTACH_AND_SEQ_STORE +
                        ' (digest, seq) VALUES (?,?)';
                    var sqlArgs = [data._attachments[att].digest, seq];
                    tx.executeSql(sql, sqlArgs, checkDone, checkDone);
                    // second callback is for a constaint error, which we ignore
                    // because this docid/rev has already been associated with
                    // the digest (e.g. when new_edits == false)
                }
                for (var i = 0; i < attsToAdd.length; i++) {
                    add(attsToAdd[i]); // do in parallel
                }
            }
            tx.executeSql(sql, sqlArgs, function (tx, result) {
                var seq = result.insertId;
                insertAttachmentMappings(seq, function () {
                    dataWritten(tx, seq);
                });
            }, function () {
                // constraint error, recover by updating instead (see #1638)
                var fetchSql = (0, utils_1.select)('seq', constants_1.BY_SEQ_STORE, null, 'doc_id=? AND rev=?', undefined);
                tx.executeSql(fetchSql, [id, rev], function (tx, res) {
                    var seq = res.rows.item(0).seq;
                    var sql = 'UPDATE ' + constants_1.BY_SEQ_STORE +
                        ' SET json=?, deleted=? WHERE doc_id=? AND rev=?;';
                    var sqlArgs = [json, deletedInt, id, rev];
                    tx.executeSql(sql, sqlArgs, function (tx) {
                        insertAttachmentMappings(seq, function () {
                            dataWritten(tx, seq);
                        });
                    });
                });
                return false; // ack that we've handled the error
            });
        }
        function collectResults(attachmentErr) {
            if (!err) {
                if (attachmentErr) {
                    err = attachmentErr;
                    callback(err);
                }
                else if (recv === attachments.length) {
                    finish();
                }
            }
        }
        var err = null;
        var recv = 0;
        docInfo.data._id = docInfo.metadata.id;
        docInfo.data._rev = docInfo.metadata.rev;
        var attachments = Object.keys(docInfo.data._attachments || {});
        if (newRevIsDeleted) {
            docInfo.data._deleted = true;
        }
        function attachmentSaved(err) {
            recv++;
            collectResults(err);
        }
        attachments.forEach(function (key) {
            var att = docInfo.data._attachments[key];
            if (!att.stub) {
                var data = att.data;
                delete att.data;
                att.revpos = parseInt(winningRev, 10);
                var digest = att.digest;
                saveAttachment(digest, data, attachmentSaved);
            }
            else {
                recv++;
                collectResults(undefined);
            }
        });
        if (!attachments.length) {
            finish();
        }
        function dataWritten(tx, seq) {
            var id = docInfo.metadata.id;
            var revsToCompact = docInfo.stemmedRevs || [];
            if (isUpdate && api.auto_compaction) {
                revsToCompact = (0, pouchdb_merge_1.compactTree)(docInfo.metadata).concat(revsToCompact);
            }
            if (revsToCompact.length) {
                (0, utils_1.compactRevs)(revsToCompact, id, tx);
            }
            docInfo.metadata.seq = seq;
            var rev = docInfo.metadata.rev;
            delete docInfo.metadata.rev;
            var sql = isUpdate ?
                'UPDATE ' + constants_1.DOC_STORE +
                    ' SET json=?, max_seq=?, winningseq=' +
                    '(SELECT seq FROM ' + constants_1.BY_SEQ_STORE +
                    ' WHERE doc_id=' + constants_1.DOC_STORE + '.id AND rev=?) WHERE id=?'
                : 'INSERT INTO ' + constants_1.DOC_STORE +
                    ' (id, winningseq, max_seq, json) VALUES (?,?,?,?);';
            var metadataStr = (0, pouchdb_json_1.safeJsonStringify)(docInfo.metadata);
            var params = isUpdate ?
                [metadataStr, seq, winningRev, id] :
                [id, seq, seq, metadataStr];
            tx.executeSql(sql, params, function () {
                results[resultsIdx] = {
                    ok: true,
                    id: docInfo.metadata.id,
                    rev: rev
                };
                fetchedDocs.set(id, docInfo.metadata);
                callback();
            });
        }
    }
    function websqlProcessDocs() {
        (0, pouchdb_adapter_utils_1.processDocs)(dbOpts.revs_limit, docInfos, api, fetchedDocs, tx, results, writeDoc, opts);
    }
    function fetchExistingDocs(callback) {
        if (!docInfos.length) {
            return callback();
        }
        var numFetched = 0;
        function checkDone() {
            if (++numFetched === docInfos.length) {
                callback();
            }
        }
        docInfos.forEach(function (docInfo) {
            if (docInfo._id && (0, pouchdb_adapter_utils_1.isLocalId)(docInfo._id)) {
                return checkDone(); // skip local docs
            }
            var id = docInfo.metadata.id;
            tx.executeSql('SELECT json FROM ' + constants_1.DOC_STORE +
                ' WHERE id = ?', [id], function (tx, result) {
                if (result.rows.length) {
                    var metadata = (0, pouchdb_json_1.safeJsonParse)(result.rows.item(0).json);
                    fetchedDocs.set(id, metadata);
                }
                checkDone();
            });
        });
    }
    function saveAttachment(digest, data, callback) {
        var sql = 'SELECT digest FROM ' + constants_1.ATTACH_STORE + ' WHERE digest=?';
        tx.executeSql(sql, [digest], function (tx, result) {
            if (result.rows.length) { // attachment already exists
                return callback();
            }
            // we could just insert before selecting and catch the error,
            // but my hunch is that it's cheaper not to serialize the blob
            // from JS to C if we don't have to (TODO: confirm this)
            sql = 'INSERT INTO ' + constants_1.ATTACH_STORE +
                ' (digest, body, escaped) VALUES (?,?,1)';
            tx.executeSql(sql, [digest, (0, utils_1.escapeBlob)(data)], function () {
                callback();
            }, function () {
                // ignore constaint errors, means it already exists
                callback();
                return false; // ack we handled the error
            });
        });
    }
    (0, pouchdb_adapter_utils_1.preprocessAttachments)(docInfos, 'binary', function (err) {
        if (err) {
            return callback(err);
        }
        db.transaction(function (txn) {
            tx = txn;
            verifyAttachments(function (err) {
                if (err) {
                    preconditionErrored = err;
                }
                else {
                    fetchExistingDocs(websqlProcessDocs);
                }
            });
        }, (0, utils_1.websqlError)(callback), complete);
    });
}
exports.default = websqlBulkDocs;
