import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { requireExecuteRowSchema } from "../rules/require-execute-row-schema.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("require-execute-row-schema", requireExecuteRowSchema, {
  valid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        await db.execute(sql\`DELETE FROM jobs\`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const { rowCount } = await db.execute(sql\`DELETE FROM jobs\`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const { rowCount: deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const count = (await db.execute(sql\`DELETE FROM jobs\`)).rowCount;
      `,
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        await tx.execute(drizzle.sql\`SELECT pg_advisory_xact_lock(1)\`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        await db.execute(lockQuery());
        function lockQuery() {
          return sql\`SELECT pg_advisory_xact_lock(1)\`;
        }
      `,
    },
    {
      code: `
        const result = await client.execute<Row>("SELECT 1");
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        function render(sql: (strings: TemplateStringsArray) => string) {
          return client.execute<Row>(sql\`SELECT 1\`);
        }
      `,
    },
    {
      code: `
        function query() {
          return "SELECT 1";
        }
        const result = await client.execute<Row>(query());
      `,
    },
    {
      code: `
        async function run(client: Client, query: string) {
          return await client.execute<Row>(query);
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        const result = await db.execute<Row>(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const result = await db.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const result = await db.execute(sql\`SELECT 1 AS value\`);
        consume(result.rows);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const { rows } = await db.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const { rowCount, rows } = await db.execute(
          sql\`DELETE FROM jobs RETURNING id\`,
        );
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const query = sql\`SELECT 1 AS value\`;
        return db.execute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const query = () => sql\`SELECT 1 AS value\`;
        const result = await database.execute(query());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        function query() {
          return sql\`SELECT 1 AS value\`;
        }
        const result = await database.transaction(async (transaction) => {
          return await transaction.execute(query());
        });
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import type { SQLWrapper } from "drizzle-orm";
        async function unsafe(executor: Executor, query: SQLWrapper) {
          const result = await executor.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import type { SQLWrapper as DrizzleQuery } from "drizzle-orm";
        type Query = DrizzleQuery;
        async function unsafe(db: Database, query: Query) {
          const result = await db.execute<Row>(query);
        }
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `
        import { sql, type SQL } from "drizzle-orm";
        function query(): SQL {
          if (condition) {
            return sql\`SELECT 1 AS value\`;
          }
          return sql\`SELECT 2 AS value\`;
        }
        const rows = (await db.execute(query())).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import type { SQLWrapper } from "drizzle-orm";
        const result = await db.execute(query as unknown as SQLWrapper);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import type * as drizzle from "drizzle-orm";
        async function unsafe(db: Database, query: drizzle.SQLWrapper) {
          return await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql as drizzleSql } from "drizzle-orm";
        const rows = (await tx.execute(drizzleSql.raw("SELECT 1"))).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const query = condition
          ? sql\`SELECT 1 AS value\`
          : sql\`SELECT 2 AS value\`;
        const result = await tx.execute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const query = sql\`SELECT 1\`.append(sql\` AS value\`);
        const rows = (await tx.execute(query)).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import * as drizzle from "drizzle-orm";
        const rows = (
          await tx.execute(drizzle.sql\`SELECT 1 AS value\`)
        ).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        consume(await db.execute(sql\`SELECT 1\`));
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const result = (await db.execute(sql\`SELECT 1\`)) as QueryResult<Row>;
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const row = (await db.execute(sql\`SELECT 1 AS value\`)).rows[0] as Row;
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const rows = (await db.execute(sql\`SELECT 1 AS value\`)).rows as Row[];
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const rowCount = (
          (await db.execute(sql\`DELETE FROM jobs\`)) as QueryResult
        ).rowCount;
      `,
      errors: [{ messageId: "assertedResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        await db.execute<Row>(sql\`DELETE FROM jobs\`);
      `,
      errors: [{ messageId: "rowTypeArgument" }],
    },
    {
      code: `
        const result = await db.execute(sql\`SELECT 1\`);
        import { sql } from "drizzle-orm";
      `,
      errors: [{ messageId: "rawResult" }],
    },
  ],
});
