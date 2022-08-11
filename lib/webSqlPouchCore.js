"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSqlPouch = void 0;
const pouchdb_utils_1 = require("pouchdb-utils");
const pouchdb_adapter_utils_1 = require("pouchdb-adapter-utils");
const pouchdb_merge_1 = require("pouchdb-merge");
const pouchdb_json_1 = require("pouchdb-json");
const pouchdb_binary_utils_1 = require("pouchdb-binary-utils");
const parseHex_1 = __importDefault(require("./parseHex"));
const bulkDocs_1 = __importDefault(require("./bulkDocs"));
const pouchdb_errors_1 = require("pouchdb-errors");
const constants_1 = require("./constants");
const utils_1 = require("./utils");
const openDatabase_1 = __importDefault(require("./openDatabase"));
var websqlChanges = new pouchdb_utils_1.changesHandler();
function fetchAttachmentsIfNecessary(doc, opts, api, txn, cb) {
    var attachments = Object.keys(doc._attachments || {});
    if (!attachments.length) {
        return cb && cb();
    }
    var numDone = 0;
    function checkDone() {
        if (++numDone === attachments.length && cb) {
            cb();
        }
    }
    function fetchAttachment(doc, att) {
        var attObj = doc._attachments[att];
        var attOpts = { binary: opts.binary, ctx: txn };
        api._getAttachment(doc._id, att, attObj, attOpts, function (_, data) {
            doc._attachments[att] = Object.assign((0, pouchdb_utils_1.pick)(attObj, ['digest', 'content_type']), { data: data });
            checkDone();
        });
    }
    attachments.forEach(function (att) {
        if (opts.attachments && opts.include_docs) {
            fetchAttachment(doc, att);
        }
        else {
            doc._attachments[att].stub = true;
            checkDone();
        }
    });
}
var POUCH_VERSION = 1;
// these indexes cover the ground for most allDocs queries
var BY_SEQ_STORE_DELETED_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS \'by-seq-deleted-idx\' ON ' +
    constants_1.BY_SEQ_STORE + ' (seq, deleted)';
var BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL = 'CREATE UNIQUE INDEX IF NOT EXISTS \'by-seq-doc-id-rev\' ON ' +
    constants_1.BY_SEQ_STORE + ' (doc_id, rev)';
var DOC_STORE_WINNINGSEQ_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS \'doc-winningseq-idx\' ON ' +
    constants_1.DOC_STORE + ' (winningseq)';
var ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS \'attach-seq-seq-idx\' ON ' +
    constants_1.ATTACH_AND_SEQ_STORE + ' (seq)';
var ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL = 'CREATE UNIQUE INDEX IF NOT EXISTS \'attach-seq-digest-idx\' ON ' +
    constants_1.ATTACH_AND_SEQ_STORE + ' (digest, seq)';
var DOC_STORE_AND_BY_SEQ_JOINER = constants_1.BY_SEQ_STORE +
    '.seq = ' + constants_1.DOC_STORE + '.winningseq';
var SELECT_DOCS = constants_1.BY_SEQ_STORE + '.seq AS seq, ' +
    constants_1.BY_SEQ_STORE + '.deleted AS deleted, ' +
    constants_1.BY_SEQ_STORE + '.json AS data, ' +
    constants_1.BY_SEQ_STORE + '.rev AS rev, ' +
    constants_1.DOC_STORE + '.json AS metadata';
function WebSqlPouch(opts, callback) {
    var api = this;
    var instanceId = null;
    var size = (0, utils_1.getSize)(opts);
    var idRequests = [];
    var encoding;
    api._name = opts.name;
    // extend the options here, because sqlite plugin has a ton of options
    // and they are constantly changing, so it's more prudent to allow anything
    var websqlOpts = Object.assign({}, opts, {
        version: POUCH_VERSION,
        description: opts.name,
        size: size
    });
    var openDBResult = (0, openDatabase_1.default)(websqlOpts);
    if (openDBResult.error) {
        return (0, utils_1.websqlError)(callback)(openDBResult.error);
    }
    var db = openDBResult.db;
    if (typeof db.readTransaction !== 'function') {
        // doesn't exist in sqlite plugin
        db.readTransaction = db.transaction;
    }
    function dbCreated() {
        // note the db name in case the browser upgrades to idb
        if ((0, pouchdb_utils_1.hasLocalStorage)()) {
            // @ts-ignore
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            window.localStorage['_pouch__websqldb_' + api._name] = true;
        }
        callback(null, api);
    }
    // In this migration, we added the 'deleted' and 'local' columns to the
    // by-seq and doc store tables.
    // To preserve existing user data, we re-process all the existing JSON
    // and add these values.
    // Called migration2 because it corresponds to adapter version (db_version) #2
    function runMigration2(tx, callback) {
        // index used for the join in the allDocs query
        tx.executeSql(DOC_STORE_WINNINGSEQ_INDEX_SQL);
        tx.executeSql('ALTER TABLE ' + constants_1.BY_SEQ_STORE +
            ' ADD COLUMN deleted TINYINT(1) DEFAULT 0', [], function () {
            tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
            tx.executeSql('ALTER TABLE ' + constants_1.DOC_STORE +
                ' ADD COLUMN local TINYINT(1) DEFAULT 0', [], function () {
                tx.executeSql('CREATE INDEX IF NOT EXISTS \'doc-store-local-idx\' ON ' +
                    constants_1.DOC_STORE + ' (local, id)');
                var sql = 'SELECT ' + constants_1.DOC_STORE + '.winningseq AS seq, ' + constants_1.DOC_STORE +
                    '.json AS metadata FROM ' + constants_1.BY_SEQ_STORE + ' JOIN ' + constants_1.DOC_STORE +
                    ' ON ' + constants_1.BY_SEQ_STORE + '.seq = ' + constants_1.DOC_STORE + '.winningseq';
                tx.executeSql(sql, [], function (tx, result) {
                    var deleted = [];
                    var local = [];
                    for (var i = 0; i < result.rows.length; i++) {
                        var item = result.rows.item(i);
                        var seq = item.seq;
                        var metadata = JSON.parse(item.metadata);
                        if ((0, pouchdb_adapter_utils_1.isDeleted)(metadata)) {
                            deleted.push(seq);
                        }
                        if ((0, pouchdb_adapter_utils_1.isLocalId)(metadata.id)) {
                            local.push(metadata.id);
                        }
                    }
                    tx.executeSql('UPDATE ' + constants_1.DOC_STORE + 'SET local = 1 WHERE id IN ' +
                        (0, utils_1.qMarks)(local.length), local, function () {
                        tx.executeSql('UPDATE ' + constants_1.BY_SEQ_STORE +
                            ' SET deleted = 1 WHERE seq IN ' +
                            (0, utils_1.qMarks)(deleted.length), deleted, callback);
                    });
                });
            });
        });
    }
    // in this migration, we make all the local docs unversioned
    function runMigration3(tx, callback) {
        var local = 'CREATE TABLE IF NOT EXISTS ' + constants_1.LOCAL_STORE +
            ' (id UNIQUE, rev, json)';
        tx.executeSql(local, [], function () {
            var sql = 'SELECT ' + constants_1.DOC_STORE + '.id AS id, ' +
                constants_1.BY_SEQ_STORE + '.json AS data ' +
                'FROM ' + constants_1.BY_SEQ_STORE + ' JOIN ' +
                constants_1.DOC_STORE + ' ON ' + constants_1.BY_SEQ_STORE + '.seq = ' +
                constants_1.DOC_STORE + '.winningseq WHERE local = 1';
            tx.executeSql(sql, [], function (tx, res) {
                var rows = [];
                for (var i = 0; i < res.rows.length; i++) {
                    rows.push(res.rows.item(i));
                }
                function doNext() {
                    if (!rows.length) {
                        return callback(tx);
                    }
                    var row = rows.shift();
                    var rev = JSON.parse(row.data)._rev;
                    tx.executeSql('INSERT INTO ' + constants_1.LOCAL_STORE +
                        ' (id, rev, json) VALUES (?,?,?)', [row.id, rev, row.data], function (tx) {
                        tx.executeSql('DELETE FROM ' + constants_1.DOC_STORE + ' WHERE id=?', [row.id], function (tx) {
                            tx.executeSql('DELETE FROM ' + constants_1.BY_SEQ_STORE + ' WHERE seq=?', [row.seq], function () {
                                doNext();
                            });
                        });
                    });
                }
                doNext();
            });
        });
    }
    // in this migration, we remove doc_id_rev and just use rev
    function runMigration4(tx, callback) {
        function updateRows(rows) {
            function doNext() {
                if (!rows.length) {
                    return callback(tx);
                }
                var row = rows.shift();
                var doc_id_rev = (0, parseHex_1.default)(row.hex, encoding);
                var idx = doc_id_rev.lastIndexOf('::');
                var doc_id = doc_id_rev.substring(0, idx);
                var rev = doc_id_rev.substring(idx + 2);
                var sql = 'UPDATE ' + constants_1.BY_SEQ_STORE +
                    ' SET doc_id=?, rev=? WHERE doc_id_rev=?';
                tx.executeSql(sql, [doc_id, rev, doc_id_rev], function () {
                    doNext();
                });
            }
            doNext();
        }
        var sql = 'ALTER TABLE ' + constants_1.BY_SEQ_STORE + ' ADD COLUMN doc_id';
        tx.executeSql(sql, [], function (tx) {
            var sql = 'ALTER TABLE ' + constants_1.BY_SEQ_STORE + ' ADD COLUMN rev';
            tx.executeSql(sql, [], function (tx) {
                tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL, [], function (tx) {
                    var sql = 'SELECT hex(doc_id_rev) as hex FROM ' + constants_1.BY_SEQ_STORE;
                    tx.executeSql(sql, [], function (tx, res) {
                        var rows = [];
                        for (var i = 0; i < res.rows.length; i++) {
                            rows.push(res.rows.item(i));
                        }
                        updateRows(rows);
                    });
                });
            });
        });
    }
    // in this migration, we add the attach_and_seq table
    // for issue #2818
    function runMigration5(tx, callback) {
        function migrateAttsAndSeqs(tx) {
            // need to actually populate the table. this is the expensive part,
            // so as an optimization, check first that this database even
            // contains attachments
            var sql = 'SELECT COUNT(*) AS cnt FROM ' + constants_1.ATTACH_STORE;
            tx.executeSql(sql, [], function (tx, res) {
                var count = res.rows.item(0).cnt;
                if (!count) {
                    return callback(tx);
                }
                var offset = 0;
                var pageSize = 10;
                function nextPage() {
                    var sql = (0, utils_1.select)(SELECT_DOCS + ', ' + constants_1.DOC_STORE + '.id AS id', [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], DOC_STORE_AND_BY_SEQ_JOINER, null, constants_1.DOC_STORE + '.id ');
                    sql += ' LIMIT ' + pageSize + ' OFFSET ' + offset;
                    offset += pageSize;
                    tx.executeSql(sql, [], function (tx, res) {
                        if (!res.rows.length) {
                            return callback(tx);
                        }
                        var digestSeqs = {};
                        function addDigestSeq(digest, seq) {
                            // uniq digest/seq pairs, just in case there are dups
                            var seqs = digestSeqs[digest] = (digestSeqs[digest] || []);
                            if (seqs.indexOf(seq) === -1) {
                                seqs.push(seq);
                            }
                        }
                        for (var i = 0; i < res.rows.length; i++) {
                            var row = res.rows.item(i);
                            var doc = (0, utils_1.unstringifyDoc)(row.data, row.id, row.rev);
                            var atts = Object.keys(doc._attachments || {});
                            for (var j = 0; j < atts.length; j++) {
                                var att = doc._attachments[atts[j]];
                                addDigestSeq(att.digest, row.seq);
                            }
                        }
                        var digestSeqPairs = [];
                        Object.keys(digestSeqs).forEach(function (digest) {
                            var seqs = digestSeqs[digest];
                            seqs.forEach(function (seq) {
                                digestSeqPairs.push([digest, seq]);
                            });
                        });
                        if (!digestSeqPairs.length) {
                            return nextPage();
                        }
                        var numDone = 0;
                        digestSeqPairs.forEach(function (pair) {
                            var sql = 'INSERT INTO ' + constants_1.ATTACH_AND_SEQ_STORE +
                                ' (digest, seq) VALUES (?,?)';
                            tx.executeSql(sql, pair, function () {
                                if (++numDone === digestSeqPairs.length) {
                                    nextPage();
                                }
                            });
                        });
                    });
                }
                nextPage();
            });
        }
        var attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
            constants_1.ATTACH_AND_SEQ_STORE + ' (digest, seq INTEGER)';
        tx.executeSql(attachAndRev, [], function (tx) {
            tx.executeSql(ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL, [], function (tx) {
                tx.executeSql(ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL, [], migrateAttsAndSeqs);
            });
        });
    }
    // in this migration, we use escapeBlob() and unescapeBlob()
    // instead of reading out the binary as HEX, which is slow
    function runMigration6(tx, callback) {
        var sql = 'ALTER TABLE ' + constants_1.ATTACH_STORE +
            ' ADD COLUMN escaped TINYINT(1) DEFAULT 0';
        tx.executeSql(sql, [], callback);
    }
    // issue #3136, in this migration we need a "latest seq" as well
    // as the "winning seq" in the doc store
    function runMigration7(tx, callback) {
        var sql = 'ALTER TABLE ' + constants_1.DOC_STORE +
            ' ADD COLUMN max_seq INTEGER';
        tx.executeSql(sql, [], function (tx) {
            var sql = 'UPDATE ' + constants_1.DOC_STORE + ' SET max_seq=(SELECT MAX(seq) FROM ' +
                constants_1.BY_SEQ_STORE + ' WHERE doc_id=id)';
            tx.executeSql(sql, [], function (tx) {
                // add unique index after filling, else we'll get a constraint
                // error when we do the ALTER TABLE
                var sql = 'CREATE UNIQUE INDEX IF NOT EXISTS \'doc-max-seq-idx\' ON ' +
                    constants_1.DOC_STORE + ' (max_seq)';
                tx.executeSql(sql, [], callback);
            });
        });
    }
    function checkEncoding(tx, cb) {
        // UTF-8 on chrome/android, UTF-16 on safari < 7.1
        tx.executeSql('SELECT HEX("a") AS hex', [], function (tx, res) {
            var hex = res.rows.item(0).hex;
            encoding = hex.length === 2 ? 'UTF-8' : 'UTF-16';
            cb();
        });
    }
    function onGetInstanceId() {
        while (idRequests.length > 0) {
            var idCallback = idRequests.pop();
            idCallback(null, instanceId);
        }
    }
    function onGetVersion(tx, dbVersion) {
        if (dbVersion === 0) {
            // initial schema
            var meta = 'CREATE TABLE IF NOT EXISTS ' + constants_1.META_STORE +
                ' (dbid, db_version INTEGER)';
            var attach = 'CREATE TABLE IF NOT EXISTS ' + constants_1.ATTACH_STORE +
                ' (digest UNIQUE, escaped TINYINT(1), body BLOB)';
            var attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
                constants_1.ATTACH_AND_SEQ_STORE + ' (digest, seq INTEGER)';
            // TODO: migrate winningseq to INTEGER
            var doc = 'CREATE TABLE IF NOT EXISTS ' + constants_1.DOC_STORE +
                ' (id unique, json, winningseq, max_seq INTEGER UNIQUE)';
            var seq = 'CREATE TABLE IF NOT EXISTS ' + constants_1.BY_SEQ_STORE +
                ' (seq INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
                'json, deleted TINYINT(1), doc_id, rev)';
            var local = 'CREATE TABLE IF NOT EXISTS ' + constants_1.LOCAL_STORE +
                ' (id UNIQUE, rev, json)';
            // creates
            tx.executeSql(attach);
            tx.executeSql(local);
            tx.executeSql(attachAndRev, [], function () {
                tx.executeSql(ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL);
                tx.executeSql(ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL);
            });
            tx.executeSql(doc, [], function () {
                tx.executeSql(DOC_STORE_WINNINGSEQ_INDEX_SQL);
                tx.executeSql(seq, [], function () {
                    tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
                    tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL);
                    tx.executeSql(meta, [], function () {
                        // mark the db version, and new dbid
                        var initSeq = 'INSERT INTO ' + constants_1.META_STORE +
                            ' (db_version, dbid) VALUES (?,?)';
                        instanceId = (0, pouchdb_utils_1.uuid)();
                        var initSeqArgs = [constants_1.ADAPTER_VERSION, instanceId];
                        tx.executeSql(initSeq, initSeqArgs, function () {
                            onGetInstanceId();
                        });
                    });
                });
            });
        }
        else { // version > 0
            var setupDone = function () {
                var migrated = dbVersion < constants_1.ADAPTER_VERSION;
                if (migrated) {
                    // update the db version within this transaction
                    tx.executeSql('UPDATE ' + constants_1.META_STORE + ' SET db_version = ' +
                        constants_1.ADAPTER_VERSION);
                }
                // notify db.id() callers
                var sql = 'SELECT dbid FROM ' + constants_1.META_STORE;
                tx.executeSql(sql, [], function (tx, result) {
                    instanceId = result.rows.item(0).dbid;
                    onGetInstanceId();
                });
            };
            // would love to use promises here, but then websql
            // ends the transaction early
            var tasks = [
                runMigration2,
                runMigration3,
                runMigration4,
                runMigration5,
                runMigration6,
                runMigration7,
                setupDone
            ];
            // run each migration sequentially
            var i = dbVersion;
            var nextMigration = function (tx) {
                tasks[i - 1](tx, nextMigration);
                i++;
            };
            nextMigration(tx);
        }
    }
    function setup() {
        db.transaction(function (tx) {
            // first check the encoding
            checkEncoding(tx, function () {
                // then get the version
                fetchVersion(tx);
            });
        }, (0, utils_1.websqlError)(callback), dbCreated);
    }
    function fetchVersion(tx) {
        var sql = 'SELECT sql FROM sqlite_master WHERE tbl_name = ' + constants_1.META_STORE;
        tx.executeSql(sql, [], function (tx, result) {
            if (!result.rows.length) {
                // database hasn't even been created yet (version 0)
                onGetVersion(tx, 0);
            }
            else if (!/db_version/.test(result.rows.item(0).sql)) {
                // table was created, but without the new db_version column,
                // so add it.
                tx.executeSql('ALTER TABLE ' + constants_1.META_STORE +
                    ' ADD COLUMN db_version INTEGER', [], function () {
                    // before version 2, this column didn't even exist
                    onGetVersion(tx, 1);
                });
            }
            else { // column exists, we can safely get it
                tx.executeSql('SELECT db_version FROM ' + constants_1.META_STORE, [], function (tx, result) {
                    var dbVersion = result.rows.item(0).db_version;
                    onGetVersion(tx, dbVersion);
                });
            }
        });
    }
    setup();
    function getMaxSeq(tx, callback) {
        var sql = 'SELECT MAX(seq) AS seq FROM ' + constants_1.BY_SEQ_STORE;
        tx.executeSql(sql, [], function (tx, res) {
            var updateSeq = res.rows.item(0).seq || 0;
            callback(updateSeq);
        });
    }
    function countDocs(tx, callback) {
        // count the total rows
        var sql = (0, utils_1.select)('COUNT(' + constants_1.DOC_STORE + '.id) AS \'num\'', [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], DOC_STORE_AND_BY_SEQ_JOINER, constants_1.BY_SEQ_STORE + '.deleted=0', undefined);
        tx.executeSql(sql, [], function (tx, result) {
            callback(result.rows.item(0).num);
        });
    }
    api._remote = false;
    api.type = function () {
        return 'websql';
    };
    api._id = (0, pouchdb_utils_1.toPromise)(function (callback) {
        callback(null, instanceId);
    });
    api._info = function (callback) {
        var seq;
        var docCount;
        db.readTransaction(function (tx) {
            getMaxSeq(tx, function (theSeq) {
                seq = theSeq;
            });
            countDocs(tx, function (theDocCount) {
                docCount = theDocCount;
            });
        }, (0, utils_1.websqlError)(callback), function () {
            callback(null, {
                doc_count: docCount,
                update_seq: seq,
                websql_encoding: encoding
            });
        });
    };
    api._bulkDocs = function (req, reqOpts, callback) {
        (0, bulkDocs_1.default)(opts, req, reqOpts, api, db, websqlChanges, callback);
    };
    function latest(tx, id, rev, callback, finish) {
        var sql = (0, utils_1.select)(SELECT_DOCS, [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], DOC_STORE_AND_BY_SEQ_JOINER, constants_1.DOC_STORE + '.id=?', undefined);
        var sqlArgs = [id];
        tx.executeSql(sql, sqlArgs, function (a, results) {
            if (!results.rows.length) {
                var err = (0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_DOC, 'missing');
                return finish(err);
            }
            var item = results.rows.item(0);
            var metadata = (0, pouchdb_json_1.safeJsonParse)(item.metadata);
            callback((0, pouchdb_merge_1.latest)(rev, metadata));
        });
    }
    api._get = function (id, opts, callback) {
        var doc;
        var metadata;
        var tx = opts.ctx;
        if (!tx) {
            return db.readTransaction(function (txn) {
                api._get(id, Object.assign({ ctx: txn }, opts), callback);
            });
        }
        function finish(err) {
            callback(err, { doc: doc, metadata: metadata, ctx: tx });
        }
        var sql;
        var sqlArgs;
        if (!opts.rev) {
            sql = (0, utils_1.select)(SELECT_DOCS, [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], DOC_STORE_AND_BY_SEQ_JOINER, constants_1.DOC_STORE + '.id=?', undefined);
            sqlArgs = [id];
        }
        else if (opts.latest) {
            latest(tx, id, opts.rev, function (latestRev) {
                opts.latest = false;
                opts.rev = latestRev;
                api._get(id, opts, callback);
            }, finish);
            return;
        }
        else {
            sql = (0, utils_1.select)(SELECT_DOCS, [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], constants_1.DOC_STORE + '.id=' + constants_1.BY_SEQ_STORE + '.doc_id', [constants_1.BY_SEQ_STORE + '.doc_id=?', constants_1.BY_SEQ_STORE + '.rev=?'], undefined);
            sqlArgs = [id, opts.rev];
        }
        tx.executeSql(sql, sqlArgs, function (a, results) {
            if (!results.rows.length) {
                var missingErr = (0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_DOC, 'missing');
                return finish(missingErr);
            }
            var item = results.rows.item(0);
            metadata = (0, pouchdb_json_1.safeJsonParse)(item.metadata);
            if (item.deleted && !opts.rev) {
                var deletedErr = (0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_DOC, 'deleted');
                return finish(deletedErr);
            }
            doc = (0, utils_1.unstringifyDoc)(item.data, metadata.id, item.rev);
            finish(undefined);
        });
    };
    api._allDocs = function (opts, callback) {
        var results = [];
        var totalRows;
        var updateSeq;
        var start = 'startkey' in opts ? opts.startkey : false;
        var end = 'endkey' in opts ? opts.endkey : false;
        var key = 'key' in opts ? opts.key : false;
        var keys = 'keys' in opts ? opts.keys : false;
        var descending = 'descending' in opts ? opts.descending : false;
        var limit = 'limit' in opts ? opts.limit : -1;
        var offset = 'skip' in opts ? opts.skip : 0;
        var inclusiveEnd = opts.inclusive_end !== false;
        var sqlArgs = [];
        var criteria = [];
        var keyChunks = [];
        if (keys) {
            var destinctKeys = [];
            keys.forEach(function (key) {
                if (destinctKeys.indexOf(key) === -1) {
                    destinctKeys.push(key);
                }
            });
            for (var index = 0; index < destinctKeys.length; index += 999) {
                var chunk = destinctKeys.slice(index, index + 999);
                if (chunk.length > 0) {
                    keyChunks.push(chunk);
                }
            }
        }
        else if (key !== false) {
            criteria.push(constants_1.DOC_STORE + '.id = ?');
            sqlArgs.push(key);
        }
        else if (start !== false || end !== false) {
            if (start !== false) {
                criteria.push(constants_1.DOC_STORE + '.id ' + (descending ? '<=' : '>=') + ' ?');
                sqlArgs.push(start);
            }
            if (end !== false) {
                var comparator = descending ? '>' : '<';
                if (inclusiveEnd) {
                    comparator += '=';
                }
                criteria.push(constants_1.DOC_STORE + '.id ' + comparator + ' ?');
                sqlArgs.push(end);
            }
            if (key !== false) {
                criteria.push(constants_1.DOC_STORE + '.id = ?');
                sqlArgs.push(key);
            }
        }
        if (!keys) {
            // report deleted if keys are specified
            criteria.push(constants_1.BY_SEQ_STORE + '.deleted = 0');
        }
        db.readTransaction(function (tx) {
            // count the docs in parallel to other operations
            countDocs(tx, function (docCount) {
                totalRows = docCount;
            });
            /* istanbul ignore if */
            if (opts.update_seq) {
                // get max sequence in parallel to other operations
                getMaxSeq(tx, function (theSeq) {
                    updateSeq = theSeq;
                });
            }
            if (limit === 0) {
                return;
            }
            if (keys) {
                var finishedCount = 0;
                var allRows = [];
                keyChunks.forEach(function (keyChunk) {
                    sqlArgs = [];
                    criteria = [];
                    var bindingStr = "";
                    keyChunk.forEach(function () {
                        bindingStr += '?,';
                    });
                    bindingStr = bindingStr.substring(0, bindingStr.length - 1); // keys is never empty
                    criteria.push(constants_1.DOC_STORE + '.id IN (' + bindingStr + ')');
                    sqlArgs = sqlArgs.concat(keyChunk);
                    var sql = (0, utils_1.select)(SELECT_DOCS, [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], DOC_STORE_AND_BY_SEQ_JOINER, criteria, constants_1.DOC_STORE + '.id ' + (descending ? 'DESC' : 'ASC'));
                    sql += ' LIMIT ' + limit + ' OFFSET ' + offset;
                    tx.executeSql(sql, sqlArgs, function (tx, result) {
                        finishedCount++;
                        for (var index = 0; index < result.rows.length; index++) {
                            allRows.push(result.rows.item(index));
                        }
                        if (finishedCount === keyChunks.length) {
                            processResult(allRows);
                        }
                    });
                });
            }
            else {
                // do a single query to fetch the documents
                var sql = (0, utils_1.select)(SELECT_DOCS, [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE], DOC_STORE_AND_BY_SEQ_JOINER, criteria, constants_1.DOC_STORE + '.id ' + (descending ? 'DESC' : 'ASC'));
                sql += ' LIMIT ' + limit + ' OFFSET ' + offset;
                tx.executeSql(sql, sqlArgs, function (tx, result) {
                    var rows = [];
                    for (var index = 0; index < result.rows.length; index++) {
                        rows.push(result.rows.item(index));
                    }
                    processResult(rows);
                });
            }
            function processResult(rows) {
                for (var i = 0, l = rows.length; i < l; i++) {
                    var item = rows[i];
                    var metadata = (0, pouchdb_json_1.safeJsonParse)(item.metadata);
                    var id = metadata.id;
                    var data = (0, utils_1.unstringifyDoc)(item.data, id, item.rev);
                    var winningRev = data._rev;
                    var doc = {
                        id: id,
                        key: id,
                        value: { rev: winningRev }
                    };
                    if (opts.include_docs) {
                        doc.doc = data;
                        doc.doc._rev = winningRev;
                        if (opts.conflicts) {
                            var conflicts = (0, pouchdb_merge_1.collectConflicts)(metadata);
                            if (conflicts.length) {
                                doc.doc._conflicts = conflicts;
                            }
                        }
                        fetchAttachmentsIfNecessary(doc.doc, opts, api, tx, undefined);
                    }
                    if (item.deleted) {
                        if (keys) {
                            doc.value.deleted = true;
                            doc.doc = null;
                        }
                        else {
                            // propably should not happen
                            continue;
                        }
                    }
                    if (!keys) {
                        results.push(doc);
                    }
                    else {
                        var index = keys.indexOf(id, index);
                        do {
                            results[index] = doc;
                            index = keys.indexOf(id, index + 1);
                        } while (index > -1 && index < keys.length);
                    }
                }
                if (keys) {
                    keys.forEach(function (key, index) {
                        if (!results[index]) {
                            results[index] = { key: key, error: 'not_found' };
                        }
                    });
                }
            }
        }, (0, utils_1.websqlError)(callback), function () {
            var returnVal = {
                total_rows: totalRows,
                offset: opts.skip,
                rows: results
            };
            /* istanbul ignore if */
            if (opts.update_seq) {
                returnVal.update_seq = updateSeq;
            }
            callback(null, returnVal);
        });
    };
    api._changes = function (opts) {
        opts = (0, pouchdb_utils_1.clone)(opts);
        if (opts.continuous) {
            var id = api._name + ':' + (0, pouchdb_utils_1.uuid)();
            websqlChanges.addListener(api._name, id, api, opts);
            websqlChanges.notify(api._name);
            return {
                cancel: function () {
                    websqlChanges.removeListener(api._name, id);
                }
            };
        }
        var descending = opts.descending;
        // Ignore the `since` parameter when `descending` is true
        opts.since = opts.since && !descending ? opts.since : 0;
        var limit = 'limit' in opts ? opts.limit : -1;
        if (limit === 0) {
            limit = 1; // per CouchDB _changes spec
        }
        var results = [];
        var numResults = 0;
        function fetchChanges() {
            var selectStmt = constants_1.DOC_STORE + '.json AS metadata, ' +
                constants_1.DOC_STORE + '.max_seq AS maxSeq, ' +
                constants_1.BY_SEQ_STORE + '.json AS winningDoc, ' +
                constants_1.BY_SEQ_STORE + '.rev AS winningRev ';
            var from = constants_1.DOC_STORE + ' JOIN ' + constants_1.BY_SEQ_STORE;
            var joiner = constants_1.DOC_STORE + '.id=' + constants_1.BY_SEQ_STORE + '.doc_id' +
                ' AND ' + constants_1.DOC_STORE + '.winningseq=' + constants_1.BY_SEQ_STORE + '.seq';
            var criteria = ['maxSeq > ?'];
            var sqlArgs = [opts.since];
            if (opts.doc_ids) {
                criteria.push(constants_1.DOC_STORE + '.id IN ' + (0, utils_1.qMarks)(opts.doc_ids.length));
                sqlArgs = sqlArgs.concat(opts.doc_ids);
            }
            var orderBy = 'maxSeq ' + (descending ? 'DESC' : 'ASC');
            var sql = (0, utils_1.select)(selectStmt, from, joiner, criteria, orderBy);
            var filter = (0, pouchdb_utils_1.filterChange)(opts);
            if (!opts.view && !opts.filter) {
                // we can just limit in the query
                sql += ' LIMIT ' + limit;
            }
            var lastSeq = opts.since || 0;
            db.readTransaction(function (tx) {
                tx.executeSql(sql, sqlArgs, function (tx, result) {
                    function reportChange(change) {
                        return function () {
                            opts.onChange(change);
                        };
                    }
                    for (var i = 0, l = result.rows.length; i < l; i++) {
                        var item = result.rows.item(i);
                        var metadata = (0, pouchdb_json_1.safeJsonParse)(item.metadata);
                        lastSeq = item.maxSeq;
                        var doc = (0, utils_1.unstringifyDoc)(item.winningDoc, metadata.id, item.winningRev);
                        var change = opts.processChange(doc, metadata, opts);
                        change.seq = item.maxSeq;
                        var filtered = filter(change);
                        if (typeof filtered === 'object') {
                            return opts.complete(filtered);
                        }
                        if (filtered) {
                            numResults++;
                            if (opts.return_docs) {
                                results.push(change);
                            }
                            // process the attachment immediately
                            // for the benefit of live listeners
                            if (opts.attachments && opts.include_docs) {
                                fetchAttachmentsIfNecessary(doc, opts, api, tx, reportChange(change));
                            }
                            else {
                                reportChange(change)();
                            }
                        }
                        if (numResults === limit) {
                            break;
                        }
                    }
                });
            }, (0, utils_1.websqlError)(opts.complete), function () {
                if (!opts.continuous) {
                    opts.complete(null, {
                        results: results,
                        last_seq: lastSeq
                    });
                }
            });
        }
        fetchChanges();
    };
    api._close = function (callback) {
        //WebSQL databases do not need to be closed
        callback();
    };
    api._getAttachment = function (docId, attachId, attachment, opts, callback) {
        var res;
        var tx = opts.ctx;
        var digest = attachment.digest;
        var type = attachment.content_type;
        var sql = 'SELECT escaped, ' +
            'CASE WHEN escaped = 1 THEN body ELSE HEX(body) END AS body FROM ' +
            constants_1.ATTACH_STORE + ' WHERE digest=?';
        tx.executeSql(sql, [digest], function (tx, result) {
            // websql has a bug where \u0000 causes early truncation in strings
            // and blobs. to work around this, we used to use the hex() function,
            // but that's not performant. after migration 6, we remove \u0000
            // and add it back in afterwards
            var item = result.rows.item(0);
            var data = item.escaped ? (0, utils_1.unescapeBlob)(item.body) :
                (0, parseHex_1.default)(item.body, encoding);
            if (opts.binary) {
                res = (0, pouchdb_binary_utils_1.binaryStringToBlobOrBuffer)(data, type);
            }
            else {
                res = (0, pouchdb_binary_utils_1.btoa)(data);
            }
            callback(null, res);
        });
    };
    api._getRevisionTree = function (docId, callback) {
        db.readTransaction(function (tx) {
            var sql = 'SELECT json AS metadata FROM ' + constants_1.DOC_STORE + ' WHERE id = ?';
            tx.executeSql(sql, [docId], function (tx, result) {
                if (!result.rows.length) {
                    callback((0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_DOC));
                }
                else {
                    var data = (0, pouchdb_json_1.safeJsonParse)(result.rows.item(0).metadata);
                    callback(null, data.rev_tree);
                }
            });
        });
    };
    api._doCompaction = function (docId, revs, callback) {
        if (!revs.length) {
            return callback();
        }
        db.transaction(function (tx) {
            // update doc store
            var sql = 'SELECT json AS metadata FROM ' + constants_1.DOC_STORE + ' WHERE id = ?';
            tx.executeSql(sql, [docId], function (tx, result) {
                var metadata = (0, pouchdb_json_1.safeJsonParse)(result.rows.item(0).metadata);
                (0, pouchdb_merge_1.traverseRevTree)(metadata.rev_tree, function (isLeaf, pos, revHash, ctx, opts) {
                    var rev = pos + '-' + revHash;
                    if (revs.indexOf(rev) !== -1) {
                        opts.status = 'missing';
                    }
                });
                var sql = 'UPDATE ' + constants_1.DOC_STORE + ' SET json = ? WHERE id = ?';
                tx.executeSql(sql, [(0, pouchdb_json_1.safeJsonStringify)(metadata), docId]);
            });
            (0, utils_1.compactRevs)(revs, docId, tx);
        }, (0, utils_1.websqlError)(callback), function () {
            callback();
        });
    };
    api._getLocal = function (id, callback) {
        db.readTransaction(function (tx) {
            var sql = 'SELECT json, rev FROM ' + constants_1.LOCAL_STORE + ' WHERE id=?';
            tx.executeSql(sql, [id], function (tx, res) {
                if (res.rows.length) {
                    var item = res.rows.item(0);
                    var doc = (0, utils_1.unstringifyDoc)(item.json, id, item.rev);
                    callback(null, doc);
                }
                else {
                    callback((0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_DOC));
                }
            });
        });
    };
    api._putLocal = function (doc, opts, callback) {
        if (typeof opts === 'function') {
            callback = opts;
            opts = {};
        }
        delete doc._revisions; // ignore this, trust the rev
        var oldRev = doc._rev;
        var id = doc._id;
        var newRev;
        if (!oldRev) {
            newRev = doc._rev = '0-1';
        }
        else {
            newRev = doc._rev = '0-' + (parseInt(oldRev.split('-')[1], 10) + 1);
        }
        var json = (0, utils_1.stringifyDoc)(doc);
        var ret;
        function putLocal(tx) {
            var sql;
            var values;
            if (oldRev) {
                sql = 'UPDATE ' + constants_1.LOCAL_STORE + ' SET rev=?, json=? ' +
                    'WHERE id=? AND rev=?';
                values = [newRev, json, id, oldRev];
            }
            else {
                sql = 'INSERT INTO ' + constants_1.LOCAL_STORE + ' (id, rev, json) VALUES (?,?,?)';
                values = [id, newRev, json];
            }
            tx.executeSql(sql, values, function (tx, res) {
                if (res.rowsAffected) {
                    ret = { ok: true, id: id, rev: newRev };
                    if (opts.ctx) { // return immediately
                        callback(null, ret);
                    }
                }
                else {
                    callback((0, pouchdb_errors_1.createError)(pouchdb_errors_1.REV_CONFLICT));
                }
            }, function () {
                callback((0, pouchdb_errors_1.createError)(pouchdb_errors_1.REV_CONFLICT));
                return false; // ack that we handled the error
            });
        }
        if (opts.ctx) {
            putLocal(opts.ctx);
        }
        else {
            db.transaction(putLocal, (0, utils_1.websqlError)(callback), function () {
                if (ret) {
                    callback(null, ret);
                }
            });
        }
    };
    api._removeLocal = function (doc, opts, callback) {
        if (typeof opts === 'function') {
            callback = opts;
            opts = {};
        }
        var ret;
        function removeLocal(tx) {
            var sql = 'DELETE FROM ' + constants_1.LOCAL_STORE + ' WHERE id=? AND rev=?';
            var params = [doc._id, doc._rev];
            tx.executeSql(sql, params, function (tx, res) {
                if (!res.rowsAffected) {
                    return callback((0, pouchdb_errors_1.createError)(pouchdb_errors_1.MISSING_DOC));
                }
                ret = { ok: true, id: doc._id, rev: '0-0' };
                if (opts.ctx) { // return immediately
                    callback(null, ret);
                }
            });
        }
        if (opts.ctx) {
            removeLocal(opts.ctx);
        }
        else {
            db.transaction(removeLocal, (0, utils_1.websqlError)(callback), function () {
                if (ret) {
                    callback(null, ret);
                }
            });
        }
    };
    api._destroy = function (opts, callback) {
        websqlChanges.removeAllListeners(api._name);
        db.transaction(function (tx) {
            var stores = [constants_1.DOC_STORE, constants_1.BY_SEQ_STORE, constants_1.ATTACH_STORE, constants_1.META_STORE,
                constants_1.LOCAL_STORE, constants_1.ATTACH_AND_SEQ_STORE];
            stores.forEach(function (store) {
                tx.executeSql('DROP TABLE IF EXISTS ' + store, []);
            });
        }, (0, utils_1.websqlError)(callback), function () {
            if ((0, pouchdb_utils_1.hasLocalStorage)()) {
                // @ts-ignore
                delete window.localStorage['_pouch__websqldb_' + api._name];
                // @ts-ignore
                delete window.localStorage[api._name];
            }
            callback(null, { 'ok': true });
        });
    };
}
exports.WebSqlPouch = WebSqlPouch;
