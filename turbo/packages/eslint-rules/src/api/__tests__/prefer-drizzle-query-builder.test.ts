import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { preferDrizzleQueryBuilder } from "../rules/prefer-drizzle-query-builder.ts";

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

const rawRowsImport = `
  import { executeRawRows } from "./lib/db-raw-rows";
`;

const schemaPreamble = `
  import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

  const runs = pgTable("runs", {
    id: integer("id").notNull(),
    threadId: integer("thread_id").notNull(),
  });
  const runStates = pgTable("run_states", {
    id: integer("id").notNull(),
    status: text("status").notNull(),
  });
  const callbacks = pgTable("callbacks", {
    id: integer("id").notNull(),
    runId: integer("run_id").notNull(),
    payload: jsonb("payload").notNull(),
  });
  declare const db: never;
  declare const rowSchema: never;
  declare const threadId: number;
  declare const excludedRunId: number;
`;

const directQuery = `
  sql\`
    SELECT \${runs.id} AS "id"
    FROM \${runs}
    INNER JOIN \${runStates} ON \${eq(runStates.id, runs.id)}
    WHERE \${eq(runs.threadId, threadId)}
      AND \${runStates.status} IN ('queued', 'pending', 'running')
      AND (
        NOT EXISTS (
          SELECT 1 FROM \${callbacks}
          WHERE \${eq(callbacks.runId, runs.id)}
            AND \${callbacks.payload}->>'queuedMessageId' IS NOT NULL
        )
        OR \${eq(runs.id, excludedRunId)}
      )
    LIMIT 1
  \`
`;

ruleTester.run("prefer-drizzle-query-builder", preferDrizzleQueryBuilder, {
  valid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const users = pgTable("users", { id: integer("id").notNull() });
        sql\`\${users.id}\`;
      `,
    },
    {
      code: `${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        async function executeRawRows(...args: unknown[]) { return args; }
        await executeRawRows(db, ${directQuery}, rowSchema);
      `,
    },
    {
      code: `${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./other/db-raw-rows";
        await executeRawRows(db, ${directQuery}, rowSchema);
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        const query = ${directQuery};
        await executeRawRows(db, query, rowSchema);
      `,
    },
    {
      code: `${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows as decodeRows } from "./lib/db-raw-rows";
        function runLocal(
          decodeRows: (...args: unknown[]) => unknown,
        ) {
          return decodeRows(db, ${directQuery}, rowSchema);
        }
        runLocal(() => undefined);
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        const eq = (...values: unknown[]) => values;
        await executeRawRows(db, ${directQuery}, rowSchema);
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT 1 FROM \${runs} WHERE \${eq(runs.id, 1)} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id}, \${runs.threadId} FROM \${runs} WHERE \${eq(runs.id, 1)} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM runs WHERE \${eq(runs.id, 1)} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} LEFT JOIN \${runStates} ON \${eq(runStates.id, runs.id)} WHERE \${eq(runs.id, 1)} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} INNER JOIN \${runStates} ON \${1} WHERE \${eq(runs.id, 1)} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)} ORDER BY \${runs.id} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)} FOR UPDATE LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)} LIMIT \${1}\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)} LIMIT 2\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)}\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`WITH candidate AS (SELECT 1) SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} LIMIT 1\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, 1)} LIMIT 1\`;
      `,
    },
  ],
  invalid: [
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(db, ${directQuery}, rowSchema);
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${schemaPreamble}
        import { eq, sql as query } from "drizzle-orm";
        import { executeRawRows as decodeRows } from "./lib/db-raw-rows";
        await decodeRows(
          db,
          query\`select \${runs.id} from \${runs} inner join \${runStates} on \${eq(runStates.id, runs.id)} where \${eq(runs.threadId, threadId)} and \${eq(runs.id, excludedRunId)} limit 1;\`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${schemaPreamble}
        import * as drizzle from "drizzle-orm";
        import * as rawRows from "./lib/db-raw-rows";
        await rawRows.executeRawRows(
          db,
          drizzle.sql\`
            SELECT \${runs.id}
            FROM \${runs}
            INNER JOIN \${runStates}
              ON \${drizzle.eq(runStates.id, runs.id)}
            WHERE \${drizzle.eq(runs.threadId, threadId)}
              AND $$ORDER BY ignored$$ = $$ORDER BY ignored$$
              /* GROUP BY ignored /* nested ORDER BY */ */
              AND (SELECT 1 FROM ignored ORDER BY ignored LIMIT 1) = 1
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
  ],
});
