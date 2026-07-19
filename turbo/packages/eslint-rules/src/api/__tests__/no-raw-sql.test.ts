import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noRawSql } from "../rules/no-raw-sql.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-raw-sql", noRawSql, {
  valid: [
    {
      code: `
        import { eq } from "drizzle-orm";
        const predicate = eq(events.id, "id");
      `,
    },
    {
      code: `
        import type { SQL } from "drizzle-orm";
        export function passThrough(fragment: SQL): SQL {
          return fragment;
        }
      `,
    },
    {
      code: `
        import { type sql } from "drizzle-orm";
        export type Tag = typeof sql;
      `,
    },
    {
      code: `
        import { sql } from "other-library";
        const value = sql\`SELECT 1\`;
      `,
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        const predicate = drizzle.eq(events.id, "id");
      `,
    },
    {
      code: "const value = sql`SELECT 1`;",
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        function scoped(sql: (parts: TemplateStringsArray) => string) {
          return sql\`SELECT 1\`;
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<number>\`count(*)::int\`;
      `,
      errors: [{ messageId: "rawSql" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql\`NULL::text\`.as("name");
      `,
      errors: [{ messageId: "rawSql" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const fragment = sql.raw("ORDER BY created_at");
      `,
      errors: [{ messageId: "rawSql" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const fragment = sql.join([], sql\`, \`);
      `,
      errors: [{ messageId: "rawSql" }, { messageId: "rawSql" }],
    },
    {
      code: `
        import { sql as drizzleSql } from "drizzle-orm";
        const value = drizzleSql\`NOW()\`;
      `,
      errors: [{ messageId: "rawSql" }],
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        const value = drizzle.sql\`NOW()\`;
      `,
      errors: [{ messageId: "rawSql" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const tag = sql;
      `,
      errors: [{ messageId: "rawSql" }],
    },
  ],
});
