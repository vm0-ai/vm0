import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { requireExecuteRowSchema } from "../rules/require-execute-row-schema.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const dbPackageRoot = fileURLToPath(
  new URL("../../../../db/", import.meta.url),
);
const ruleTester = new RuleTester({
  defaultFilenames: {
    ts: `${dbPackageRoot}rule-test.ts`,
    tsx: `${dbPackageRoot}rule-test.tsx`,
  },
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ["rule-test.ts", "rule-test.tsx"],
      },
      tsconfigRootDir: dbPackageRoot,
    },
  },
});
const untypedRuleTester = new RuleTester();

const drizzlePreamble = `
    type DrizzleDatabase =
      import("drizzle-orm/node-postgres").NodePgDatabase;
    declare const db: DrizzleDatabase;
    declare const database: DrizzleDatabase;
    declare const executor: DrizzleDatabase;
    declare const tx: DrizzleDatabase;
`;

ruleTester.run("require-execute-row-schema", requireExecuteRowSchema, {
  valid: [
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`DELETE FROM jobs\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const holder = { query: sql\`DELETE FROM jobs\` };
        await db.execute(holder.query);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rowCount } = await db.execute(sql\`DELETE FROM jobs\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rowCount: deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { "rowCount": deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { ["rowCount"]: deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const count = (await db.execute(sql\`DELETE FROM jobs\`)).rowCount;
      `,
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        await tx.execute(drizzle.sql\`SELECT pg_advisory_xact_lock(1)\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(lockQuery());
        function lockQuery() {
          return sql\`SELECT pg_advisory_xact_lock(1)\`;
        }
      `,
    },
    {
      code: `${drizzlePreamble}
        import { commandQuery } from "./command-query";
        const { rowCount } = await db.execute(commandQuery());
      `,
    },
    {
      code: `${drizzlePreamble}
        const result = await client.run<Row>("SELECT 1");
      `,
    },
    {
      code: `${drizzlePreamble}
        interface Client {
          execute<TRow>(query: string): Promise<TRow>;
        }
        declare const client: Client;
        const result = await client.execute<Row>("SELECT 1");
      `,
    },
    {
      code: `${drizzlePreamble}
        interface Contract {
          execute: { path: string };
        }
        declare const contract: Contract;
        const route = contract.execute;
        const path = contract.execute.path;
      `,
    },
    {
      code: `${drizzlePreamble}
        interface Client {
          execute<TRow>(query: string): Promise<TRow>;
        }
        declare const client: Client;
        const { execute: run } = client;
        const result = await run<Row>("SELECT 1");
      `,
    },
  ],
  invalid: [
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = await db.execute<Row>(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = await db.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = await db.execute(sql\`SELECT 1 AS value\`);
        consume(result.rows);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rows } = await db.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rowCount, rows } = await db.execute(
          sql\`DELETE FROM jobs RETURNING id\`,
        );
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`SELECT 1 AS value\`;
        return db.execute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = () => sql\`SELECT 1 AS value\`;
        const result = await database.execute(query());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
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
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        async function unsafe(
          executor: DrizzleDatabase,
          query: SQLWrapper,
        ) {
          const result = await executor.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper as DrizzleQuery } from "drizzle-orm";
        type Query = DrizzleQuery;
        async function unsafe(db: DrizzleDatabase, query: Query) {
          const result = await db.execute<Row>(query);
        }
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
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
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        const result = await db.execute(query as unknown as SQLWrapper);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type * as drizzle from "drizzle-orm";
        async function unsafe(
          db: DrizzleDatabase,
          query: drizzle.SQLWrapper,
        ) {
          return await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql as drizzleSql } from "drizzle-orm";
        const rows = (await tx.execute(drizzleSql.raw("SELECT 1"))).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = condition
          ? sql\`SELECT 1 AS value\`
          : sql\`SELECT 2 AS value\`;
        const result = await tx.execute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`SELECT 1\`.append(sql\` AS value\`);
        const rows = (await tx.execute(query)).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        const rows = (
          await tx.execute(drizzle.sql\`SELECT 1 AS value\`)
        ).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        consume(await db.execute(sql\`SELECT 1\`));
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = (await db.execute(sql\`SELECT 1\`)) as QueryResult<Row>;
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const row = (await db.execute(sql\`SELECT 1 AS value\`)).rows[0] as Row;
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const rows = (await db.execute(sql\`SELECT 1 AS value\`)).rows as Row[];
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const rowCount = (
          (await db.execute(sql\`DELETE FROM jobs\`)) as QueryResult
        ).rowCount;
      `,
      errors: [{ messageId: "assertedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.execute<Row>(sql\`DELETE FROM jobs\`);
      `,
      errors: [{ messageId: "rowTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db.execute(sql\`SELECT 1\`);
        import { sql } from "drizzle-orm";
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const holder = { query: sql\`SELECT NOW() AS value\` };
        const result = await db.execute<Row>(holder.query);
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const queries = [sql\`SELECT 1 AS value\`];
        const result = await db.execute(queries[0]);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQLWrapper } from "drizzle-orm";
        const holder = {
          query(): SQLWrapper {
            return sql\`SELECT 1 AS value\`;
          },
        };
        return await db.execute(holder.query());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { importedQuery } from "./query";
        const result = await db.execute(importedQuery());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        interface Query extends SQLWrapper {}
        async function unsafe(db: DrizzleDatabase, query: Query) {
          return await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        type Query = Readonly<SQLWrapper>;
        async function unsafe(db: DrizzleDatabase, query: Query) {
          const result = await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db["execute"](query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db.ex\\u0065cute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db["e\\x78ecute"](query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const execute = db.execute.bind(db);
      `,
      errors: [{ messageId: "executeReference" }],
    },
    {
      code: `${drizzlePreamble}
        const { execute: run } = db;
      `,
      errors: [{ messageId: "executeReference" }],
    },
    {
      code: `${drizzlePreamble}
        const { ["e\\x78ecute"]: run } = db;
      `,
      errors: [{ messageId: "executeReference" }],
    },
  ],
});

untypedRuleTester.run(
  "require-execute-row-schema without parser services",
  requireExecuteRowSchema,
  {
    valid: ["const value = 1;"],
    invalid: [],
  },
);
