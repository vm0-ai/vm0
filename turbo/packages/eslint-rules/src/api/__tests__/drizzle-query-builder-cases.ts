import type { RunTests } from "@typescript-eslint/rule-tester";

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

const lockingCteUpdatePreamble = `
  import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

  const cacheRows = pgTable("cache_rows", {
    cacheKey: text("cache_key").primaryKey(),
    lastRequestedAt: timestamp("last_requested_at").notNull(),
  });
  const cacheRowMetadata = pgTable("cache_row_metadata", {
    cacheKey: text("cache_key").primaryKey(),
  });
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      cacheRows: typeof cacheRows;
      cacheRowMetadata: typeof cacheRowMetadata;
    }>;
  declare const db: DrizzleDatabase;
  declare const cacheKeys: readonly string[];
  declare const cutoff: Date;
  declare const issuedAt: Date;
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

const creditAvailabilityQuery = `
  sql\`
    WITH org AS (
      SELECT credits
      FROM org_metadata
      WHERE org_id = \${threadId}
      LIMIT 1
    ),
    expired AS (
      SELECT COALESCE(SUM(remaining), 0)::bigint AS total
      FROM credit_expires_record
      WHERE org_id = \${threadId}
        AND expires_at <= now()
        AND remaining > 0
    )
    SELECT
      (SELECT credits FROM org) AS credits,
      (SELECT total FROM expired) AS unsettled_expired
  \`
`;

const managedCreditAvailabilityQuery = `
  sql\`
    WITH pricing AS (
      SELECT unit_price, unit_size
      FROM usage_pricing
      WHERE kind = \${threadId}
        AND provider = \${threadId}
        AND category = \${threadId}
      LIMIT 1
    ),
    org AS (
      SELECT credits
      FROM org_metadata
      WHERE org_id = \${threadId}
      LIMIT 1
    ),
    expired AS (
      SELECT COALESCE(SUM(remaining), 0)::bigint AS total
      FROM credit_expires_record
      WHERE org_id = \${threadId}
        AND expires_at <= now()
        AND remaining > 0
    )
    SELECT
      (SELECT credits FROM org) AS credits,
      (SELECT total FROM expired) AS unsettled_expired,
      (SELECT unit_price FROM pricing) AS unit_price,
      (SELECT unit_size FROM pricing) AS unit_size
  \`
`;

const composedReadCtePreamble = `
  function usageCreditsExpr() {
    return sql\`COALESCE(ue.credits_charged, 0)\`;
  }

  function usageRowsCte(userId: number) {
    return sql\`
      usage_rows AS (
        SELECT
          ue.run_id,
          \${usageCreditsExpr()}::bigint AS credits
        FROM usage_event ue
        LEFT JOIN usage_allowance_allocations uaa
          ON uaa.usage_event_id = ue.id
        WHERE ue.user_id = \${userId}
      )
    \`;
  }

  function usageRowsWith(userId: number) {
    return sql\`WITH \${usageRowsCte(userId)}\`;
  }
`;

type QueryBuilderMessageId =
  | "composedCteQueryBuilder"
  | "deleteQueryBuilder"
  | "existencePredicate"
  | "existsQueryBuilder"
  | "lockingCteUpdateQueryBuilder"
  | "lockingQueryBuilder"
  | "queryBuilder"
  | "scalarCteQueryBuilder"
  | "structuredScalarQuery"
  | "typedApi"
  | "unnestUpdateQueryBuilder"
  | "upsertQueryBuilder";

interface WriteDescendantError {
  readonly data: {
    readonly helper: string;
  };
  readonly messageId: "typedApi";
}

const queryBuilderCases = {
  writeValid: [
    {
      descendantErrors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
      code: `${lockingCteUpdatePreamble}
        import { inArray, lte, sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH RECURSIVE locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
      `,
    },
    {
      code: `${lockingCteUpdatePreamble}
        import { sql } from "drizzle-orm";
        const otherCacheRows = pgTable("other_cache_rows", {
          cacheKey: text("cache_key").primaryKey(),
          lastRequestedAt: timestamp("last_requested_at").notNull(),
        });
        const disguisedCacheRows =
          otherCacheRows as unknown as typeof cacheRows;
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${disguisedCacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE true
            ORDER BY \${disguisedCacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}
          FROM locked
          WHERE true
        \`);
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE true
            ORDER BY \${disguisedCacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}
          FROM locked
          WHERE true
        \`);
      `,
    },
    {
      descendantErrors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
      code: `${lockingCteUpdatePreamble}
        import { eq, inArray, lte, sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            INNER JOIN \${cacheRowMetadata}
              ON \${eq(cacheRowMetadata.cacheKey, cacheRows.cacheKey)}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
      `,
    },
    {
      descendantErrors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
      code: `${lockingCteUpdatePreamble}
        import { inArray, lte, sql } from "drizzle-orm";
        const dynamicTable = sql.identifier("cache_rows");
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${dynamicTable}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${dynamicTable}
          )
          UPDATE \${dynamicTable}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
      `,
    },
    {
      descendantErrors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
      code: `${lockingCteUpdatePreamble}
        import { inArray, lte, sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows} NOWAIT
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          DELETE FROM \${cacheRows}
          USING locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
          RETURNING \${cacheRows.cacheKey}
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
        const audit = pgSchema("audit");
        const schemaCacheRows = audit.table("cache_rows", {
          cacheKey: text("cache_key").primaryKey(),
          lastRequestedAt: timestamp("last_requested_at").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            schemaCacheRows: typeof schemaCacheRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const issuedAt: Date;
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${schemaCacheRows.cacheKey}
            FROM \${schemaCacheRows}
            WHERE true
            ORDER BY \${schemaCacheRows.cacheKey}
            FOR UPDATE OF \${schemaCacheRows}
          )
          UPDATE \${schemaCacheRows}
          SET last_requested_at = \${issuedAt}
          FROM locked
          WHERE true
        \`);
      `,
    },
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
        declare function expose(value: unknown): void;
        expose(query);
        await db.execute(query);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        import { alias } from "drizzle-orm/pg-core";
        const target = alias(allowanceWindows, "target");
        await db.execute(sql\`
          UPDATE \${target}
          SET consumed_units = source.units_applied
          FROM unnest(
            \${sql.param(unitDeltas)}::bigint[]
          ) AS source(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { aliasedTable, sql } from "drizzle-orm";
        const target = aliasedTable(allowanceWindows, "target");
        await db.execute(sql\`
          UPDATE \${target}
          SET consumed_units = source.units_applied
          FROM unnest(
            \${sql.param(unitDeltas)}::bigint[]
          ) AS source(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { aliasedTable, sql } from "drizzle-orm";
        let reassignedTarget = cleanupRows;
        reassignedTarget = aliasedTable(cleanupRows, "reassigned_target");
        const holder = { target: cleanupRows };
        holder.target = aliasedTable(cleanupRows, "property_target");
        declare const dynamicHolder: {
          target: typeof cleanupRows | undefined;
        };
        const { target = cleanupRows } = dynamicHolder;
        await db.execute(sql\`
          DELETE FROM \${reassignedTarget}
          WHERE true
        \`);
        await db.execute(sql\`
          DELETE FROM \${holder.target}
          WHERE true
        \`);
        await db.execute(sql\`
          DELETE FROM \${target}
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const runtimeRows = pgTable("runtime_rows", {
          id: integer("id").primaryKey(),
          first: integer("actual_value").notNull(),
          second: integer("claimed_value").notNull(),
        });
        const claimedRows = pgTable("claimed_rows", {
          id: integer("id").primaryKey(),
          first: integer("claimed_value").notNull(),
          second: integer("actual_value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            runtimeRows: typeof runtimeRows;
            claimedRows: typeof claimedRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        const target = runtimeRows as unknown as typeof claimedRows;
        await db.execute(sql\`
          UPDATE \${target}
          SET claimed_value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
        const rowsA = pgTable("union_rows", {
          id: text("id").primaryKey(),
          value: integer("value").notNull(),
          updatedAt: timestamp("updated_at").notNull(),
        });
        const rowsB = pgTable("union_rows", {
          id: text("id").primaryKey(),
          updatedAt: timestamp("updated_at").notNull(),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            rowsA: typeof rowsA;
            rowsB: typeof rowsB;
          }>;
        declare const db: DrizzleDatabase;
        declare const flag: boolean;
        declare const values: readonly number[];
        declare const updatedAt: Date;
        const target = flag ? rowsA : rowsB;
        await db.execute(sql\`
          UPDATE \${target}
          SET
            value = source.value,
            updated_at = \${updatedAt}
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";
        const claimedColumns = {
          value: integer("value").notNull(),
          updatedAt: timestamp("updated_at").notNull(),
        };
        const assertedRuntimeRows = pgTable(
          "asserted_runtime_rows",
          ({
            value: integer("value").notNull(),
            updatedAt: timestamp("updated_at")
              .notNull()
              .$onUpdateFn(() => new Date()),
          } as unknown as typeof claimedColumns),
        );
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            assertedRuntimeRows: typeof assertedRuntimeRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${assertedRuntimeRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const runtimeName = "runtime_value" as "claimed_value";
        const assertedNameRows = pgTable("asserted_name_rows", {
          value: integer(runtimeName).notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            assertedNameRows: typeof assertedNameRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${assertedNameRows}
          SET claimed_value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const sharedColumn = integer();
        const reusedBuilderRows = pgTable("reused_builder_rows", {
          first: sharedColumn,
          second: sharedColumn,
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            reusedBuilderRows: typeof reusedBuilderRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${reusedBuilderRows}
          SET second = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";
        const updatedAt = timestamp("updated_at").notNull();
        updatedAt.$onUpdateFn(() => new Date());
        const mutatedBuilderRows = pgTable("mutated_builder_rows", {
          value: integer("value").notNull(),
          updatedAt,
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            mutatedBuilderRows: typeof mutatedBuilderRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${mutatedBuilderRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";
        const runtimeTimestamp = ((name: string) =>
          timestamp(name).$onUpdateFn(
            () => new Date(),
          )) as unknown as typeof timestamp;
        const hiddenFactoryRows = pgTable("hidden_factory_rows", {
          value: integer("value").notNull(),
          updatedAt: runtimeTimestamp("updated_at").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            hiddenFactoryRows: typeof hiddenFactoryRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${hiddenFactoryRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";
        const runtimeRows = pgTable("hidden_table_factory_rows", {
          value: integer("value").notNull(),
          updatedAt: timestamp("updated_at")
            .notNull()
            .$onUpdateFn(() => new Date()),
        });
        const hiddenTableFactory = ((
          name: string,
          columns: unknown,
        ) => {
          void name;
          void columns;
          return runtimeRows;
        }) as unknown as typeof pgTable;
        const hiddenTableFactoryRows = hiddenTableFactory(
          "hidden_table_factory_rows",
          {
            value: integer("value").notNull(),
            updatedAt: timestamp("updated_at").notNull(),
          },
        );
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            hiddenTableFactoryRows: typeof hiddenTableFactoryRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${hiddenTableFactoryRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const claimedFirst = integer("claimed_value").notNull();
        const claimedSecond = integer("actual_value").notNull();
        const assertedFirst =
          integer("actual_value").notNull() as unknown as typeof claimedFirst;
        const assertedSecond =
          integer("claimed_value").notNull() as unknown as typeof claimedSecond;
        const assertedColumnRows = pgTable("asserted_column_rows", {
          first: assertedFirst,
          second: assertedSecond,
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            assertedColumnRows: typeof assertedColumnRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${assertedColumnRows}
          SET claimed_value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const claimedColumns = {
          first: integer("claimed_value").notNull(),
          second: integer("actual_value").notNull(),
        };
        const assertedConfigRows = pgTable(
          "asserted_config_rows",
          ({
            first: integer("actual_value").notNull(),
            second: integer("claimed_value").notNull(),
          } as unknown as typeof claimedColumns),
        );
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            assertedConfigRows: typeof assertedConfigRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${assertedConfigRows}
          SET claimed_value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const numericRows = pgTable("numeric_rows", {
          "2": integer("second").notNull(),
          "1": integer("first").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            numericRows: typeof numericRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const first: number;
        declare const second: number;
        await db.execute(sql\`
          INSERT INTO \${numericRows} (second, first)
          VALUES (\${second}, \${first})
          ON CONFLICT (second)
          DO UPDATE SET
            second = \${second},
            first = \${first}
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, text } from "drizzle-orm/pg-core";
        const collidingRows = pgTable("colliding_rows", {
          enableRLS: text("enable_rls").notNull(),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            collidingRows: typeof collidingRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const key: string;
        declare const value: number;
        await db.execute(sql\`
          INSERT INTO \${collidingRows} (enable_rls, value)
          VALUES (\${key}, \${value})
          ON CONFLICT (enable_rls)
          DO UPDATE SET value = \${value}
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const trailingColumns = {
          second: integer("second").notNull(),
          third: integer("third").notNull(),
        };
        const spreadRows = pgTable("spread_rows", {
          first: integer("first").notNull(),
          ...trailingColumns,
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            spreadRows: typeof spreadRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${spreadRows}
          SET
            second = source.second,
            third = source.third,
            first = source.first
          FROM unnest(
            \${sql.param(values)}::integer[],
            \${sql.param(values)}::integer[],
            \${sql.param(values)}::integer[]
          ) AS source(second, third, first)
          WHERE true
        \`);
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
      descendantErrors: [{ messageId: "typedApi", data: { helper: "eq" } }],
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        declare const fakeParam: typeof sql.param;
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(
            \${fakeParam(windowIds)}::uuid[]
          ) AS consumption(window_id)
          WHERE \${allowanceWindows.id} = consumption.window_id
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        declare const fakeSql: typeof sql;
        await db.execute(fakeSql\`
          DELETE FROM \${cleanupRows}
          WHERE true
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        declare const fakeSql: typeof sql;
        const predicate = fakeSql\`true\`;
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${predicate}
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        declare const fakeSql: typeof sql;
        await db.execute(
          fakeSql.join([
            sql\`DELETE FROM \${cleanupRows}\`,
            sql\` WHERE true\`,
          ]),
        );
        await db.execute(sql\`
          \${fakeSql.empty()}DELETE FROM \${cleanupRows}
          WHERE true
        \`);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        type MySqlDatabase = import("drizzle-orm/mysql-core").MySqlDatabase<
          never,
          never
        >;
        declare const mysqlDb: MySqlDatabase;
        await mysqlDb.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const wrappedDb: { execute: typeof db.execute } = {
          execute: db.execute,
        };
        await wrappedDb.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        type WriteFacade = Pick<
          DrizzleDatabase,
          "$with" | "delete" | "execute" | "insert" | "select" | "update" | "with"
        >;
        declare const writeFacade: WriteFacade;
        await writeFacade.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const assertedDb = {
          execute: db.execute,
        } as unknown as DrizzleDatabase;
        await assertedDb.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        let deferredDb: DrizzleDatabase;
        deferredDb = {
          execute: db.execute,
        } as unknown as DrizzleDatabase;
        await deferredDb.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        function identity<T>(value: T): T {
          return value;
        }
        const nestedAssertedDb = identity({
          execute: db.execute,
        } as unknown as DrizzleDatabase);
        await nestedAssertedDb.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        class DatabaseHolder {
          readonly database = {
            execute: db.execute,
          } as unknown as DrizzleDatabase;

          async update(): Promise<void> {
            await this.database.execute(sql\`
              UPDATE \${allowanceWindows}
              SET consumed_units = consumption.units_applied
              FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
              WHERE true
            \`);
          }
        }
        void DatabaseHolder;
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const holder = {
          database: {
            execute: db.execute,
          },
        } as unknown as { readonly database: DrizzleDatabase };
        await holder["database"].execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const holder = {
          database: {
            execute: db.execute,
          },
        } as unknown as { readonly database: DrizzleDatabase };
        const { database } = holder;
        await database.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        class DatabaseHolder {
          readonly database = {
            execute: db.execute,
          } as unknown as DrizzleDatabase;

          async update(): Promise<void> {
            await this["database"].execute(sql\`
              UPDATE \${allowanceWindows}
              SET consumed_units = consumption.units_applied
              FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
              WHERE true
            \`);
          }
        }
        void DatabaseHolder;
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const databases = [
          {
            execute: db.execute,
          } as unknown as DrizzleDatabase,
        ];
        for (const database of databases) {
          await database.execute(sql\`
            UPDATE \${allowanceWindows}
            SET consumed_units = consumption.units_applied
            FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
            WHERE true
          \`);
        }
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        function createDatabase(): DrizzleDatabase {
          return {
            execute: db.execute,
          } as unknown as DrizzleDatabase;
        }
        await createDatabase().execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        async function update(
          database: DrizzleDatabase = {
            execute: db.execute,
          } as unknown as DrizzleDatabase,
        ): Promise<void> {
          await database.execute(sql\`
            UPDATE \${allowanceWindows}
            SET consumed_units = consumption.units_applied
            FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
            WHERE true
          \`);
        }
        await update();
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        async function update(
          { database }: { readonly database: DrizzleDatabase } = {
            database: {
              execute: db.execute,
            } as unknown as DrizzleDatabase,
          },
        ): Promise<void> {
          await database.execute(sql\`
            UPDATE \${allowanceWindows}
            SET consumed_units = consumption.units_applied
            FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
            WHERE true
          \`);
        }
        await update();
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        const assertedDatabase = {
          execute: db.execute,
        } as unknown as DrizzleDatabase;
        const database = windowIds.length === 0 ? db : assertedDatabase;
        await database.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(\${sql.param(windowIds)}::uuid[]) AS consumption(window_id)
          WHERE true
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
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE CURRENT OF cleanup_cursor
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
        declare function expose(value: unknown): void;
        expose(query);
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
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET (consumed_units, updated_at) = (
            consumption.units_applied,
            \${updatedAt}
          )
          FROM unnest(
            \${sql.param(unitDeltas)}::bigint[]
          ) AS consumption(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET
            updated_at = \${updatedAt},
            consumed_units = consumption.units_applied
          FROM unnest(
            \${sql.param(unitDeltas)}::bigint[]
          ) AS consumption(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import {
          integer,
          pgTable,
          text,
          timestamp,
        } from "drizzle-orm/pg-core";
        const runtimeRows = pgTable("runtime_rows", {
          id: text("id").primaryKey(),
          touchedAt: timestamp("touched_at")
            .notNull()
            .$onUpdate(() => new Date()),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            runtimeRows: typeof runtimeRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${runtimeRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import {
          integer,
          pgTable,
          text,
          timestamp,
        } from "drizzle-orm/pg-core";
        const runtimeRows = pgTable("runtime_rows", {
          id: text("id").primaryKey(),
          touchedAt: timestamp("touched_at")
            .notNull()
            .$onUpdate(() => new Date()),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            runtimeRows: typeof runtimeRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${runtimeRows}
          SET
            touched_at = now(),
            value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const implicitRows = pgTable("implicit_rows", {
          id: integer().primaryKey(),
          value: integer().notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            implicitRows: typeof implicitRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const ids: readonly number[];
        declare const id: number;
        declare const value: number;
        await db.execute(sql\`
          UPDATE \${implicitRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(ids)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
        await db.execute(sql\`
          INSERT INTO \${implicitRows} (id, value)
          VALUES (\${id}, \${value})
          ON CONFLICT (id)
          DO UPDATE SET value = \${value}
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
        declare function expose(value: unknown): void;
        expose(query);
        await db.execute(query);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          INSERT INTO \${orgMetadata} (
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
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, text } from "drizzle-orm/pg-core";
        const optionalRows = pgTable("optional_rows", {
          id: text("id").primaryKey(),
          value: integer("value").notNull(),
          note: text("note"),
        });
        const identityRows = pgTable("identity_rows", {
          id: integer("id").generatedAlwaysAsIdentity(),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            identityRows: typeof identityRows;
            optionalRows: typeof optionalRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const id: string;
        declare const value: number;
        await db.execute(sql\`
          INSERT INTO \${optionalRows} (id, value)
          VALUES (\${id}, \${value})
          ON CONFLICT (id)
          DO UPDATE SET value = \${value}
        \`);
        await db.execute(sql\`
          INSERT INTO \${identityRows} (value)
          VALUES (\${value})
          ON CONFLICT (id)
          DO UPDATE SET value = \${value}
        \`);
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
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          INSERT INTO \${orgMetadata} (
            credits,
            org_id,
            created_at,
            updated_at
          )
          VALUES (\${amount}, \${orgId}, now(), now())
          ON CONFLICT (org_id)
          DO UPDATE SET
            credits = \${amount},
            updated_at = now()
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, text } from "drizzle-orm/pg-core";
        const runtimeRows = pgTable("runtime_rows", {
          id: text("id").primaryKey(),
          token: text("token").$onUpdate(() => "rotated"),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            runtimeRows: typeof runtimeRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const id: string;
        declare const value: number;
        await db.execute(sql\`
          INSERT INTO \${runtimeRows} (id, value)
          VALUES (\${id}, \${value})
          ON CONFLICT (id)
          DO UPDATE SET value = \${value}
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, text } from "drizzle-orm/pg-core";
        const generatedRows = pgTable("generated_rows", {
          id: text("id").primaryKey(),
          normalizedId: text("normalized_id").generatedAlwaysAs(
            sql\`lower(id)\`,
          ),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            generatedRows: typeof generatedRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const id: string;
        declare const value: number;
        await db.execute(sql\`
          INSERT INTO \${generatedRows} (id, value)
          VALUES (\${id}, \${value})
          ON CONFLICT (id)
          DO UPDATE SET value = \${value}
        \`);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, text } from "drizzle-orm/pg-core";
        const generatedRuntimeRows = pgTable("generated_runtime_rows", {
          id: text("id").primaryKey(),
          derived: integer("derived")
            .generatedAlwaysAs(sql\`1\`)
            .$onUpdate(() => 7),
          value: integer("value").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            generatedRuntimeRows: typeof generatedRuntimeRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const id: string;
        declare const value: number;
        await db.execute(sql\`
          INSERT INTO \${generatedRuntimeRows} (id, value)
          VALUES (\${id}, \${value})
          ON CONFLICT (id)
          DO UPDATE SET value = \${value}
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
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET missing_units = consumption.units_applied
          FROM unnest(
            \${sql.param(unitDeltas)}::bigint[]
          ) AS consumption(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `${upsertPreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          INSERT INTO \${orgMetadata} (org_id, missing_credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET credits = \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO \${orgMetadata} (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (missing_org_id)
          DO UPDATE SET credits = \${amount}
        \`);
        await db.execute(sql\`
          INSERT INTO \${orgMetadata} (org_id, credits)
          VALUES (\${orgId}, \${amount})
          ON CONFLICT (org_id)
          DO UPDATE SET missing_credits = \${amount}
        \`);
      `,
    },
    {
      code: `${unnestUpdatePreamble}
        import { sql } from "drizzle-orm";
        function parameter(value: unknown) {
          return sql\`\${value}\`;
        }
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(
            \${parameter(unitDeltas)}::bigint[]
          ) AS consumption(units_applied)
          WHERE true
        \`);
        await db.execute(sql\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(
            \${sql.param(1)}::bigint[]
          ) AS consumption(units_applied)
          WHERE true
        \`);
      `,
    },
    {
      code: `${lockingCteUpdatePreamble}
        import { eq, inArray, sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
            ORDER BY \${cacheRowMetadata.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${eq(cacheRows.cacheKey, cacheRows.cacheKey)}
        \`);
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRowMetadata}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${eq(cacheRows.cacheKey, cacheRows.cacheKey)}
        \`);
      `,
    },
    {
      code: `${lockingCteUpdatePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM ONLY \${cacheRows}
            WHERE true
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE true
        \`);
      `,
    },
    {
      code: `${rawRowsImport}${deletePreamble}
        import { eq, sql } from "drizzle-orm";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            DELETE FROM \${cleanupRows}
            WHERE \${eq(cleanupRows.expiresAt, cutoff)}
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";
        const archivedCleanupRows = pgTable("archived_cleanup_rows", {
          id: integer("id").notNull(),
          expiresAt: timestamp("expires_at").notNull(),
        });
        declare const target:
          | typeof cleanupRows
          | typeof archivedCleanupRows;
        await db.execute(sql\`
          DELETE FROM \${target}
          WHERE true
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
  ],
  readValid: [
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
      code: `${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "@fake/lib/db-raw-rows";
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
        import { sql, type SQL } from "drizzle-orm";
        declare const opaqueCte: SQL;

        function recursiveRows(userId: number) {
          return sql\`
            WITH RECURSIVE rows AS (
              SELECT run_id, user_id
              FROM usage_event
              WHERE user_id = \${userId}
              UNION ALL
              SELECT usage_event.run_id, usage_event.user_id
              FROM usage_event
              INNER JOIN rows ON rows.run_id = usage_event.run_id
            )
          \`;
        }
        function materializedRows(userId: number) {
          return sql\`
            WITH rows AS MATERIALIZED (
              SELECT run_id
              FROM usage_event
              WHERE user_id = \${userId}
            )
          \`;
        }
        function unionRows(userId: number) {
          return sql\`
            WITH rows AS (
              SELECT run_id
              FROM usage_event
              WHERE user_id = \${userId}
              UNION ALL
              SELECT run_id
              FROM archived_usage_event
              WHERE user_id = \${userId}
            )
          \`;
        }
        function deletingRows(userId: number) {
          return sql\`
            WITH rows AS (
              DELETE FROM usage_event
              WHERE user_id = \${userId}
              RETURNING run_id
            )
          \`;
        }
        function lockingRows(userId: number) {
          return sql\`
            WITH rows AS (
              SELECT run_id
              FROM usage_event
              WHERE user_id = \${userId}
              FOR UPDATE
            )
          \`;
        }
        function statefulRows(userId: number) {
          const selectedUserId = userId;
          return sql\`
            WITH rows AS (
              SELECT run_id
              FROM usage_event
              WHERE user_id = \${selectedUserId}
            )
          \`;
        }

        await executeRawRows(
          db,
          sql\`\${recursiveRows(threadId)} SELECT run_id FROM rows\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`\${materializedRows(threadId)} SELECT run_id FROM rows\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`\${unionRows(threadId)} SELECT run_id FROM rows\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`\${deletingRows(threadId)} SELECT run_id FROM rows\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`\${lockingRows(threadId)} SELECT run_id FROM rows\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`\${statefulRows(threadId)} SELECT run_id FROM rows\`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`\${opaqueCte} SELECT run_id FROM rows\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { sql } from "drizzle-orm";
        const dynamicOrgTable = sql.identifier("org_metadata");
        const groupedAggregate = sql\`GROUP BY org_id\`;
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              ORDER BY credits
              LIMIT 1
            ),
            expired AS (
              SELECT COALESCE(SUM(remaining), 0)::bigint AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT total FROM expired) AS unsettled_expired
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            pricing AS (
              SELECT unit_price
              FROM usage_pricing
              WHERE kind = \${threadId}
              LIMIT 1
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT unit_price FROM pricing) AS unit_price
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expired AS (
              SELECT org_id, SUM(remaining) AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
              GROUP BY org_id
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT total FROM expired) AS unsettled_expired
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expired AS (
              SELECT COALESCE(SUM(remaining), 0)::bigint AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
            )
            SELECT
              (SELECT credits FROM org WHERE credits > 0) AS credits,
              (SELECT total FROM expired) AS unsettled_expired
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM \${dynamicOrgTable}
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expired AS (
              SELECT COALESCE(SUM(remaining), 0)::bigint AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT total FROM expired) AS unsettled_expired
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expired AS (
              SELECT COALESCE(SUM(remaining), 0)::bigint AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
            )
            SELECT
              (SELECT credits FROM org) AS value,
              (SELECT total FROM expired) AS value
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expired AS (
              SELECT COALESCE(SUM(remaining), 0)::bigint AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
              \${groupedAggregate}
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT total FROM expired) AS unsettled_expired
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expanded AS (
              SELECT generate_series(
                1,
                COALESCE(SUM(remaining), 0)::integer + 2
              ) AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT total FROM expanded) AS total
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
        const source = sql\`runs\`;
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${source}
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
        declare function expose(value: unknown): void;
        expose(lockingQuery);
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
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        declare const chooseDelete: boolean;
        const query = chooseDelete
          ? sql\`
              DELETE FROM \${cleanupRows}
              WHERE \${cleanupRows.expiresAt} <= \${cutoff}
            \`
          : sql\`SELECT 1\`;
        await db.execute(query);
      `,
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const parts = [
          sql\`DELETE FROM \${cleanupRows}\`,
          sql\` WHERE \${cleanupRows.expiresAt} <= \${cutoff}\`,
        ];
        parts.push(sql\` RETURNING \${cleanupRows.id}\`);
        await db.execute(sql.join(parts));
      `,
    },
  ],
  readInvalid: [
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(db, ${directQuery}, rowSchema);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "and" } }],
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
      errors: [
        { messageId: "typedApi", data: { helper: "or" } },
        { messageId: "typedApi", data: { helper: "count" } },
      ],
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
      errors: [
        {
          messageId: "existencePredicate",
          data: { helper: "exists" },
        },
      ],
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
      errors: [{ messageId: "lockingQueryBuilder" }],
    },
  ],
  invalid: [
    {
      code: `${deletePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const query: SQL = sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`;
        await db.execute(query);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const database = db;
        await database.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        async function deleteExpired(args: {
          readonly database: DrizzleDatabase;
        }): Promise<void> {
          await args.database.execute(sql\`
            DELETE FROM \${cleanupRows}
            WHERE \${cleanupRows.expiresAt} <= \${cutoff}
          \`);
        }
        await deleteExpired({ database: db });
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        type DrizzleTransaction =
          import("drizzle-orm/node-postgres").NodePgTransaction<
            Record<string, never>,
            Record<string, never>
          >;
        declare const tx: DrizzleTransaction;
        await tx.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";
        const cleanupColumns = {
          id: integer("id").notNull(),
          expiresAt: timestamp("expires_at").notNull(),
        };
        const cleanupRows = pgTable("cleanup_rows", cleanupColumns);
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            cleanupRows: typeof cleanupRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const cutoff: Date;
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgSchema } from "drizzle-orm/pg-core";
        const audit = pgSchema("audit");
        const cleanupRows = audit.table("cleanup_rows", {
          id: integer("id").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            cleanupRows: typeof cleanupRows;
          }>;
        declare const db: DrizzleDatabase;
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE true
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import {
          integer,
          pgTableCreator,
          timestamp,
        } from "drizzle-orm/pg-core";
        const cleanupRows = pgTableCreator((name) => {
          return \`prefix_\${name}\`;
        })("cleanup_rows", {
          id: integer("id").notNull(),
          expiresAt: timestamp("expires_at").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            cleanupRows: typeof cleanupRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const cutoff: Date;
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { conversations } from "./src/schema/agent-run-session-conversation";
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            conversations: typeof conversations;
          }>;
        declare const db: DrizzleDatabase;
        await db.execute(sql\`
          DELETE FROM \${conversations}
          WHERE true
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { pgTable, timestamp } from "drizzle-orm/pg-core";
        const cleanupRows = pgTable("cleanup_rows", {
          expiresAt: timestamp().notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            cleanupRows: typeof cleanupRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const cutoff: Date;
        await db.execute(sql\`
          DELETE FROM \${cleanupRows}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      legacyOverclaim: true,
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(
          sql.join([
            sql\`DELETE FROM cleanup_rows\`,
            sql\` WHERE expires_at <= \${cutoff}\`,
          ]),
        );
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        declare const firstPredicate: boolean;
        const query = firstPredicate
          ? sql\`
              DELETE FROM \${cleanupRows}
              WHERE \${cleanupRows.expiresAt} <= \${cutoff}
            \`
          : sql\`
              DELETE FROM \${cleanupRows}
              WHERE \${cleanupRows.id} > \${0}
            \`;
        await db.execute(query);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql, type SQL } from "drizzle-orm";
        function deleteBefore(
          table: typeof cleanupRows,
          column: typeof cleanupRows.expiresAt,
          value: Date,
        ): SQL {
          return sql\`
            DELETE FROM \${table}
            WHERE \${column} <= \${value}
          \`;
        }
        await db.execute(
          deleteBefore(cleanupRows, cleanupRows.expiresAt, cutoff),
        );
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const parts = [
          sql\`DELETE FROM \${cleanupRows}\`,
          sql\` WHERE \${cleanupRows.expiresAt} <= \${cutoff}\`,
        ];
        await db.execute(sql.join(parts));
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const query = sql;
        await db.execute(
          query.join([
            query\`DELETE FROM \${cleanupRows}\`,
            query\` WHERE true\`,
          ]),
        );
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${deletePreamble}
        import { sql } from "drizzle-orm";
        const table = sql\`\${cleanupRows}\`;
        await db.execute(sql\`
          \${sql.empty()}DELETE FROM \${table}
          WHERE \${cleanupRows.expiresAt} <= \${cutoff}
        \`);
      `,
      errors: [{ messageId: "deleteQueryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        const query: SQL = ${runnerLockingQuery};
        await executeRawRows(db, query, rowSchema);
      `,
      errors: [{ messageId: "lockingQueryBuilder" }],
    },
    {
      code: `${lockingCteUpdatePreamble}
        import { inArray, lte, sql } from "drizzle-orm";
        await db.execute(sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey}
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
      `,
      errors: [{ messageId: "lockingCteUpdateQueryBuilder" }],
    },
    {
      code: `${lockingCteUpdatePreamble}
        import { inArray, lte, sql as query } from "drizzle-orm";
        await db["execute"](query\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey} ASC
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key;
        \`);
      `,
      errors: [{ messageId: "lockingCteUpdateQueryBuilder" }],
    },
    {
      code: `${lockingCteUpdatePreamble}
        import * as drizzle from "drizzle-orm";
        await db.execute(drizzle.sql\`
          WITH locked AS (
            SELECT \${cacheRows.cacheKey}
            FROM \${cacheRows}
            WHERE \${drizzle.inArray(cacheRows.cacheKey, cacheKeys)}
              AND \${drizzle.lte(cacheRows.lastRequestedAt, cutoff)}
            ORDER BY \${cacheRows.cacheKey} DESC
            FOR UPDATE OF \${cacheRows}
          )
          UPDATE \${cacheRows}
          SET last_requested_at = \${issuedAt}::timestamp
          FROM locked
          WHERE \${cacheRows.cacheKey} = locked.cache_key
        \`);
      `,
      errors: [{ messageId: "lockingCteUpdateQueryBuilder" }],
    },
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
        import { sql } from "drizzle-orm";
        const query = sql;
        const parameter = sql.param;
        await db.execute(query\`
          UPDATE \${allowanceWindows}
          SET consumed_units = consumption.units_applied
          FROM unnest(
            \${parameter(windowIds)}::uuid[]
          ) AS consumption(window_id)
          WHERE \${allowanceWindows.id} = consumption.window_id
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
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const callbackRows = pgTable("callback_rows", () => ({
          first: integer("first").notNull(),
          second: integer("second").notNull(),
        }));
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            callbackRows: typeof callbackRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${callbackRows}
          SET
            first = source.first,
            second = source.second
          FROM unnest(
            \${sql.param(values)}::integer[],
            \${sql.param(values)}::integer[]
          ) AS source(first, second)
          WHERE true
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const valueColumnName = "value";
        const namedRows = pgTable("named_rows", {
          value: integer(valueColumnName).notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            namedRows: typeof namedRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${namedRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import {
          customType,
          integer,
          pgEnum,
          pgTable,
        } from "drizzle-orm/pg-core";
        const integerColumn = integer;
        const status = pgEnum("factory_status", ["ready", "done"]);
        const customText = customType<{ data: string }>({
          dataType() {
            return "text";
          },
        });
        const factoryRows = pgTable("factory_rows", {
          value: integerColumn("value").notNull(),
          status: status("status").notNull(),
          payload: customText("payload").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            factoryRows: typeof factoryRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${factoryRows}
          SET value = source.value
          FROM unnest(
            \${sql.param(values)}::integer[]
          ) AS source(value)
          WHERE true
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const directSpreadRows = pgTable("direct_spread_rows", {
          first: integer("first").notNull(),
          ...{
            second: integer("second").notNull(),
            third: integer("third").notNull(),
          },
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            directSpreadRows: typeof directSpreadRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const values: readonly number[];
        await db.execute(sql\`
          UPDATE \${directSpreadRows}
          SET
            first = source.first,
            second = source.second,
            third = source.third
          FROM unnest(
            \${sql.param(values)}::integer[],
            \${sql.param(values)}::integer[],
            \${sql.param(values)}::integer[]
          ) AS source(first, second, third)
          WHERE true
        \`);
      `,
      errors: [{ messageId: "unnestUpdateQueryBuilder" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { integer, pgTable } from "drizzle-orm/pg-core";
        const numericRows = pgTable("numeric_rows", {
          "2": integer("second").notNull(),
          "1": integer("first").notNull(),
        });
        type DrizzleDatabase =
          import("drizzle-orm/node-postgres").NodePgDatabase<{
            numericRows: typeof numericRows;
          }>;
        declare const db: DrizzleDatabase;
        declare const first: number;
        declare const second: number;
        await db.execute(sql\`
          INSERT INTO \${numericRows} (first, second)
          VALUES (\${first}, \${second})
          ON CONFLICT (second)
          DO UPDATE SET
            first = \${first},
            second = \${second}
        \`);
      `,
      errors: [{ messageId: "upsertQueryBuilder" }],
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
      legacyOverclaim: true,
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
      legacyOverclaim: true,
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
      legacyOverclaim: true,
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
          INSERT INTO \${orgMetadata} (
            org_id,
            credits,
            tier,
            created_at,
            updated_at
          )
          VALUES (\${orgId}, \${amount}, 'free', now(), now())
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
        import { sql } from "drizzle-orm";
        await executeRawRows(
          db,
          ${creditAvailabilityQuery},
          rowSchema,
        );
      `,
      errors: [{ messageId: "scalarCteQueryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { sql } from "drizzle-orm";
        await executeRawRows(
          db,
          ${managedCreditAvailabilityQuery},
          rowSchema,
        );
      `,
      errors: [{ messageId: "scalarCteQueryBuilder" }],
    },
    {
      code: `${rawRowsImport}${schemaPreamble}
        import { sql } from "drizzle-orm";
        ${composedReadCtePreamble}

        await executeRawRows(
          db,
          sql\`
            \${usageRowsWith(threadId)}
            SELECT
              date_trunc('day', ur.created_at) AS ts,
              COALESCE(SUM(ur.credits), 0)::bigint AS credits
            FROM usage_rows ur
            LEFT JOIN zero_runs zr ON zr.id = ur.run_id
            GROUP BY 1
            ORDER BY 1
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            \${usageRowsWith(threadId)},
            agent_totals AS (
              SELECT
                ar.agent_name,
                COALESCE(SUM(ur.credits), 0)::bigint AS total_credits
              FROM usage_rows ur
              LEFT JOIN agent_runs ar ON ar.id = ur.run_id
              GROUP BY 1
              ORDER BY 2 DESC
            ),
            top_agents AS (
              SELECT agent_name
              FROM agent_totals
              LIMIT 7
            )
            SELECT
              ur.run_id,
              COALESCE(SUM(ur.credits), 0)::bigint AS credits
            FROM usage_rows ur
            LEFT JOIN agent_runs ar ON ar.id = ur.run_id
            WHERE ar.agent_name IN (SELECT agent_name FROM top_agents)
            GROUP BY 1
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            \${usageRowsWith(threadId)}
            SELECT
              COALESCE(SUM(ur.credits), 0)::bigint AS grand_credits
            FROM usage_rows ur
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            \${usageRowsWith(threadId)}
            SELECT
              zr.trigger_source AS source,
              COALESCE(SUM(ur.credits), 0)::bigint AS credits
            FROM usage_rows ur
            LEFT JOIN zero_runs zr ON zr.id = ur.run_id
            WHERE zr.trigger_source IN ('email', 'slack')
            GROUP BY 1
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            \${usageRowsWith(threadId)},
            ranked AS (
              SELECT
                ur.run_id,
                COALESCE(SUM(ur.credits), 0)::bigint AS credits,
                ROW_NUMBER() OVER (
                  ORDER BY SUM(ur.credits) DESC NULLS LAST
                ) AS rn
              FROM usage_rows ur
              GROUP BY ur.run_id
            )
            SELECT run_id, credits, rn
            FROM ranked
            WHERE rn <= 100
            UNION ALL
            SELECT NULL AS run_id, COALESCE(SUM(credits), 0), 101 AS rn
            FROM ranked
            WHERE rn > 100
            ORDER BY rn
          \`,
          rowSchema,
        );
        await executeRawRows(
          db,
          sql\`
            \${usageRowsWith(threadId)},
            ranked AS (
              SELECT
                ur.run_id,
                ROW_NUMBER() OVER (
                  ORDER BY SUM(ur.credits) DESC NULLS LAST
                ) AS rn
              FROM usage_rows ur
              GROUP BY ur.run_id
            )
            SELECT COUNT(*)::bigint AS count
            FROM ranked
            WHERE rn > 100
          \`,
          rowSchema,
        );
      `,
      errors: [
        { messageId: "composedCteQueryBuilder" },
        { messageId: "composedCteQueryBuilder" },
        { messageId: "composedCteQueryBuilder" },
        { messageId: "composedCteQueryBuilder" },
        { messageId: "composedCteQueryBuilder" },
        { messageId: "composedCteQueryBuilder" },
      ],
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
      code: `${rawRowsImport}${schemaPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT \${runs.id}
            FROM \${runs}
            WHERE \${eq(runs.id, threadId)}
            ORDER BY \${runs.id}
            FOR UPDATE OF \${runs}
          \`,
          rowSchema,
        );
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
    {
      code: `${structuredSelectionPreamble}
        import { sql } from "drizzle-orm";
        declare const flag: boolean;
        const selectedValue = flag ? ${mappedScalarQuery} : users.id;
        function selectedFields() {
          return flag
            ? { value: users.id }
            : { value: ${mappedScalarQuery} };
        }
        db.select({ value: selectedValue });
        db.select(selectedFields());
      `,
      errors: [
        { messageId: "structuredScalarQuery" },
        { messageId: "structuredScalarQuery" },
      ],
    },
  ],
} satisfies {
  invalid: readonly (RunTests<QueryBuilderMessageId, []>["invalid"][number] & {
    readonly legacyOverclaim?: true;
  })[];
  readInvalid: RunTests<QueryBuilderMessageId, []>["invalid"];
  readValid: RunTests<QueryBuilderMessageId, []>["valid"];
  writeValid: readonly (RunTests<QueryBuilderMessageId, []>["valid"][number] & {
    readonly descendantErrors?: readonly WriteDescendantError[];
  })[];
};

type ReadQueryMessageId =
  | "composedCteQueryBuilder"
  | "existsQueryBuilder"
  | "lockingQueryBuilder"
  | "queryBuilder"
  | "scalarCteQueryBuilder"
  | "structuredScalarQuery";

type QueryBuilderInvalidCase = (typeof queryBuilderCases.invalid)[number];
type ReadQueryCase = Extract<
  QueryBuilderInvalidCase,
  { errors: Array<{ messageId: ReadQueryMessageId }> }
>;
type WriteQueryCase = Exclude<QueryBuilderInvalidCase, ReadQueryCase>;
type WriteValidCase = (typeof queryBuilderCases.writeValid)[number];
type WriteDescendantCase = Extract<
  WriteValidCase,
  { descendantErrors: unknown }
>;

const READ_QUERY_MESSAGES = new Set<QueryBuilderMessageId>([
  "composedCteQueryBuilder",
  "existsQueryBuilder",
  "lockingQueryBuilder",
  "queryBuilder",
  "scalarCteQueryBuilder",
  "structuredScalarQuery",
]);

function isReadQueryCase(
  testCase: QueryBuilderInvalidCase,
): testCase is ReadQueryCase {
  return testCase.errors.some((error) => {
    return READ_QUERY_MESSAGES.has(error.messageId);
  });
}

function isWriteQueryCase(
  testCase: QueryBuilderInvalidCase,
): testCase is WriteQueryCase {
  return !isReadQueryCase(testCase);
}

function hasDescendantErrors(
  testCase: WriteValidCase,
): testCase is WriteDescendantCase {
  return "descendantErrors" in testCase;
}

function isRetiredWriteOverclaim(testCase: WriteQueryCase): boolean {
  return "legacyOverclaim" in testCase && testCase.legacyOverclaim === true;
}

export const queryBuilderWriteCases = {
  valid: [
    ...queryBuilderCases.writeValid
      .filter((testCase) => {
        return !hasDescendantErrors(testCase);
      })
      .map((testCase) => {
        return { code: testCase.code };
      }),
    ...queryBuilderCases.invalid
      .filter(isWriteQueryCase)
      .filter(isRetiredWriteOverclaim)
      .map((testCase) => {
        return { code: testCase.code };
      }),
  ],
  invalid: [
    ...queryBuilderCases.writeValid
      .filter(hasDescendantErrors)
      .map((testCase) => {
        return {
          code: testCase.code,
          errors: testCase.descendantErrors,
        };
      }),
    ...queryBuilderCases.invalid.filter(isWriteQueryCase).filter((testCase) => {
      return !isRetiredWriteOverclaim(testCase);
    }),
  ],
};

export const queryBuilderReadCases = {
  valid: queryBuilderCases.readValid,
  invalid: [
    ...queryBuilderCases.readInvalid,
    ...queryBuilderCases.invalid.filter(isReadQueryCase),
  ],
};
