import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";
import { usageEvent } from "@vm0/db/schema/usage-event";
import {
  VM0_MODEL_ALIAS_TO_MODEL,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/api-contracts/contracts/model-providers";

import { type Db, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";

const HOUR_MS = 60 * 60_000;
export const DEFAULT_MODEL_STATS_REPROCESS_HOURS = 24;
export const MAX_MODEL_STATS_REPROCESS_HOURS = 24 * 32;
export const MODEL_RANKING_PERIODS = ["today", "week", "month"] as const;
const MODEL_USAGE_KIND = "model";
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

interface RawModelRankingRow extends Record<string, unknown> {
  readonly model: string;
  readonly input_tokens: string | number | bigint;
  readonly output_tokens: string | number | bigint;
  readonly total_tokens: string | number | bigint;
  readonly previous_total_tokens: string | number | bigint;
}

function getModelAliasEntries() {
  return Object.entries(VM0_MODEL_ALIAS_TO_MODEL);
}

function getModelStatsModelIdSql() {
  return sql.join(
    [
      ...Object.keys(VM0_MODEL_TO_PROVIDER),
      ...Object.keys(VM0_MODEL_ALIAS_TO_MODEL),
    ].map((model) => {
      return sql`${model}`;
    }),
    sql`, `,
  );
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

function toNumber(value: string | number | bigint): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value);
}

function parseModelRankingPeriod(
  value: string | undefined,
): ModelRankingPeriod {
  if (value === "today" || value === "week" || value === "month") {
    return value;
  }
  return "week";
}

function usageEventModelExpression() {
  const providerColumn = sql.raw('"usage_event"."provider"');
  return sql<string>`CASE ${sql.join(
    getModelAliasEntries().map(([alias, model]) => {
      return sql`WHEN ${providerColumn} = ${alias} THEN ${model}`;
    }),
    sql` `,
  )} ELSE ${providerColumn} END`;
}

function modelStatModelExpression() {
  const modelColumn = sql.raw('"model_stat"."model"');
  return sql<string>`CASE ${sql.join(
    getModelAliasEntries().map(([alias, model]) => {
      return sql`WHEN ${modelColumn} = ${alias} THEN ${model}`;
    }),
    sql` `,
  )} ELSE ${modelColumn} END`;
}

async function replaceModelStats(
  db: Db,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const usageEventModelExpr = usageEventModelExpression();
  const modelStatsModelIdSql = getModelStatsModelIdSql();

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${windowStart}
        AND ${modelStat.hourStart} < ${windowEnd}
        AND ${modelStat.model} IN (${modelStatsModelIdSql})
    `);

    return tx.execute(sql`
      WITH usage_rows AS (
        SELECT
          date_trunc('hour', ${usageEvent.createdAt})::timestamp AS hour_start,
          ${usageEventModelExpr} AS model,
          ${usageEvent.orgId} AS org_id,
          ${usageEvent.userId} AS user_id,
          COALESCE(${usageEvent.runId}::text, ${usageEvent.idempotencyKey}::text) AS request_key,
          CASE WHEN ${usageEvent.category} = ${TOKEN_CATEGORY_INPUT}
            THEN ${usageEvent.quantity} ELSE 0 END::bigint AS input_tokens,
          CASE WHEN ${usageEvent.category} = ${TOKEN_CATEGORY_OUTPUT}
            THEN ${usageEvent.quantity} ELSE 0 END::bigint AS output_tokens,
          CASE WHEN ${usageEvent.category} = ${TOKEN_CATEGORY_CACHE_READ}
            THEN ${usageEvent.quantity} ELSE 0 END::bigint AS cache_read_input_tokens,
          CASE WHEN ${usageEvent.category} = ${TOKEN_CATEGORY_CACHE_CREATION}
            THEN ${usageEvent.quantity} ELSE 0 END::bigint AS cache_creation_input_tokens,
          COALESCE(${usageEvent.creditsCharged}, 0)::bigint AS credits_charged
        FROM ${usageEvent}
        WHERE ${usageEvent.createdAt} >= ${windowStart}
          AND ${usageEvent.createdAt} < ${windowEnd}
          AND ${usageEvent.kind} = ${MODEL_USAGE_KIND}
          AND ${usageEvent.provider} IN (${modelStatsModelIdSql})
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
  });

  return result.rowCount ?? 0;
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
  const currentModelStatsModelIdSql = getModelStatsModelIdSql();
  const previousModelStatsModelIdSql = getModelStatsModelIdSql();

  const result = await db.execute<RawModelRankingRow>(sql`
    WITH current_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.inputTokens} + ${modelStat.cacheReadInputTokens} + ${modelStat.cacheCreationInputTokens}), 0)::bigint AS input_tokens,
        COALESCE(SUM(${modelStat.outputTokens}), 0)::bigint AS output_tokens,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${window.start}
        AND ${modelStat.hourStart} < ${window.end}
        AND ${modelStat.model} IN (${currentModelStatsModelIdSql})
      GROUP BY 1
    ),
    previous_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS previous_total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${previousStart}
        AND ${modelStat.hourStart} < ${previousEnd}
        AND ${modelStat.model} IN (${previousModelStatsModelIdSql})
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
  `);

  const rows = result.rows.map((row) => {
    return {
      model: row.model,
      inputTokens: toNumber(row.input_tokens),
      outputTokens: toNumber(row.output_tokens),
      totalTokens: toNumber(row.total_tokens),
      previousTotalTokens: toNumber(row.previous_total_tokens),
    };
  });

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

    signal.throwIfAborted();
    const aggregated = await replaceModelStats(db, windowStart, windowEnd);
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
