import { command } from "ccstate";
import { and, eq, gte, inArray, lt, sql, sum } from "drizzle-orm";
import { CRON_AGGREGATE_MODEL_STATS_MAX_HOURS } from "@vm0/api-contracts/contracts/cron";
import { modelStat } from "@vm0/db/schema/model-stat";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";
import {
  VM0_MODEL_ALIAS_TO_MODEL,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/api-contracts/contracts/model-providers";
import { z } from "zod";

import {
  executeRawRows,
  pgInt8ToSafeIntegerSchema,
} from "../../lib/db-raw-rows";
import { type Db, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";

const HOUR_MS = 60 * 60_000;
export const DEFAULT_MODEL_STATS_REPROCESS_HOURS = 24;
const MAX_MODEL_STATS_REPROCESS_HOURS = CRON_AGGREGATE_MODEL_STATS_MAX_HOURS;
export const MODEL_RANKING_PERIODS = ["today", "week", "month"] as const;
const TOKEN_CATEGORY_INPUT = "tokens.input";
const TOKEN_CATEGORY_OUTPUT = "tokens.output";
const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";

type ModelRankingPeriod = (typeof MODEL_RANKING_PERIODS)[number];

interface ModelRankingRow {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly previousTotalTokens: number;
}

interface ModelRankingResult {
  readonly period: ModelRankingPeriod;
  readonly totalTokens: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly rows: readonly ModelRankingRow[];
}

const modelRankingSqlRowSchema = z
  .object({
    model: z.string(),
    input_tokens: pgInt8ToSafeIntegerSchema,
    output_tokens: pgInt8ToSafeIntegerSchema,
    total_tokens: pgInt8ToSafeIntegerSchema,
    previous_total_tokens: pgInt8ToSafeIntegerSchema,
  })
  .transform((row): ModelRankingRow => {
    return {
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      previousTotalTokens: row.previous_total_tokens,
    };
  });

function getModelAliasEntries() {
  return Object.entries(VM0_MODEL_ALIAS_TO_MODEL);
}

function getModelStatsModelIds(): string[] {
  return [
    ...Object.keys(VM0_MODEL_TO_PROVIDER),
    ...Object.keys(VM0_MODEL_ALIAS_TO_MODEL),
  ];
}

interface ModelStatsAggregationResult {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly aggregated: number;
}

function utcHourStart(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    ),
  );
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  const dayOfWeek = day.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return new Date(day.getTime() - daysSinceMonday * 24 * HOUR_MS);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function currentWindow(
  period: ModelRankingPeriod,
  now: Date,
): { start: Date; end: Date } {
  const end = utcHourStart(now);
  if (period === "today") {
    return { start: startOfUtcDay(now), end };
  }
  if (period === "month") {
    return { start: startOfUtcMonth(now), end };
  }
  return { start: startOfUtcWeek(now), end };
}

function utcTimestampParam(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function parseModelRankingPeriod(
  value: string | undefined,
): ModelRankingPeriod {
  if (value === "today" || value === "week" || value === "month") {
    return value;
  }
  return "week";
}

function modelUsageObservationModelExpression() {
  const modelColumn = modelUsageObservation.model;
  return sql`CASE ${sql.join(
    getModelAliasEntries().map(([alias, model]) => {
      return sql`WHEN ${eq(modelColumn, alias)} THEN ${model}`;
    }),
    sql` `,
  )} ELSE ${modelColumn} END`;
}

function modelStatModelExpression() {
  const modelColumn = modelStat.model;
  return sql`CASE ${sql.join(
    getModelAliasEntries().map(([alias, model]) => {
      return sql`WHEN ${eq(modelColumn, alias)} THEN ${model}`;
    }),
    sql` `,
  )} ELSE ${modelColumn} END`;
}

async function replaceModelStats(
  db: Db,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const observationModelExpr = modelUsageObservationModelExpression();
  const modelStatsModelIds = getModelStatsModelIds();
  const windowStartParam = utcTimestampParam(windowStart);
  const windowEndParam = utcTimestampParam(windowEnd);

  const insertedCount = await db.transaction(async (tx) => {
    await tx
      .delete(modelStat)
      .where(
        and(
          gte(modelStat.hourStart, sql`${windowStartParam}::timestamp`),
          lt(modelStat.hourStart, sql`${windowEndParam}::timestamp`),
          inArray(modelStat.model, modelStatsModelIds),
        ),
      );

    const { rowCount } = await tx.execute(sql`
      WITH usage_rows AS (
        SELECT
          date_trunc('hour', ${modelUsageObservation.observedAt})::timestamp AS hour_start,
          ${observationModelExpr} AS model,
          ${modelUsageObservation.orgId} AS org_id,
          ${modelUsageObservation.userId} AS user_id,
          COALESCE(${modelUsageObservation.runId}::text, ${modelUsageObservation.idempotencyKey}::text) AS request_key,
          CASE WHEN ${eq(modelUsageObservation.category, TOKEN_CATEGORY_INPUT)}
            THEN ${modelUsageObservation.quantity} ELSE 0 END::bigint AS input_tokens,
          CASE WHEN ${eq(modelUsageObservation.category, TOKEN_CATEGORY_OUTPUT)}
            THEN ${modelUsageObservation.quantity} ELSE 0 END::bigint AS output_tokens,
          CASE WHEN ${eq(modelUsageObservation.category, TOKEN_CATEGORY_CACHE_READ)}
            THEN ${modelUsageObservation.quantity} ELSE 0 END::bigint AS cache_read_input_tokens,
          CASE WHEN ${eq(modelUsageObservation.category, TOKEN_CATEGORY_CACHE_CREATION)}
            THEN ${modelUsageObservation.quantity} ELSE 0 END::bigint AS cache_creation_input_tokens,
          0::bigint AS credits_charged
        FROM ${modelUsageObservation}
        WHERE ${gte(modelUsageObservation.observedAt, sql`${windowStartParam}::timestamp`)}
          AND ${lt(modelUsageObservation.observedAt, sql`${windowEndParam}::timestamp`)}
          AND ${inArray(modelUsageObservation.model, modelStatsModelIds)}
          AND ${modelUsageObservation.category} IN (
            ${TOKEN_CATEGORY_INPUT},
            ${TOKEN_CATEGORY_OUTPUT},
            ${TOKEN_CATEGORY_CACHE_READ},
            ${TOKEN_CATEGORY_CACHE_CREATION}
          )
          AND ${modelUsageObservation.quantity} > 0
      ),
      aggregated AS (
        SELECT
          hour_start,
          model,
          COUNT(DISTINCT request_key)::bigint AS request_count,
          COUNT(DISTINCT org_id)::int AS org_count,
          COUNT(DISTINCT user_id)::int AS user_count,
          COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
          COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_input_tokens,
          COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_creation_input_tokens,
          (
            COALESCE(SUM(input_tokens), 0)
            + COALESCE(SUM(output_tokens), 0)
            + COALESCE(SUM(cache_read_input_tokens), 0)
            + COALESCE(SUM(cache_creation_input_tokens), 0)
          )::bigint AS total_tokens,
          COALESCE(SUM(credits_charged), 0)::bigint AS credits_charged
        FROM usage_rows
        WHERE model <> ''
        GROUP BY hour_start, model
      )
      INSERT INTO ${modelStat} (
        "hour_start",
        "model",
        "model_provider",
        "request_count",
        "org_count",
        "user_count",
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "total_tokens",
        "credits_charged"
      )
      SELECT
        hour_start,
        model,
        ''::varchar(100) AS model_provider,
        request_count,
        org_count,
        user_count,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_tokens,
        credits_charged
      FROM aggregated
      ON CONFLICT (hour_start, model, model_provider) DO UPDATE SET
        request_count = EXCLUDED.request_count,
        org_count = EXCLUDED.org_count,
        user_count = EXCLUDED.user_count,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
        cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
        total_tokens = EXCLUDED.total_tokens,
        credits_charged = EXCLUDED.credits_charged,
        updated_at = NOW()
      RETURNING id
    `);
    return rowCount ?? 0;
  });

  return insertedCount;
}

async function deleteExpiredModelUsageObservations(
  db: Db,
  retentionStart: Date,
): Promise<void> {
  await db
    .delete(modelUsageObservation)
    .where(lt(modelUsageObservation.observedAt, retentionStart));
}

async function selectModelRankings(
  db: Db,
  period: ModelRankingPeriod,
): Promise<ModelRankingResult> {
  const window = currentWindow(period, nowDate());
  const duration = Math.max(window.end.getTime() - window.start.getTime(), 0);
  const previousEnd = window.start;
  const previousStart = new Date(previousEnd.getTime() - duration);
  const modelExpr = modelStatModelExpression();
  const modelStatsModelIds = getModelStatsModelIds();
  const windowStartParam = utcTimestampParam(window.start);
  const windowEndParam = utcTimestampParam(window.end);
  const previousStartParam = utcTimestampParam(previousStart);
  const previousEndParam = utcTimestampParam(previousEnd);

  const rows = await executeRawRows(
    db,
    sql`
      WITH current_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.inputTokens} + ${modelStat.cacheReadInputTokens} + ${modelStat.cacheCreationInputTokens}), 0)::bigint AS input_tokens,
        COALESCE(${sum(modelStat.outputTokens)}, 0)::bigint AS output_tokens,
        COALESCE(${sum(modelStat.totalTokens)}, 0)::bigint AS total_tokens
      FROM ${modelStat}
      WHERE ${gte(modelStat.hourStart, sql`${windowStartParam}::timestamp`)}
        AND ${lt(modelStat.hourStart, sql`${windowEndParam}::timestamp`)}
        AND ${inArray(modelStat.model, modelStatsModelIds)}
      GROUP BY 1
    ),
    previous_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(${sum(modelStat.totalTokens)}, 0)::bigint AS previous_total_tokens
      FROM ${modelStat}
      WHERE ${gte(modelStat.hourStart, sql`${previousStartParam}::timestamp`)}
        AND ${lt(modelStat.hourStart, sql`${previousEndParam}::timestamp`)}
        AND ${inArray(modelStat.model, modelStatsModelIds)}
      GROUP BY 1
    )
    SELECT
      current_period.model,
      current_period.input_tokens,
      current_period.output_tokens,
      current_period.total_tokens,
      COALESCE(previous_period.previous_total_tokens, 0)::bigint AS previous_total_tokens
    FROM current_period
    LEFT JOIN previous_period ON previous_period.model = current_period.model
    WHERE current_period.total_tokens > 0
    ORDER BY current_period.total_tokens DESC
      LIMIT 50
    `,
    modelRankingSqlRowSchema,
  );

  return {
    period,
    totalTokens: rows.reduce((sum, row) => {
      return sum + row.totalTokens;
    }, 0),
    windowStart: window.start,
    windowEnd: window.end,
    rows,
  };
}

export const aggregateModelStats$ = command(
  async (
    { set },
    hours: number,
    signal: AbortSignal,
  ): Promise<ModelStatsAggregationResult> => {
    const db = set(writeDb$);
    const windowEnd = utcHourStart(nowDate());
    const windowStart = new Date(windowEnd.getTime() - hours * HOUR_MS);
    const retentionStart = new Date(
      windowEnd.getTime() - MAX_MODEL_STATS_REPROCESS_HOURS * HOUR_MS,
    );

    signal.throwIfAborted();
    const aggregated = await replaceModelStats(db, windowStart, windowEnd);
    signal.throwIfAborted();
    await deleteExpiredModelUsageObservations(db, retentionStart);
    signal.throwIfAborted();

    return {
      windowStart,
      windowEnd,
      aggregated,
    };
  },
);

export const readPublicModelRankings$ = command(
  async (
    { set },
    periodValue: string | undefined,
    signal: AbortSignal,
  ): Promise<ModelRankingResult> => {
    const db = set(writeDb$);
    const period = parseModelRankingPeriod(periodValue);

    signal.throwIfAborted();
    const result = await selectModelRankings(db, period);
    signal.throwIfAborted();

    return result;
  },
);
