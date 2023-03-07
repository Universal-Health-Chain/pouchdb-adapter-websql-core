![logo](https://avatars.githubusercontent.com/u/57396025?s=200&v=4)

# @universal-health-chain/pouchdb-adapter-websql-core-ts ![semver non-compliant](https://img.shields.io/badge/semver-non--compliant-red.svg)
======

Underlying adapter code for WebSQL and SQLite-based PouchDB adapters.

Forked from the original pouchdb adapter (see https://github.com/craftzdog/pouchdb-adapter-websql-core/tree/master/src), but using Typescript.

### Usage

```bash
npm install --save-exact @universal-health-chain/pouchdb-adapter-websql-core-ts
```

And then import it:
```js
import { WebSqlPouchCore } from '@universal-health-chain/pouchdb-adapter-websql-core-ts';
```

For full API documentation and guides on PouchDB, see [PouchDB.com](http://pouchdb.com/). For details on PouchDB sub-packages, see the [Custom Builds documentation](http://pouchdb.com/custom.html).

### Warning: semver-free zone!

This package is conceptually an internal API used by PouchDB or its plugins. It does not follow semantic versioning (semver), and rather its version is pegged to PouchDB's. Use exact versions when installing, e.g. with `--save-exact`.

### Source

PouchDB and its sub-packages are distributed as a [monorepo](https://github.com/babel/babel/blob/master/doc/design/monorepo.md).

For a full list of packages, see [the GitHub source](https://github.com/pouchdb/pouchdb/tree/master/packages).


