"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.websqlError = exports.getSize = exports.compactRevs = exports.select = exports.qMarks = exports.unstringifyDoc = exports.stringifyDoc = exports.unescapeBlob = exports.escapeBlob = void 0;
const pouchdb_errors_1 = require("pouchdb-errors");
const pouchdb_utils_1 = require("pouchdb-utils");
const constants_1 = require("./constants");
// escapeBlob and unescapeBlob are workarounds for a websql bug:
// https://code.google.com/p/chromium/issues/detail?id=422690
// https://bugs.webkit.org/show_bug.cgi?id=137637
// The goal is to never actually insert the \u0000 character
// in the database.
function escapeBlob(str) {
    /* eslint-disable no-control-regex */
    return str
        .replace(/\u0002/g, '\u0002\u0002')
        .replace(/\u0001/g, '\u0001\u0002')
        .replace(/\u0000/g, '\u0001\u0001');
    /* eslint-enable no-control-regex */
}
exports.escapeBlob = escapeBlob;
function unescapeBlob(str) {
    /* eslint-disable no-control-regex */
    return str
        .replace(/\u0001\u0001/g, '\u0000')
        .replace(/\u0001\u0002/g, '\u0001')
        .replace(/\u0002\u0002/g, '\u0002');
    /* eslint-enable no-control-regex */
}
exports.unescapeBlob = unescapeBlob;
function stringifyDoc(doc) {
    // don't bother storing the id/rev. it uses lots of space,
    // in persistent map/reduce especially
    delete doc._id;
    delete doc._rev;
    return JSON.stringify(doc);
}
exports.stringifyDoc = stringifyDoc;
function unstringifyDoc(stringifiedDoc, id, rev) {
    let doc = JSON.parse(stringifiedDoc);
    doc._id = id;
    doc._rev = rev;
    return doc;
}
exports.unstringifyDoc = unstringifyDoc;
// question mark groups IN queries, e.g. 3 -> '(?,?,?)'
function qMarks(num) {
    var s = '(';
    while (num--) {
        s += '?';
        if (num) {
            s += ',';
        }
    }
    return s + ')';
}
exports.qMarks = qMarks;
function select(selector, table, joiner, where, orderBy) {
    return 'SELECT ' + selector + ' FROM ' +
        (typeof table === 'string' ? table : table.join(' JOIN ')) +
        (joiner ? (' ON ' + joiner) : '') +
        (where ? (' WHERE ' +
            (typeof where === 'string' ? where : where.join(' AND '))) : '') +
        (orderBy ? (' ORDER BY ' + orderBy) : '');
}
exports.select = select;
function compactRevs(revs, docId, tx) {
    if (!revs.length) {
        return;
    }
    var numDone = 0;
    var seqs = [];
    function checkDone() {
        if (++numDone === revs.length) { // done
            deleteOrphans();
        }
    }
    function deleteOrphans() {
        // find orphaned attachment digests
        if (!seqs.length) {
            return;
        }
        var sql = 'SELECT DISTINCT digest AS digest FROM ' +
            constants_1.ATTACH_AND_SEQ_STORE + ' WHERE seq IN ' + qMarks(seqs.length);
        tx.executeSql(sql, seqs, function (tx, res) {
            var digestsToCheck = [];
            for (var i = 0; i < res.rows.length; i++) {
                digestsToCheck.push(res.rows.item(i).digest);
            }
            if (!digestsToCheck.length) {
                return;
            }
            var sql = 'DELETE FROM ' + constants_1.ATTACH_AND_SEQ_STORE +
                ' WHERE seq IN (' +
                seqs.map(function () { return '?'; }).join(',') +
                ')';
            tx.executeSql(sql, seqs, function (tx) {
                var sql = 'SELECT digest FROM ' + constants_1.ATTACH_AND_SEQ_STORE +
                    ' WHERE digest IN (' +
                    digestsToCheck.map(function () { return '?'; }).join(',') +
                    ')';
                tx.executeSql(sql, digestsToCheck, function (tx, res) {
                    var nonOrphanedDigests = new Set();
                    for (var i = 0; i < res.rows.length; i++) {
                        nonOrphanedDigests.add(res.rows.item(i).digest);
                    }
                    digestsToCheck.forEach(function (digest) {
                        if (nonOrphanedDigests.has(digest)) {
                            return;
                        }
                        tx.executeSql('DELETE FROM ' + constants_1.ATTACH_AND_SEQ_STORE + ' WHERE digest=?', [digest]);
                        tx.executeSql('DELETE FROM ' + constants_1.ATTACH_STORE + ' WHERE digest=?', [digest]);
                    });
                });
            });
        });
    }
    // update by-seq and attach stores in parallel
    revs.forEach(function (rev) {
        var sql = 'SELECT seq FROM ' + constants_1.BY_SEQ_STORE +
            ' WHERE doc_id=? AND rev=?';
        tx.executeSql(sql, [docId, rev], function (tx, res) {
            if (!res.rows.length) { // already deleted
                return checkDone();
            }
            var seq = res.rows.item(0).seq;
            seqs.push(seq);
            tx.executeSql('DELETE FROM ' + constants_1.BY_SEQ_STORE + ' WHERE seq=?', [seq], checkDone);
        });
    });
}
exports.compactRevs = compactRevs;
function websqlError(callback) {
    return function (event) {
        (0, pouchdb_utils_1.guardedConsole)('error', 'WebSQL threw an error', event);
        // event may actually be a SQLError object, so report is as such
        var errorNameMatch = event && event.constructor.toString()
            .match(/function ([^(]+)/);
        var errorName = (errorNameMatch && errorNameMatch[1]) || event.type;
        var errorReason = event.target || event.message;
        callback((0, pouchdb_errors_1.createError)(pouchdb_errors_1.WSQ_ERROR, errorReason, errorName));
    };
}
exports.websqlError = websqlError;
function getSize(opts) {
    if ('size' in opts) {
        // triggers immediate popup in iOS, fixes #2347
        // e.g. 5000001 asks for 5 MB, 10000001 asks for 10 MB,
        return opts.size * 1000000;
    }
    // In iOS, doesn't matter as long as it's <= 5000000.
    // Except that if you request too much, our tests fail
    // because of the native "do you accept?" popup.
    // In Android <=4.3, this value is actually used as an
    // honest-to-god ceiling for data, so we need to
    // set it to a decently high number.
    // @ts-ignore
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    var isAndroid = typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent);
    return isAndroid ? 5000000 : 1; // in PhantomJS, if you use 0 it will crash
}
exports.getSize = getSize;
