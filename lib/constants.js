"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATTACH_AND_SEQ_STORE = exports.META_STORE = exports.LOCAL_STORE = exports.ATTACH_STORE = exports.BY_SEQ_STORE = exports.DOC_STORE = exports.ADAPTER_VERSION = void 0;
function quote(str) {
    return "'" + str + "'";
}
var ADAPTER_VERSION = 7; // used to manage migrations
exports.ADAPTER_VERSION = ADAPTER_VERSION;
// The object stores created for each database
// DOC_STORE stores the document meta data, its revision history and state
var DOC_STORE = quote('document-store');
exports.DOC_STORE = DOC_STORE;
// BY_SEQ_STORE stores a particular version of a document, keyed by its
// sequence id
var BY_SEQ_STORE = quote('by-sequence');
exports.BY_SEQ_STORE = BY_SEQ_STORE;
// Where we store attachments
var ATTACH_STORE = quote('attach-store');
exports.ATTACH_STORE = ATTACH_STORE;
var LOCAL_STORE = quote('local-store');
exports.LOCAL_STORE = LOCAL_STORE;
var META_STORE = quote('metadata-store');
exports.META_STORE = META_STORE;
// where we store many-to-many relations between attachment
// digests and seqs
var ATTACH_AND_SEQ_STORE = quote('attach-seq-store');
exports.ATTACH_AND_SEQ_STORE = ATTACH_AND_SEQ_STORE;
