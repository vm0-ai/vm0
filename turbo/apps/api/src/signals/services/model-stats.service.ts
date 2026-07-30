import { command } from "ccstate";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  min,
  or,
  sql,
  sum,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";
import {
  VM0_MODEL_ALIAS_TO_MODEL,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/api-contracts/contracts/model-providers";
import { z } from "zod";

import {
  executeRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import {
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { type Db, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { lockModelStatsAggregation } from "./model-stats-aggregation-lock.service";

const HOUR_MS = 60 * 60_000;
export const DEFAULT_MODEL_STATS_REPROCESS_HOURS = 24;
export const MODEL_RANKING_PERIODS = ["today", "week", "month"] as const;

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

const modelStatsAggregationRowSchema = z.object({
  windowStart: pgTimestampWithoutTimezoneToDateSchema,
  windowEnd: pgTimestampWithoutTimezoneToDateSchema,
  aggregated: z.int().nonnegative(),
  markedObservations: z.int().nonnegative(),
  deleted: z.int().nonnegative(),
});

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
  )} ELSE ${modelColumn} END`.mapWith(pgTextDecoder);
}

function modelStatWindowSum(
  value: SQLWrapper,
  hourStart: SQLWrapper,
  start: string,
  end: string,
) {
  return sql`COALESCE(
    ${sum(value)} FILTER (
      WHERE ${and(
        gte(hourStart, sql`${start}::timestamp`),
        lt(hourStart, sql`${end}::timestamp`),
      )}
    ),
    0
  )::bigint`.mapWith(pgInt8ToSafeIntegerDecoder);
}

interface ModelStatsAggregationSqlArgs {
  readonly modelStatsModelIds: string[];
  readonly observationModelExpr: SQLWrapper;
  readonly preparedAt: string;
  readonly requestedWindowStart: string;
  readonly windowEnd: string;
}

function modelStatsSourceCtes(args: ModelStatsAggregationSqlArgs): SQL {
  return sql`
    oldest_pending AS MATERIALIZED (
        SELECT
          ${min(modelUsageObservation.observedAt)} AS oldest_observed_at
        FROM ${modelUsageObservation}
        WHERE ${and(
          isNull(modelUsageObservation.aggregatedAt),
          lt(
            modelUsageObservation.observedAt,
            sql`${args.windowEnd}::timestamp`,
          ),
        )}
      ),
      bounds AS MATERIALIZED (
        SELECT
          LEAST(
            ${args.requestedWindowStart}::timestamp,
            COALESCE(
              date_trunc('hour', oldest_pending.oldest_observed_at)::timestamp,
              ${args.requestedWindowStart}::timestamp
            )
          )::timestamp AS window_start,
          ${args.windowEnd}::timestamp AS window_end
        FROM oldest_pending
      ),
      usage_rows AS MATERIALIZED (
        SELECT
          date_trunc('hour', ${modelUsageObservation.observedAt})::timestamp AS hour_start,
          ${args.observationModelExpr} AS model,
          ${modelUsageObservation.inputTokens}::bigint AS input_tokens,
          ${modelUsageObservation.outputTokens}::bigint AS output_tokens,
          ${modelUsageObservation.cacheReadInputTokens}::bigint AS cache_read_input_tokens,
          ${modelUsageObservation.cacheCreationInputTokens}::bigint AS cache_creation_input_tokens
        FROM ${modelUsageObservation}
        CROSS JOIN bounds
        WHERE ${and(
          gte(modelUsageObservation.observedAt, sql`bounds.window_start`),
          lt(modelUsageObservation.observedAt, sql`bounds.window_end`),
          inArray(modelUsageObservation.model, args.modelStatsModelIds),
          or(
            gt(modelUsageObservation.inputTokens, sql`0`),
            gt(modelUsageObservation.outputTokens, sql`0`),
            gt(modelUsageObservation.cacheReadInputTokens, sql`0`),
            gt(modelUsageObservation.cacheCreationInputTokens, sql`0`),
          ),
        )}
      ),
      aggregated AS (
        SELECT
          hour_start,
          model,
          COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
          COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_input_tokens,
          COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_creation_input_tokens,
          (
            COALESCE(SUM(input_tokens), 0)
            + COALESCE(SUM(output_tokens), 0)
            + COALESCE(SUM(cache_read_input_tokens), 0)
            + COALESCE(SUM(cache_creation_input_tokens), 0)
          )::bigint AS total_tokens
        FROM usage_rows
        WHERE model <> ''
        GROUP BY hour_start, model
      )
  `;
}

function modelStatsMutationCtes(args: ModelStatsAggregationSqlArgs): SQL {
  return sql`
    upserted_stats AS (
        INSERT INTO ${modelStat} (
          "hour_start",
          "model",
          "input_tokens",
          "output_tokens",
          "cache_read_input_tokens",
          "cache_creation_input_tokens",
          "total_tokens"
        )
        SELECT
          hour_start,
          model,
          input_tokens,
          output_tokens,
          cache_read_input_tokens,
          cache_creation_input_tokens,
          total_tokens
        FROM aggregated
        ON CONFLICT (hour_start, model) DO UPDATE SET
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
          cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
          total_tokens = EXCLUDED.total_tokens,
          updated_at = NOW()
        RETURNING id
      ),
      deleted_stats AS (
        DELETE FROM ${modelStat}
        USING bounds
        WHERE
          ${and(
            gte(modelStat.hourStart, sql`bounds.window_start`),
            lt(modelStat.hourStart, sql`bounds.window_end`),
            inArray(modelStat.model, args.modelStatsModelIds),
          )}
          AND NOT EXISTS (
            SELECT 1
            FROM aggregated
            WHERE
              aggregated.hour_start = ${modelStat.hourStart}
              AND aggregated.model = ${modelStat.model}
          )
        RETURNING ${modelStat.id}
      ),
      marked_observations AS (
        UPDATE ${modelUsageObservation}
        SET aggregated_at = ${args.preparedAt}::timestamp
        FROM bounds
        WHERE ${and(
          isNull(modelUsageObservation.aggregatedAt),
          gte(modelUsageObservation.observedAt, sql`bounds.window_start`),
          lt(modelUsageObservation.observedAt, sql`bounds.window_end`),
        )}
        RETURNING ${modelUsageObservation.idempotencyKey}
      )
  `;
}

function modelStatsAggregationSql(args: ModelStatsAggregationSqlArgs): SQL {
  return sql`
    WITH
    ${modelStatsSourceCtes(args)},
    ${modelStatsMutationCtes(args)}
    SELECT
      bounds.window_start AS "windowStart",
      bounds.window_end AS "windowEnd",
      (SELECT ${count()}::int FROM upserted_stats) AS "aggregated",
      (SELECT ${count()}::int FROM marked_observations)
        AS "markedObservations",
      (SELECT ${count()}::int FROM deleted_stats) AS "deleted"
    FROM bounds
  `;
}

async function prepareModelStats(
  db: Db,
  requestedWindowStart: Date,
  windowEnd: Date,
  preparedAt: Date,
  signal: AbortSignal,
): Promise<ModelStatsAggregationResult> {
  const query = modelStatsAggregationSql({
    modelStatsModelIds: getModelStatsModelIds(),
    observationModelExpr: modelUsageObservationModelExpression(),
    preparedAt: utcTimestampParam(preparedAt),
    requestedWindowStart: utcTimestampParam(requestedWindowStart),
    windowEnd: utcTimestampParam(windowEnd),
  });

  return await db.transaction(async (tx) => {
    await lockModelStatsAggregation(tx);
    signal.throwIfAborted();
    const rows = await executeRawRows(
      tx,
      query,
      modelStatsAggregationRowSchema,
    );
    signal.throwIfAborted();

    const [result] = rows;
    if (rows.length !== 1 || !result) {
      throw new Error(
        "Model stats aggregation returned an unexpected summary row count",
      );
    }
    return result;
  });
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

  const normalizedModelStats = db
    .select({
      model: modelExpr.as("normalized_model"),
      hourStart: modelStat.hourStart,
      inputTokens: modelStat.inputTokens,
      outputTokens: modelStat.outputTokens,
      cacheReadInputTokens: modelStat.cacheReadInputTokens,
      cacheCreationInputTokens: modelStat.cacheCreationInputTokens,
      totalTokens: modelStat.totalTokens,
    })
    .from(modelStat)
    .where(
      and(
        gte(modelStat.hourStart, sql`${previousStartParam}::timestamp`),
        lt(modelStat.hourStart, sql`${windowEndParam}::timestamp`),
        inArray(modelStat.model, modelStatsModelIds),
      ),
    )
    .as("normalized_model_stats");

  const rankingPeriods = db.$with("ranking_periods").as(
    db
      .select({
        model: normalizedModelStats.model,
        inputTokens: modelStatWindowSum(
          sql`${normalizedModelStats.inputTokens} + ${normalizedModelStats.cacheReadInputTokens} + ${normalizedModelStats.cacheCreationInputTokens}`,
          normalizedModelStats.hourStart,
          windowStartParam,
          windowEndParam,
        ).as("input_tokens"),
        outputTokens: modelStatWindowSum(
          normalizedModelStats.outputTokens,
          normalizedModelStats.hourStart,
          windowStartParam,
          windowEndParam,
        ).as("output_tokens"),
        totalTokens: modelStatWindowSum(
          normalizedModelStats.totalTokens,
          normalizedModelStats.hourStart,
          windowStartParam,
          windowEndParam,
        ).as("total_tokens"),
        previousTotalTokens: modelStatWindowSum(
          normalizedModelStats.totalTokens,
          normalizedModelStats.hourStart,
          previousStartParam,
          previousEndParam,
        ).as("previous_total_tokens"),
      })
      .from(normalizedModelStats)
      .groupBy(normalizedModelStats.model),
  );

  const rows: ModelRankingRow[] = await db
    .with(rankingPeriods)
    .select({
      model: rankingPeriods.model,
      inputTokens: rankingPeriods.inputTokens,
      outputTokens: rankingPeriods.outputTokens,
      totalTokens: rankingPeriods.totalTokens,
      previousTotalTokens: rankingPeriods.previousTotalTokens,
    })
    .from(rankingPeriods)
    .where(gt(rankingPeriods.totalTokens, sql`0`))
    .orderBy(desc(rankingPeriods.totalTokens))
    .limit(50);

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
    const preparedAt = nowDate();
    const windowEnd = utcHourStart(preparedAt);
    const windowStart = new Date(windowEnd.getTime() - hours * HOUR_MS);

    signal.throwIfAborted();
    const result = await prepareModelStats(
      db,
      windowStart,
      windowEnd,
      preparedAt,
      signal,
    );
    signal.throwIfAborted();

    return result;
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
