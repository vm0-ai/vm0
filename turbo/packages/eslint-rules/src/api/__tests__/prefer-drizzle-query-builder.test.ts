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
  declare const pageLimit: number;
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

const deletePreamble = `
  import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";

  const cleanupRows = pgTable("cleanup_rows", {
    id: integer("id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  });
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      cleanupRows: typeof cleanupRows;
    }>;
  declare const db: DrizzleDatabase;
  declare const cutoff: Date;
`;

const unnestUpdatePreamble = `
  import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

  const allowanceWindows = pgTable("allowance_windows", {
    id: text("id").primaryKey(),
    consumedUnits: integer("consumed_units").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  });
  const usageEvents = pgTable("usage_events", {
    id: text("id").primaryKey(),
    creditsCharged: integer("credits_charged"),
    status: text("status").notNull(),
    processedAt: timestamp("processed_at"),
    billingError: text("billing_error"),
  });
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      allowanceWindows: typeof allowanceWindows;
      usageEvents: typeof usageEvents;
    }>;
  declare const db: DrizzleDatabase;
  declare const windowIds: readonly string[];
  declare const unitDeltas: readonly number[];
  declare const eventIds: readonly string[];
  declare const creditsCharged: readonly number[];
  declare const billingErrors: readonly (string | null)[];
  declare const updatedAt: Date;
`;

const upsertPreamble = `
  import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

  const orgMetadata = pgTable("org_metadata", {
    orgId: text("org_id").primaryKey(),
    credits: integer("credits").notNull(),
    tier: text("tier").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  });
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      orgMetadata: typeof orgMetadata;
    }>;
  declare const db: DrizzleDatabase;
  declare const orgId: string;
  declare const amount: number;
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

const joinedHistoryQuery = `
  sql\`
    SELECT
      \${runs.id} AS "rowId",
      \${runs.threadId} AS "threadId",
      COALESCE(\${runStates.status}, 'unknown') AS "status"
    FROM \${runs}
    INNER JOIN \${runStates}
      ON \${eq(runStates.id, runs.id)}
    LEFT JOIN \${callbacks}
      ON \${callbacks.runId} = COALESCE(
        \${runs.id},
        (
          SELECT \${callbacks.runId}
          FROM \${callbacks}
          WHERE \${eq(callbacks.runId, runs.id)}
          ORDER BY \${callbacks.id}
          LIMIT 1
        )
      )
    WHERE \${eq(runs.threadId, threadId)}
      AND \${eq(runs.id, excludedRunId)}
    ORDER BY \${desc(runs.id)}, \${desc(runs.threadId)}
    LIMIT \${pageLimit}
  \`
`;

const joinedExistsQuery = `
  sql\`
    SELECT EXISTS (
      SELECT 1
      FROM \${runs}
      INNER JOIN \${runStates}
        ON \${eq(runStates.id, runs.id)}
      WHERE \${eq(runs.threadId, threadId)}
        AND \${eq(runs.id, excludedRunId)}
      LIMIT 1
    ) AS visible
  \`
`;

const runnerLockingQuery = `
  sql\`
    SELECT
      \${runs.id} AS "runId",
      \${runs.threadId} > 0 AS "isExpired"
    FROM \${runs}
    WHERE \${eq(runs.id, threadId)}
    FOR UPDATE
  \`
`;

ruleTester.run("prefer-drizzle-query-builder", preferDrizzleQueryBuilder, {
  valid: [
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`
          UPDATE \${allowanceWindows}
          SET
            "consumed_units" = \${allowanceWindows.consumedUnits} + consumption.units_applied,
            "updated_at" = \${updatedAt}
          FROM unnest(
            \${sql.param(windowIds)}::uuid[],
            \${sql.param(unitDeltas)}::bigint[]
          ) AS consumption(window_id, units_applied)
          WHERE \${allowanceWindows.id} = consumption.window_id
        \`;
        await db.execute(query);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const fakeDb = {
          async execute(query: unknown) {
            return query;
          },
        };
        await fakeDb.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE \${allowanceWindows.id} = consumption.window_id
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        function sql(
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) {
          return { strings, values };
        }
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${windowIds}) AS consumption(window_id)
          WHERE \${allowanceWindows.id} = consumption.window_id
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const notATable = sql\`allowance_windows\`;
        await db.execute(sql\`
          UPDATE \${notATable}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH changed AS (SELECT 1)
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
          WHERE true
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
          WHERE true
          RETURNING id
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
          WHERE true;
          SELECT 1
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          UPDATE \${allowanceWindows} AS target
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
          WHERE target.id = consumption.window_id
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = incoming.units_applied
          FROM (VALUES (1)) AS incoming(units_applied)
          WHERE true
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units[1] = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[]) AS consumption(units_applied)
          WHERE true
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(unitDeltas)}::bigint[])
            AS consumption(units_applied bigint)
          WHERE true
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`
          DELETE FROM cleanup_rows
          WHERE expires_at <= \${cutoff}
        \`;
        await db.execute(query);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const fakeDb = {
          async execute(query: unknown) {
            return query;
          },
        };
        await fakeDb.execute(sql\`
          DELETE FROM cleanup_rows
          WHERE expires_at <= \${cutoff}
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        function sql(
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) {
          return { strings, values };
        }
        await db.execute(sql\`
          DELETE FROM cleanup_rows
          WHERE expires_at <= \${cutoff}
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH expired AS (
            SELECT id FROM cleanup_rows WHERE expires_at <= \${cutoff}
          )
          DELETE FROM cleanup_rows
          WHERE id IN (SELECT id FROM expired)
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows
          USING other_rows
          WHERE cleanup_rows.id = other_rows.id
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows
          WHERE expires_at <= \${cutoff}
          RETURNING id
        \`);
        await db.execute(sql\`
          DELETE FROM ONLY cleanup_rows
          WHERE expires_at <= \${cutoff}
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows *
          WHERE expires_at <= \${cutoff}
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows
          WHERE CURRENT OF cleanup_cursor
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          DELETE FROM cleanup_rows AS target
          WHERE target.expires_at <= \${cutoff}
        \`);
        await db.execute(sql\`
          DELETE FROM public.cleanup_rows
          WHERE expires_at <= \${cutoff}
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows, other_rows
          WHERE cleanup_rows.id = other_rows.id
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows
        \`);
        await db.execute(sql\`
          DELETE FROM cleanup_rows
          WHERE expires_at <= \${cutoff};
          SELECT 1
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { eq, sql } from "drizzle-orm";
        const notATable = sql\`cleanup_rows\`;
        await db.execute(sql\`
          DELETE FROM \${notATable}
          WHERE \${eq(cleanupRows.id, 1)}
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`
          INSERT INTO org_metadata (
            org_id,
            credits,
            created_at,
            updated_at
          )
          VALUES (\${orgId}, \${amount}, now(), now())
          ON CONFLICT (org_id)
          DO UPDATE SET
            credits = org_metadata.credits + \${amount},
            updated_at = now()
        \`;
        await db.execute(query);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        const fakeDb = {
          async execute(query: unknown) {
            return query;
          },
        };
        await fakeDb.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        function sql(
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) {
          return { strings, values };
        }
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH incoming AS (SELECT \${orgId} AS org_id)
          INSERT INTO org_metadata (org_id, credits)
          SELECT org_id, \${amount} FROM incoming
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          SELECT \${orgId}, \${amount}
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO public.org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata AS target (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = target.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO "org_metadata" ("org_id", "credits")
          VALUES (\${orgId}, \${amount})
          ON CONFLICT ("org_id")
          DO UPDATE SET "credits" = "org_metadata"."credits" + \${amount}
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount}), ('other', \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata DEFAULT VALUES
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT ON CONSTRAINT org_metadata_pkey
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id) DO NOTHING
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (lower(org_id))
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (\${orgMetadata.orgId})
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id) WHERE org_id IS NOT NULL
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
          WHERE org_metadata.credits >= 0
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
          RETURNING org_id
        \`);
        await db.execute(sql\`
          INSERT INTO org_metadata (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount};
          SELECT 1
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        const notATable = sql\`org_metadata\`;
        await db.execute(sql\`
          INSERT INTO \${notATable} (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = org_metadata.credits + \${amount}
        \`);
      `,
    },
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
          sql\`
            SELECT (
              \${eq(runs.id, threadId)}
              OR \${eq(runs.id, excludedRunId)}
            ) AS allowed
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`SELECT clock_timestamp() AS database_time\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH visible_runs AS MATERIALIZED (
              SELECT \${runs.id}
              FROM \${runs}
              WHERE \${eq(runs.threadId, threadId)}
            )
            SELECT id FROM visible_runs
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            SELECT EXISTS (
              SELECT count(*)
              FROM \${runs}
              INNER JOIN \${runStates}
                ON \${eq(runStates.id, runs.id)}
              WHERE \${eq(runs.threadId, threadId)}
              LIMIT 1
            ) AS visible
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        const source = sql.identifier("runs");
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}, \${runs.threadId}
            FROM \${source}
            INNER JOIN \${runStates}
              ON \${eq(runStates.id, runs.id)}
            WHERE \${eq(runs.threadId, threadId)}
            ORDER BY \${runs.id}
            LIMIT \${pageLimit}
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}, \${runs.threadId}
            FROM \${runs}
            INNER JOIN \${runStates}
              ON \${eq(runStates.id, runs.id)}
            WHERE \${eq(runs.threadId, threadId)}
            ORDER BY \${pageLimit}
            LIMIT \${pageLimit}
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}, \${runs.threadId}
            FROM \${runs}
            INNER JOIN \${runStates}
              ON \${eq(runStates.id, runs.id)}
            WHERE \${eq(runs.threadId, threadId)}
            ORDER BY \${runs.id}
            LIMIT \${String(pageLimit)}
          \`,
          rowSchema,
        );
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
          sql\`
            SELECT DISTINCT \${runs.id}
            FROM \${runs}
            WHERE \${eq(runs.id, threadId)}
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            WITH locked AS (
              SELECT \${runs.id}
              FROM \${runs}
              WHERE \${eq(runs.id, threadId)}
              FOR UPDATE
            )
            SELECT * FROM locked
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}
            INNER JOIN \${runStates}
              ON \${eq(runStates.id, runs.id)}
            WHERE \${eq(runs.id, threadId)}
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}, \${runStates}
            WHERE \${eq(runs.id, threadId)}
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}
            WHERE EXISTS (
              SELECT 1
              FROM \${callbacks}
              WHERE \${eq(callbacks.runId, runs.id)}
            )
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, threadId)} FOR SHARE\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, threadId)} FOR UPDATE NOWAIT\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`SELECT \${runs.id} FROM \${runs} WHERE \${eq(runs.id, threadId)} FOR UPDATE OF runs\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}
            WHERE \${eq(runs.id, threadId)}
            LIMIT \${1}
            FOR UPDATE
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}
            WHERE \${eq(runs.id, threadId)}
            LIMIT 2
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        const lockingQuery = ${runnerLockingQuery};
        await executeRawRows(db, lockingQuery, rowSchema);
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        const source = sql.identifier("runs");
        await executeRawRows(
          db,
          sql\`
            SELECT id
            FROM \${source}
            WHERE \${eq(runs.id, threadId)}
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        async function executeRawRows(...args: unknown[]) { return args; }
        await executeRawRows(db, ${runnerLockingQuery}, rowSchema);
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        const eq = (...values: unknown[]) => values;
        await executeRawRows(db, ${runnerLockingQuery}, rowSchema);
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
        db.selectDistinctOn([${scalarQuery}], { value: users.id });
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
        const adapter = {
          select(fields: unknown) {
            void fields;
            return db.select({ id: users.id });
          },
          returning(fields: unknown) {
            void fields;
            return db.update(users).set({ name: "updated" });
          },
        };
        adapter.select({ value: ${mappedScalarQuery} });
        adapter.returning({ value: ${mappedScalarQuery} });
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        declare const useDatabase: boolean;
        const adapter = {
          select(fields: unknown) {
            void fields;
            return db.select({ id: users.id });
          },
        };
        const consumer = useDatabase ? db : adapter;
        consumer.select({ value: ${mappedScalarQuery} });
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
        const fields = { value: ${mappedScalarQuery} };
        fields.value = sql\`1\`.mapWith(messages.id);
        db.select(fields);
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const fields = { value: ${mappedScalarQuery} };
        const alias = fields;
        alias.value = sql\`1\`.mapWith(messages.id);
        db.select(fields);
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        declare function inspect(fields: object): void;
        const fields = { value: ${mappedScalarQuery} };
        inspect(fields);
        db.select(fields);
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
        function fields() {
          return { value: ${mappedScalarQuery} };
        }
        fields = () => ({ value: sql\`1\`.mapWith(messages.id) });
        db.select(fields());
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const selection = { value: ${mappedScalarQuery} };
        function fields() {
          return selection;
        }
        fields().value = sql\`1\`.mapWith(messages.id);
        db.select(fields());
      `,
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        export const fields = { value: ${mappedScalarQuery} };
        export function selectedFields() {
          return db.select(fields);
        }
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
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET
            "consumed_units" = \${allowanceWindows.consumedUnits} + consumption.units_applied,
            "updated_at" = \${updatedAt}
          FROM unnest(
            \${sql.param(windowIds)}::uuid[],
            \${sql.param(unitDeltas)}::bigint[]
          ) AS consumption(window_id, units_applied)
          WHERE \${allowanceWindows.id} = consumption.window_id
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          UPDATE \${usageEvents}
          SET
            "credits_charged" = settlement.credits_charged,
            "status" = 'processed',
            "processed_at" = \${updatedAt},
            "billing_error" = settlement.billing_error
          FROM unnest(
            \${sql.param(eventIds)}::uuid[],
            \${sql.param(creditsCharged)}::bigint[],
            \${sql.param(billingErrors)}::varchar(50)[]
          ) AS settlement(usage_event_id, credits_charged, billing_error)
          WHERE \${usageEvents.id} = settlement.usage_event_id
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql as query } from "drizzle-orm";
        await db.execute(query\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(
            \${query.param(windowIds)}::uuid[],
            \${query.param(unitDeltas)}::bigint[]
          ) AS consumption(window_id, units_applied)
          WHERE \${allowanceWindows.id} = consumption.window_id;
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `${unnestUpdatePreamble}
        import * as drizzle from "drizzle-orm";
        await db["execute"](drizzle.sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(
            \${drizzle.sql.param(windowIds)}::uuid[],
            \${drizzle.sql.param(unitDeltas)}::bigint[]
          ) AS consumption(window_id, units_applied)
          WHERE \${allowanceWindows.id} = consumption.window_id
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { lte, sql } from "drizzle-orm";
        const { rowCount } = await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${lte(cleanupRows.expiresAt, cutoff)}
        \`);
        void rowCount;
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { gte, inArray, lt, sql } from "drizzle-orm";
        declare const windowStart: Date;
        declare const windowEnd: Date;
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${gte(cleanupRows.expiresAt, windowStart)}
            AND \${lt(cleanupRows.expiresAt, windowEnd)}
            AND \${inArray(cleanupRows.id, [1, 2])}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql as query } from "drizzle-orm";
        await db.execute(query\`
          DELETE FROM cleanup_rows
          WHERE id IN (
            SELECT id
            FROM cleanup_rows
            WHERE expires_at <= \${cutoff}
              AND 'RETURNING ignored' = 'RETURNING ignored'
              /* USING and DELETE FROM ignored */
            ORDER BY expires_at
            LIMIT \${1000}
          );
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import * as drizzle from "drizzle-orm";
        const { rowCount } = await db["execute"](drizzle.sql\`
          DELETE FROM cleanup_rows
          WHERE ctid IN (
            SELECT ctid
            FROM cleanup_rows
            WHERE expires_at < \${cutoff}
            LIMIT \${10_000}
          )
        \`);
        void rowCount;
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${upsertPreamble}
        import { sql as query } from "drizzle-orm";
        await db.execute(query\`
          INSERT INTO org_metadata (
            org_id,
            credits,
            tier,
            created_at,
            updated_at
          )
          VALUES (\${orgId}, \${amount}, 'free', now(), now())
          ON CONFLICT (org_id)
          DO UPDATE SET
            credits = org_metadata.credits + \${amount},
            updated_at = now(),
            tier = 'free';
        \`);
      `,
      errors: [{ messageId: "upsertQueryBuilder" }],
    },
    {
      code: `${upsertPreamble}
        import * as drizzle from "drizzle-orm";
        await db["execute"](drizzle.sql\`
          INSERT INTO \${orgMetadata} (org_id, credits, created_at, updated_at)
          VALUES (\${orgId}, \${amount}, now(), now())
          ON CONFLICT (org_id)
          DO UPDATE SET
            credits = COALESCE((
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${orgId}
                AND 'RETURNING ignored' = 'RETURNING ignored'
            ), 0) + \${amount},
            updated_at = now()
        \`);
      `,
      errors: [{ messageId: "upsertQueryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { desc, eq, sql } from "drizzle-orm";
        await executeRawRows(db, ${joinedHistoryQuery}, rowSchema);
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(db, ${joinedExistsQuery}, rowSchema);
      `,
      errors: [{ messageId: "existsQueryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}
            LEFT OUTER JOIN \${runStates}
              ON \${eq(runStates.id, runs.id)}
            WHERE \${eq(runs.id, threadId)}
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(db, ${runnerLockingQuery}, rowSchema);
      `,
      errors: [{ messageId: "lockingQueryBuilder" }],
    },
    {
      code: `${schemaPreamble}
        import { sql as query } from "drizzle-orm";
        import { executeRawRows as decodeRows } from "./lib/db-raw-rows";
        await decodeRows(
          db,
          query\`
            SELECT id, from_address, to_addresses, attempts
            FROM email_outbox
            WHERE id = \${threadId}
              AND status = 'pending'
              AND 'FOR UPDATE ignored' = 'FOR UPDATE ignored'
              /* SELECT FROM ignored */
            FOR UPDATE SKIP LOCKED;
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "lockingQueryBuilder" }],
    },
    {
      code: `${schemaPreamble}
        import * as drizzle from "drizzle-orm";
        import * as rawRows from "./lib/db-raw-rows";
        await rawRows.executeRawRows(
          db,
          drizzle.sql\`
            SELECT id, from_address, to_addresses, attempts
            FROM email_outbox
            WHERE status = 'pending'
              AND (next_retry_at IS NULL OR next_retry_at <= \${threadId})
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "lockingQueryBuilder" }],
    },
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
        import { sql } from "drizzle-orm";
        declare const selectedDb: Pick<DrizzleDatabase, "select">;
        selectedDb.select({ value: ${mappedScalarQuery} }).from(users);
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        declare const selectedDb: {
          select: DrizzleDatabase["select"] & { readonly kind: "select" };
        };
        selectedDb.select({ value: ${mappedScalarQuery} }).from(users);
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const usersCte = db.$with("users_cte").as(
          db.select({ id: users.id }).from(users),
        );
        db.with(usersCte)
          .select({ value: ${mappedScalarQuery} })
          .from(usersCte);
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
          workflowAutomationBrief: sql\`(
            SELECT COALESCE(
              "zero_runs"."trigger_brief",
              CASE
                WHEN "zero_workflow_automations"."kind" = 'event'
                  THEN 'Webhook received'
                ELSE NULL
              END
            )
            FROM "zero_runs"
            INNER JOIN "zero_workflow_automations"
              ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
            WHERE "zero_runs"."id" = "chat_messages"."run_id"
            LIMIT 1
          )\`.mapWith(users.name),
          workflowAutomationUserTimezone: sql\`(
            SELECT "org_members_metadata"."timezone"
            FROM "zero_runs"
            INNER JOIN "zero_workflow_automations"
              ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
            LEFT JOIN "org_members_metadata"
              ON "org_members_metadata"."org_id" = "zero_workflow_automations"."org_id"
              AND "org_members_metadata"."user_id" = "zero_workflow_automations"."owner_user_id"
            WHERE "zero_runs"."id" = "chat_messages"."run_id"
            LIMIT 1
          )\`.mapWith(users.name),
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
      errors: [
        { messageId: "structuredScalarQuery" },
        { messageId: "structuredScalarQuery" },
      ],
    },
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        const fields = {
          value: ${mappedScalarQuery},
        } satisfies Record<string, unknown>;
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
