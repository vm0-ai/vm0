import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noSqlRaw } from "../rules/no-sql-raw.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-sql-raw", noSqlRaw, {
  valid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        const id = "user-1";
        sql\`SELECT * FROM users WHERE id = \${id}\`;
      `,
    },
    {
      code: `
        const sql = { raw(value: string) { return value; } };
        sql.raw("SELECT 1");
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm-wrapper";
        sql.raw("SELECT 1");
      `,
    },
    {
      code: `
        import { sql as drizzleSql } from "drizzle-orm";
        function query() {
          const drizzleSql = { raw(value: string) { return value; } };
          return drizzleSql.raw("SELECT 1");
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        sql.raw("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
    {
      code: `
        import { sql as drizzleSql } from "drizzle-orm";
        drizzleSql.raw("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        drizzle.sql.raw("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const sqlAlias = sql;
        sqlAlias.raw("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const raw = sql.raw;
        raw("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        sql["raw"]("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const { raw } = sql;
        raw("SELECT 1");
      `,
      errors: [{ messageId: "sqlRaw" }],
    },
  ],
});
