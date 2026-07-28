import { browserSessionInstances } from "@vm0/db/schema/browser-session";
import { usageAllowanceAllocations } from "@vm0/db/schema/org-usage-allowance";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usageEventHourlyRollup } from "@vm0/db/schema/usage-event-hourly-rollup";
import { command } from "ccstate";
import { count, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  executeRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { timestampWithoutTimeZone } from "../external/time";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

const L = logger("CronCompactUsageEvents");
const DEFAULT_USAGE_EVENT_COMPACTION_BATCH_SIZE = 100;

type UsageEventCompactionDb = Pick<Db, "execute" | "transaction">;

interface UsageEventCompactionStats {
  readonly cutoff: string;
  readonly batchSize: number;
  readonly candidateGrains: number;
  readonly selectedGrains: number;
  readonly probedRawRows: number;
  readonly browserHeldRows: number;
  readonly billingErrorHeldRows: number;
  readonly rawRowsDeleted: number;
  readonly hourlyRowsDeleted: number;
  readonly duplicateHourlyRowsDeleted: number;
  readonly hourlyRowsInserted: number;
  readonly quantity: string;
  readonly creditsCharged: string;
  readonly allowanceUnits: string;
  readonly affectedShortWindows: number;
  readonly affectedWeeklyWindows: number;
  readonly reconciled: boolean;
  readonly hasMore: boolean;
  readonly lockWaitMs: number;
  readonly durationMs: number;
}

const integerTextSchema = z.string().regex(/^-?\d+$/);

const cutoffRowSchema = z.object({
  cutoff: pgTimestampWithoutTimezoneToDateSchema,
});

const holdProbeRowSchema = z.object({
  probedRawRows: z.int(),
  browserHeldRows: z.int(),
  billingErrorHeldRows: z.int(),
});

const compactionRowSchema = z.object({
  candidateGrains: z.int(),
  selectedGrains: z.int(),
  rawRowsDeleted: z.int(),
  hourlyRowsDeleted: z.int(),
  duplicateHourlyRowsDeleted: z.int(),
  hourlyRowsInserted: z.int(),
  quantity: integerTextSchema,
  creditsCharged: integerTextSchema,
  allowanceUnits: integerTextSchema,
  affectedShortWindows: z.int(),
  affectedWeeklyWindows: z.int(),
  reconciled: z.boolean(),
  hasMoreHourlyDuplicates: z.boolean(),
});

const remainingRawRowSchema = z.object({
  hasMoreRaw: z.boolean(),
});

function usageEventCompactionBatchSize(): number {
  const raw = optionalEnv("USAGE_EVENT_COMPACTION_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_USAGE_EVENT_COMPACTION_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "USAGE_EVENT_COMPACTION_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

function eligibleRawPredicate(cutoff: string): SQL {
  return sql`
    event.status = 'processed'
    AND event.processed_at IS NOT NULL
    AND event.processed_at < ${cutoff}::timestamp
    AND event.billing_error IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM ${browserSessionInstances} browser
      WHERE browser.provider_session_id = event.idempotency_key
        AND browser.settled_at IS NULL
    )
  `;
}

function physicalGrainMatch(leftAlias: string, rightAlias: string): SQL {
  const left = sql.identifier(leftAlias);
  const right = sql.identifier(rightAlias);
  return sql`
    ${left}.processed_hour = ${right}.processed_hour
    AND ${left}.org_id = ${right}.org_id
    AND ${left}.user_id = ${right}.user_id
    AND ${left}.run_id IS NOT DISTINCT FROM ${right}.run_id
    AND ${left}.kind = ${right}.kind
    AND ${left}.provider = ${right}.provider
    AND ${left}.category = ${right}.category
    AND ${left}.short_window_id IS NOT DISTINCT FROM ${right}.short_window_id
    AND ${left}.weekly_window_id IS NOT DISTINCT FROM ${right}.weekly_window_id
  `;
}

function physicalGrainColumns(alias: string): SQL {
  const source = sql.identifier(alias);
  return sql`
    ${source}.processed_hour,
    ${source}.org_id,
    ${source}.user_id,
    ${source}.run_id,
    ${source}.kind,
    ${source}.provider,
    ${source}.category,
    ${source}.short_window_id,
    ${source}.weekly_window_id
  `;
}

function physicalGrainOrder(alias: string): SQL {
  const source = sql.identifier(alias);
  return sql`
    ${source}.processed_hour ASC,
    ${source}.org_id ASC,
    ${source}.user_id ASC,
    ${source}.run_id ASC NULLS FIRST,
    ${source}.kind ASC,
    ${source}.provider ASC,
    ${source}.category ASC,
    ${source}.short_window_id ASC NULLS FIRST,
    ${source}.weekly_window_id ASC NULLS FIRST
  `;
}

function candidateCtes(args: {
  readonly cutoff: string;
  readonly batchSize: number;
}): SQL {
  const duplicateCandidateLimit = args.batchSize + 1;
  return sql`
    raw_seed AS MATERIALIZED (
      SELECT
        event.id,
        date_trunc('hour', event.processed_at)::timestamp AS processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        event.kind,
        event.provider,
        event.category,
        allocation.short_window_id,
        allocation.weekly_window_id
      FROM ${usageEvent} event
      LEFT JOIN ${usageAllowanceAllocations} allocation
        ON allocation.usage_event_id = event.id
      WHERE ${eligibleRawPredicate(args.cutoff)}
      ORDER BY event.processed_at ASC, event.id ASC
      LIMIT ${args.batchSize}
      FOR UPDATE OF event
    ),
    raw_seed_grains AS MATERIALIZED (
      SELECT DISTINCT ${physicalGrainColumns("raw_seed")}
      FROM raw_seed
    ),
    hourly_duplicate_candidates AS MATERIALIZED (
      SELECT
        hourly.processed_hour,
        hourly.org_id,
        hourly.user_id,
        hourly.run_id,
        hourly.kind,
        hourly.provider,
        hourly.category,
        hourly.short_window_id,
        hourly.weekly_window_id
      FROM ${usageEventHourlyRollup} hourly
      GROUP BY ${physicalGrainColumns("hourly")}
      HAVING ${count()} > 1
      ORDER BY
        hourly.processed_hour ASC,
        hourly.org_id ASC,
        hourly.user_id ASC,
        hourly.run_id ASC NULLS FIRST,
        hourly.kind ASC,
        hourly.provider ASC,
        hourly.category ASC,
        hourly.short_window_id ASC NULLS FIRST,
        hourly.weekly_window_id ASC NULLS FIRST
      LIMIT ${duplicateCandidateLimit}
    ),
    dirty_candidates AS MATERIALIZED (
      SELECT ${physicalGrainColumns("raw_seed_grains")}
      FROM raw_seed_grains

      UNION

      SELECT ${physicalGrainColumns("hourly_duplicate_candidates")}
      FROM hourly_duplicate_candidates
    ),
    selected_grains AS MATERIALIZED (
      SELECT ${physicalGrainColumns("dirty_candidates")}
      FROM dirty_candidates
      ORDER BY ${physicalGrainOrder("dirty_candidates")}
      LIMIT ${args.batchSize}
    )
  `;
}

function lockedSourceCtes(cutoff: string): SQL {
  return sql`
    locked_raw_events AS MATERIALIZED (
      SELECT
        event.id,
        grain.processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        event.kind,
        event.provider,
        event.category,
        grain.short_window_id,
        grain.weekly_window_id,
        event.quantity,
        COALESCE(event.credits_charged, 0)::bigint AS credits_charged
      FROM selected_grains grain
      INNER JOIN ${usageEvent} event
        ON event.processed_at >= grain.processed_hour
       AND event.processed_at < grain.processed_hour + interval '1 hour'
       AND event.org_id = grain.org_id
       AND event.user_id = grain.user_id
       AND event.run_id IS NOT DISTINCT FROM grain.run_id
       AND event.kind = grain.kind
       AND event.provider = grain.provider
       AND event.category = grain.category
      LEFT JOIN ${usageAllowanceAllocations} allocation
        ON allocation.usage_event_id = event.id
      WHERE ${eligibleRawPredicate(cutoff)}
        AND allocation.short_window_id IS NOT DISTINCT FROM grain.short_window_id
        AND allocation.weekly_window_id IS NOT DISTINCT FROM grain.weekly_window_id
      FOR UPDATE OF event
    ),
    locked_raw_allocations AS MATERIALIZED (
      SELECT
        allocation.usage_event_id,
        allocation.units_applied
      FROM locked_raw_events event
      INNER JOIN ${usageAllowanceAllocations} allocation
        ON allocation.usage_event_id = event.id
      FOR UPDATE OF allocation
    ),
    locked_raw AS MATERIALIZED (
      SELECT
        event.id,
        event.processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        event.kind,
        event.provider,
        event.category,
        event.short_window_id,
        event.weekly_window_id,
        event.quantity,
        event.credits_charged,
        COALESCE(allocation.units_applied, 0)::bigint AS allowance_units
      FROM locked_raw_events event
      LEFT JOIN locked_raw_allocations allocation
        ON allocation.usage_event_id = event.id
    ),
    locked_hourly AS MATERIALIZED (
      SELECT
        hourly.id,
        hourly.processed_hour,
        hourly.org_id,
        hourly.user_id,
        hourly.run_id,
        hourly.kind,
        hourly.provider,
        hourly.category,
        hourly.short_window_id,
        hourly.weekly_window_id,
        hourly.quantity,
        hourly.credits_charged,
        hourly.allowance_units
      FROM selected_grains grain
      INNER JOIN ${usageEventHourlyRollup} hourly
        ON ${physicalGrainMatch("hourly", "grain")}
      FOR UPDATE OF hourly
    ),
    source_facts AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("locked_raw")},
        locked_raw.quantity::numeric AS quantity,
        locked_raw.credits_charged::numeric AS credits_charged,
        locked_raw.allowance_units::numeric AS allowance_units
      FROM locked_raw

      UNION ALL

      SELECT
        ${physicalGrainColumns("locked_hourly")},
        locked_hourly.quantity::numeric AS quantity,
        locked_hourly.credits_charged::numeric AS credits_charged,
        locked_hourly.allowance_units::numeric AS allowance_units
      FROM locked_hourly
    ),
    consolidated AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("source_facts")},
        SUM(source_facts.quantity) AS quantity,
        SUM(source_facts.credits_charged) AS credits_charged,
        SUM(source_facts.allowance_units) AS allowance_units
      FROM source_facts
      GROUP BY ${physicalGrainColumns("source_facts")}
    ),
    locked_hourly_grain_counts AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("locked_hourly")},
        ${count()}::int AS row_count
      FROM locked_hourly
      GROUP BY ${physicalGrainColumns("locked_hourly")}
    )
  `;
}

function mutationCtes(): SQL {
  return sql`
    deleted_hourly AS (
      DELETE FROM ${usageEventHourlyRollup} hourly
      USING locked_hourly
      WHERE hourly.id = locked_hourly.id
      RETURNING hourly.id
    ),
    inserted_hourly AS (
      INSERT INTO ${usageEventHourlyRollup} (
        processed_hour,
        org_id,
        user_id,
        run_id,
        kind,
        provider,
        category,
        short_window_id,
        weekly_window_id,
        quantity,
        credits_charged,
        allowance_units
      )
      SELECT
        ${physicalGrainColumns("consolidated")},
        consolidated.quantity,
        consolidated.credits_charged,
        consolidated.allowance_units
      FROM consolidated
      RETURNING
        processed_hour,
        org_id,
        user_id,
        run_id,
        kind,
        provider,
        category,
        short_window_id,
        weekly_window_id,
        quantity,
        credits_charged,
        allowance_units
    ),
    deleted_raw AS (
      DELETE FROM ${usageEvent} event
      USING locked_raw
      WHERE event.id = locked_raw.id
      RETURNING event.id
    )
  `;
}

function productTotalCtes(): SQL {
  return sql`
    source_totals AS (
      SELECT
        COALESCE(SUM(quantity), 0)::numeric AS quantity,
        COALESCE(SUM(credits_charged), 0)::numeric AS credits_charged,
        COALESCE(SUM(allowance_units), 0)::numeric AS allowance_units
      FROM source_facts
    ),
    inserted_totals AS (
      SELECT
        COALESCE(SUM(quantity), 0)::numeric AS quantity,
        COALESCE(SUM(credits_charged), 0)::numeric AS credits_charged,
        COALESCE(SUM(allowance_units), 0)::numeric AS allowance_units
      FROM inserted_hourly
    )
  `;
}

function windowTotalCtes(): SQL {
  return sql`
    source_window_totals AS (
      SELECT
        source_windows.window_kind,
        source_windows.window_id,
        SUM(source_windows.allowance_units)::numeric AS allowance_units
      FROM (
        SELECT
          'short'::text AS window_kind,
          source_facts.short_window_id AS window_id,
          source_facts.allowance_units
        FROM source_facts
        WHERE source_facts.allowance_units > 0

        UNION ALL

        SELECT
          'weekly'::text AS window_kind,
          source_facts.weekly_window_id AS window_id,
          source_facts.allowance_units
        FROM source_facts
        WHERE source_facts.allowance_units > 0
      ) source_windows
      GROUP BY source_windows.window_kind, source_windows.window_id
    ),
    inserted_window_totals AS (
      SELECT
        inserted_windows.window_kind,
        inserted_windows.window_id,
        SUM(inserted_windows.allowance_units)::numeric AS allowance_units
      FROM (
        SELECT
          'short'::text AS window_kind,
          inserted_hourly.short_window_id AS window_id,
          inserted_hourly.allowance_units
        FROM inserted_hourly
        WHERE inserted_hourly.allowance_units > 0

        UNION ALL

        SELECT
          'weekly'::text AS window_kind,
          inserted_hourly.weekly_window_id AS window_id,
          inserted_hourly.allowance_units
        FROM inserted_hourly
        WHERE inserted_hourly.allowance_units > 0
      ) inserted_windows
      GROUP BY inserted_windows.window_kind, inserted_windows.window_id
    )
  `;
}

function windowReconciliationCte(): SQL {
  return sql`
    window_reconciliation AS (
      SELECT
        ${count()} FILTER (
          WHERE COALESCE(source_windows.window_kind, inserted_windows.window_kind) = 'short'
        )::int AS short_windows,
        ${count()} FILTER (
          WHERE COALESCE(source_windows.window_kind, inserted_windows.window_kind) = 'weekly'
        )::int AS weekly_windows,
        COALESCE(
          BOOL_AND(
            COALESCE(source_windows.allowance_units, 0)
              = COALESCE(inserted_windows.allowance_units, 0)
          ),
          true
        ) AS reconciled
      FROM source_window_totals source_windows
      FULL OUTER JOIN inserted_window_totals inserted_windows
        ON inserted_windows.window_kind = source_windows.window_kind
       AND inserted_windows.window_id = source_windows.window_id
    )
  `;
}

function compactionSummarySelect(): SQL {
  return sql`
    SELECT
      (SELECT ${count()}::int FROM dirty_candidates) AS "candidateGrains",
      (SELECT ${count()}::int FROM selected_grains) AS "selectedGrains",
      (SELECT ${count()}::int FROM deleted_raw) AS "rawRowsDeleted",
      (SELECT ${count()}::int FROM deleted_hourly) AS "hourlyRowsDeleted",
      (
        SELECT COALESCE(SUM(GREATEST(row_count - 1, 0)), 0)::int
        FROM locked_hourly_grain_counts
      ) AS "duplicateHourlyRowsDeleted",
      (SELECT ${count()}::int FROM inserted_hourly) AS "hourlyRowsInserted",
      source_totals.quantity::text AS "quantity",
      source_totals.credits_charged::text AS "creditsCharged",
      source_totals.allowance_units::text AS "allowanceUnits",
      window_reconciliation.short_windows AS "affectedShortWindows",
      window_reconciliation.weekly_windows AS "affectedWeeklyWindows",
      (
        source_totals.quantity = inserted_totals.quantity
        AND source_totals.credits_charged = inserted_totals.credits_charged
        AND source_totals.allowance_units = inserted_totals.allowance_units
        AND window_reconciliation.reconciled
        AND (SELECT ${count()} FROM locked_raw)
          = (SELECT ${count()} FROM deleted_raw)
        AND (SELECT ${count()} FROM locked_hourly)
          = (SELECT ${count()} FROM deleted_hourly)
        AND (SELECT ${count()} FROM selected_grains)
          = (SELECT ${count()} FROM inserted_hourly)
      ) AS "reconciled",
      EXISTS (
        SELECT 1
        FROM hourly_duplicate_candidates duplicate_candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM selected_grains selected
          WHERE ${physicalGrainMatch("duplicate_candidate", "selected")}
        )
      ) AS "hasMoreHourlyDuplicates"
    FROM source_totals
    CROSS JOIN inserted_totals
    CROSS JOIN window_reconciliation
  `;
}

function compactUsageEventsSql(args: {
  readonly cutoff: string;
  readonly batchSize: number;
}): SQL {
  return sql`
    WITH
    ${candidateCtes(args)},
    ${lockedSourceCtes(args.cutoff)},
    ${mutationCtes()},
    ${productTotalCtes()},
    ${windowTotalCtes()},
    ${windowReconciliationCte()}
    ${compactionSummarySelect()}
  `;
}

async function loadCompactionCutoff(db: Pick<Db, "execute">): Promise<Date> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT (
        date_trunc('hour', timezone('UTC', statement_timestamp()))
        - interval '1 hour'
      )::timestamp AS cutoff
    `,
    cutoffRowSchema,
  );
  const cutoff = rows[0]?.cutoff;
  if (!cutoff) {
    throw new Error("Usage event compaction cutoff query returned no row");
  }
  return cutoff;
}

async function loadHoldProbe(
  db: Pick<Db, "execute">,
  cutoff: string,
  batchSize: number,
): Promise<z.output<typeof holdProbeRowSchema>> {
  const rows = await executeRawRows(
    db,
    sql`
      WITH probed AS MATERIALIZED (
        SELECT
          event.billing_error,
          EXISTS (
            SELECT 1
            FROM ${browserSessionInstances} browser
            WHERE browser.provider_session_id = event.idempotency_key
              AND browser.settled_at IS NULL
          ) AS browser_held
        FROM ${usageEvent} event
        WHERE event.status = 'processed'
          AND event.processed_at IS NOT NULL
          AND event.processed_at < ${cutoff}::timestamp
        ORDER BY event.processed_at ASC, event.id ASC
        LIMIT ${batchSize}
      )
      SELECT
        ${count()}::int AS "probedRawRows",
        ${count()} FILTER (WHERE browser_held)::int AS "browserHeldRows",
        ${count()} FILTER (WHERE billing_error IS NOT NULL)::int
          AS "billingErrorHeldRows"
      FROM probed
    `,
    holdProbeRowSchema,
  );
  return (
    rows[0] ?? {
      probedRawRows: 0,
      browserHeldRows: 0,
      billingErrorHeldRows: 0,
    }
  );
}

async function hasRemainingRawUsage(
  db: Pick<Db, "execute">,
  cutoff: string,
): Promise<boolean> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT EXISTS (
        SELECT 1
        FROM ${usageEvent} event
        WHERE ${eligibleRawPredicate(cutoff)}
        LIMIT 1
      ) AS "hasMoreRaw"
    `,
    remainingRawRowSchema,
  );
  return rows[0]?.hasMoreRaw ?? false;
}

async function compactUsageEventBatch(
  db: UsageEventCompactionDb,
  signal: AbortSignal,
): Promise<Omit<UsageEventCompactionStats, "durationMs">> {
  const batchSize = usageEventCompactionBatchSize();
  return await db.transaction(async (tx) => {
    const lockStartedAt = performance.now();
    await lockUsageEventCompaction(tx);
    const lockWaitMs = Math.round(performance.now() - lockStartedAt);
    signal.throwIfAborted();

    const cutoffDate = await loadCompactionCutoff(tx);
    const cutoff = timestampWithoutTimeZone(cutoffDate);
    const holdProbe = await loadHoldProbe(tx, cutoff, batchSize);
    const rows = await executeRawRows(
      tx,
      compactUsageEventsSql({ cutoff, batchSize }),
      compactionRowSchema,
    );
    const compacted = rows[0];
    if (!compacted) {
      throw new Error("Usage event compaction returned no summary row");
    }
    if (!compacted.reconciled) {
      L.error("usage event compaction reconciliation failed", {
        cutoff: cutoffDate.toISOString(),
        batchSize,
        candidateGrains: compacted.candidateGrains,
        selectedGrains: compacted.selectedGrains,
        rawRowsDeleted: compacted.rawRowsDeleted,
        hourlyRowsDeleted: compacted.hourlyRowsDeleted,
        hourlyRowsInserted: compacted.hourlyRowsInserted,
      });
      throw new Error("Usage event compaction reconciliation failed");
    }
    signal.throwIfAborted();
    const hasMoreRaw = await hasRemainingRawUsage(tx, cutoff);
    signal.throwIfAborted();

    return {
      cutoff: cutoffDate.toISOString(),
      batchSize,
      candidateGrains: compacted.candidateGrains,
      selectedGrains: compacted.selectedGrains,
      probedRawRows: holdProbe.probedRawRows,
      browserHeldRows: holdProbe.browserHeldRows,
      billingErrorHeldRows: holdProbe.billingErrorHeldRows,
      rawRowsDeleted: compacted.rawRowsDeleted,
      hourlyRowsDeleted: compacted.hourlyRowsDeleted,
      duplicateHourlyRowsDeleted: compacted.duplicateHourlyRowsDeleted,
      hourlyRowsInserted: compacted.hourlyRowsInserted,
      quantity: compacted.quantity,
      creditsCharged: compacted.creditsCharged,
      allowanceUnits: compacted.allowanceUnits,
      affectedShortWindows: compacted.affectedShortWindows,
      affectedWeeklyWindows: compacted.affectedWeeklyWindows,
      reconciled: compacted.reconciled,
      hasMore: hasMoreRaw || compacted.hasMoreHourlyDuplicates,
      lockWaitMs,
    };
  });
}

export const compactUsageEvents$ = command(
  async ({ set }, signal: AbortSignal): Promise<UsageEventCompactionStats> => {
    const startedAt = performance.now();
    const result = await compactUsageEventBatch(set(writeDb$), signal);
    const stats = {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    };
    const sourceRows = stats.rawRowsDeleted + stats.hourlyRowsDeleted;
    L.debug("usage event compaction completed", {
      ...stats,
      sourceRows,
      compressionRatio:
        stats.hourlyRowsInserted === 0
          ? null
          : sourceRows / stats.hourlyRowsInserted,
    });
    return stats;
  },
);
