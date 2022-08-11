const {defaults} = require('jest-config');
module.exports = {
    globals: {
        "ts-jest": {
            tsConfig: "tsconfig.json"
        }
    },
    moduleFileExtensions: [...defaults.moduleFileExtensions, 'ts', 'tsx'],
    transform: {
        // "^.+\\.jsx?$": require.resolve("babel-jest"),
        // "^.+\\.(ts|tsx)$": "ts-jest"
        "^.+\\.[t|j]sx?$": "babel-jest"
    },
    transformIgnorePatterns: [
        '/node_modules/(?!uhc-common-utils-typescript)'
    ],
    testMatch: [
        "**/test/**/*.test.(ts|js)"
    ],
    testEnvironment: "node"
};
