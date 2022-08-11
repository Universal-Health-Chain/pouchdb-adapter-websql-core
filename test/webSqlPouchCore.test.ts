import { WebSqlPouch } from '../src/index';

describe("import WebSqlPouch", () => {
    it("success", () => {
      const webSqlPouch = WebSqlPouch;
      expect(webSqlPouch).toBeDefined;
    });
    
});

describe("require WebSqlPouch", () => {
    it("success", () => {
      const webSqlPouch = require('../src/index');
      expect(webSqlPouch).toBeDefined;
    });
    
});