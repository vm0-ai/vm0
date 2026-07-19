import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { requireSqlDateDecoder } from "../rules/require-sql-date-decoder.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("require-sql-date-decoder", requireSqlDateDecoder, {
  valid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<Date>\`MAX(\${events.createdAt})\`.mapWith(events.createdAt);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<Date | null>\`NULL::timestamp\`
          .mapWith(events.createdAt)
          .as("created_at");
      `,
    },
    {
      code: `
        import { sql as drizzleSql } from "drizzle-orm";
        const value = drizzleSql<Date>\`NOW()\`.mapWith(events.createdAt);
      `,
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        const value = drizzle.sql<Date>\`NOW()\`.mapWith(events.createdAt);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<number>\`COUNT(*)\`;
      `,
    },
    {
      code: "const value = sql<Date>`NOW()`;",
    },
  ],
  invalid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<Date>\`MAX(\${events.createdAt})\`;
      `,
      errors: [{ messageId: "missingDecoder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<Date | null>\`NULL::timestamp\`.as("created_at");
      `,
      errors: [{ messageId: "missingDecoder" }],
    },
    {
      code: `
        import { sql as drizzleSql } from "drizzle-orm";
        const value = drizzleSql<(Date | null)>\`NOW()\`;
      `,
      errors: [{ messageId: "missingDecoder" }],
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        const value = drizzle.sql<Date>\`NOW()\`.as("created_at");
      `,
      errors: [{ messageId: "missingDecoder" }],
    },
  ],
});
