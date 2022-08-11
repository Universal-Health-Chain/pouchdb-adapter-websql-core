'use strict';


var cachedDatabases = new Map();

// openDatabase passed in through opts (e.g. for node-websql)
function openDatabaseWithOpts(opts: any) {
  return opts.websql(opts.name, opts.version, opts.description, opts.size);
}

function openDBSafely(opts: any): any {
  try {
    return {
      db: openDatabaseWithOpts(opts)
    };
  } catch (err) {
    return {
      error: err
    };
  }
}

export default function openDB(opts: any): any {
  var cachedResult = cachedDatabases.get(opts.name);
  if (!cachedResult) {
    cachedResult = openDBSafely(opts);
    cachedDatabases.set(opts.name, cachedResult);
  }
  return cachedResult;
}