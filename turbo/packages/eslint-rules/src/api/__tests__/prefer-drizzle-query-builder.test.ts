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

const structuredSelectionPreamble = `
  import { integer, pgTable, text } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
  });
  const messages = pgTable("messages", {
    id: integer("id").notNull(),
    userId: integer("user_id").notNull(),
  });
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      users: typeof users;
      messages: typeof messages;
    }>;
  declare const db: DrizzleDatabase;
`;

const scalarQuery = `
  sql\`(
    SELECT "message"."id"
    FROM "messages" AS "message"
    WHERE "message"."user_id" = "users"."id"
    LIMIT 1
  )\`
`;

const mappedScalarQuery = `${scalarQuery}.mapWith(messages.id)`;

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
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const query = ${mappedScalarQuery};
        void query;
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        db.select({
          value: sql\`coalesce((
            SELECT "message"."id"
            FROM "messages" AS "message"
            WHERE "message"."user_id" = \${users.id}
            LIMIT 1
          ), 0)\`.mapWith(messages.id),
        });
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        db.select({ value: sql\`(SELECT 1 WHERE true LIMIT 1)\` });
        db.select({ value: sql\`(SELECT 1 FROM messages LIMIT 1)\` });
        db.select({ value: sql\`(SELECT 1 FROM messages WHERE true)\` });
        db.select({
          value: sql\`(SELECT 1 FROM messages WHERE true LIMIT \${1})\`,
        });
        db.select({
          value: sql\`(
            SELECT "message"."id"
            FROM "messages" AS "message"
            WHERE "message"."user_id" = \${users.id}
            ORDER BY "message"."id"
            LIMIT 1
          )\`.mapWith(messages.id),
        });
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        db.select({
          value: users.id,
        }).from(users).where(${scalarQuery});
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        const builder = {
          select(fields: unknown) {
            return fields;
          },
        };
        builder.select({ value: ${scalarQuery} });
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        let fields = { value: ${mappedScalarQuery} };
        db.select(fields);
        fields = { value: sql\`1\`.mapWith(messages.id) };
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        declare const chooseFirst: boolean;
        function fields() {
          if (chooseFirst) {
            return { value: ${mappedScalarQuery} };
          }
          return { value: sql\`1\`.mapWith(messages.id) };
        }
        db.select(fields());
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        function value() {
          return ${mappedScalarQuery};
        }
        db.select({ value: value() });
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        db.insert(users).select(${scalarQuery});
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
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        db.select({ value: ${scalarQuery} }).from(users);
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql as query } from "drizzle-orm";
        db.select({
          value: query\`(
            SELECT "message"."id"
            FROM "messages" AS "message"
            WHERE "message"."user_id" = \${users.id}
            LIMIT 1
          )\`.mapWith(messages.id).as("value"),
        });
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import * as drizzle from "drizzle-orm";
        db.select({
          nested: {
            value: drizzle.sql\`(
              SELECT "message"."id"
              FROM "messages" AS "message"
              WHERE "message"."user_id" = \${users.id}
              LIMIT 1
            )\`.mapWith(messages.id),
          },
        });
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const messageColumns = {
          lastMessageId: ${mappedScalarQuery},
        } as const;
        function selectedMessageColumns(database: DrizzleDatabase) {
          return {
            name: users.name,
            ...messageColumns,
          } as const;
        }
        db.select(selectedMessageColumns(db)).from(users);
        db.select(selectedMessageColumns(db)).from(users);
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const fields = {
          value: ${mappedScalarQuery},
        } as const;
        db.select(fields);
        db.select({ ...fields });
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        db.selectDistinct({ value: ${mappedScalarQuery} });
        db.selectDistinctOn([users.id], { value: ${mappedScalarQuery} });
        db.update(users)
          .set({ name: "updated" })
          .returning({ value: ${mappedScalarQuery} });
      `,
      errors: [
        { messageId: "structuredScalarQuery" },
        { messageId: "structuredScalarQuery" },
        { messageId: "structuredScalarQuery" },
      ],
    },
  ],
});
