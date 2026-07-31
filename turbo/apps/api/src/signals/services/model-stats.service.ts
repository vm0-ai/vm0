import { command } from "ccstate";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
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
import { logger } from "../../lib/log";
import { type Db, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { lockModelStatsAggregation } from "./model-stats-aggregation-lock.service";

const HOUR_MS = 60 * 60_000;
const MODEL_USAGE_OBSERVATION_CLEANUP_BATCH_SIZE = 1000;
const MODEL_USAGE_OBSERVATION_CLEANUP_MAX_BATCHES = 10;
export const MODEL_RANKING_PERIODS = ["today", "week", "month"] as const;
const L = logger("CronAggregateModelStats");

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

interface ModelStatsProcessingResult {
  readonly cutoff: Date;
  readonly processedHours: number;
  readonly processedObservations: number;
  readonly updatedStats: number;
  readonly deletedObservations: number;
}

interface ModelStatsHourProcessingResult {
  readonly hourStart: Date | null;
  readonly processedObservations: number;
  readonly updatedStats: number;
}

const modelStatsHourProcessingRowSchema = z.object({
  hourStart: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  processedObservations: z.int().nonnegative(),
  updatedStats: z.int().nonnegative(),
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

interface ModelStatsHourProcessingSqlArgs {
  readonly modelStatsModelIds: string[];
  readonly observationModelExpr: SQLWrapper;
  readonly processedAt: string;
  readonly cutoff: string;
}

function modelStatsHourClaimCtes(args: ModelStatsHourProcessingSqlArgs): SQL {
  return sql`
    oldest_pending_hour AS MATERIALIZED (
        SELECT
          date_trunc(
            'hour',
            ${modelUsageObservation.observedAt}
          )::timestamp AS hour_start
        FROM ${modelUsageObservation}
        WHERE ${and(
          isNull(modelUsageObservation.aggregatedAt),
          lt(modelUsageObservation.observedAt, sql`${args.cutoff}::timestamp`),
        )}
        ORDER BY ${modelUsageObservation.observedAt}
        LIMIT 1
      ),
      claimed_observations AS (
        UPDATE ${modelUsageObservation}
        SET aggregated_at = ${args.processedAt}::timestamp
        FROM oldest_pending_hour
        WHERE ${and(
          isNull(modelUsageObservation.aggregatedAt),
          gte(
            modelUsageObservation.observedAt,
            sql`oldest_pending_hour.hour_start`,
          ),
          lt(
            modelUsageObservation.observedAt,
            sql`oldest_pending_hour.hour_start + INTERVAL '1 hour'`,
          ),
        )}
        RETURNING
          ${args.observationModelExpr} AS model,
          ${modelUsageObservation.inputTokens}::bigint AS input_tokens,
          ${modelUsageObservation.outputTokens}::bigint AS output_tokens,
          ${modelUsageObservation.cacheReadInputTokens}::bigint
            AS cache_read_input_tokens,
          ${modelUsageObservation.cacheCreationInputTokens}::bigint
            AS cache_creation_input_tokens
      )
  `;
}

function modelStatsHourProjectionCtes(
  args: ModelStatsHourProcessingSqlArgs,
): SQL {
  return sql`
    aggregated AS MATERIALIZED (
        SELECT
          oldest_pending_hour.hour_start,
          claimed_observations.model,
          COALESCE(SUM(claimed_observations.input_tokens), 0)::bigint
            AS input_tokens,
          COALESCE(SUM(claimed_observations.output_tokens), 0)::bigint
            AS output_tokens,
          COALESCE(
            SUM(claimed_observations.cache_read_input_tokens),
            0
          )::bigint AS cache_read_input_tokens,
          COALESCE(
            SUM(claimed_observations.cache_creation_input_tokens),
            0
          )::bigint AS cache_creation_input_tokens,
          (
            COALESCE(SUM(claimed_observations.input_tokens), 0)
            + COALESCE(SUM(claimed_observations.output_tokens), 0)
            + COALESCE(
              SUM(claimed_observations.cache_read_input_tokens),
              0
            )
            + COALESCE(
              SUM(claimed_observations.cache_creation_input_tokens),
              0
            )
          )::bigint AS total_tokens
        FROM claimed_observations
        CROSS JOIN oldest_pending_hour
        WHERE ${and(
          inArray(sql`claimed_observations.model`, args.modelStatsModelIds),
          or(
            gt(sql`claimed_observations.input_tokens`, sql`0`),
            gt(sql`claimed_observations.output_tokens`, sql`0`),
            gt(sql`claimed_observations.cache_read_input_tokens`, sql`0`),
            gt(sql`claimed_observations.cache_creation_input_tokens`, sql`0`),
          ),
        )}
        GROUP BY
          oldest_pending_hour.hour_start,
          claimed_observations.model
      ),
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
          input_tokens =
            ${modelStat.inputTokens} + EXCLUDED.input_tokens,
          output_tokens =
            ${modelStat.outputTokens} + EXCLUDED.output_tokens,
          cache_read_input_tokens =
            ${modelStat.cacheReadInputTokens}
            + EXCLUDED.cache_read_input_tokens,
          cache_creation_input_tokens =
            ${modelStat.cacheCreationInputTokens}
            + EXCLUDED.cache_creation_input_tokens,
          total_tokens =
            ${modelStat.totalTokens} + EXCLUDED.total_tokens,
          updated_at = NOW()
        RETURNING id
      )
  `;
}

function modelStatsHourProcessingSql(
  args: ModelStatsHourProcessingSqlArgs,
): SQL {
  return sql`
    WITH
      ${modelStatsHourClaimCtes(args)},
      ${modelStatsHourProjectionCtes(args)}
    SELECT
      (
        SELECT oldest_pending_hour.hour_start
        FROM oldest_pending_hour
      ) AS "hourStart",
      (
        SELECT ${count()}::int
        FROM claimed_observations
      ) AS "processedObservations",
      (
        SELECT ${count()}::int
        FROM upserted_stats
      ) AS "updatedStats"
  `;
}

async function processOldestPendingModelStatsHour(
  db: Db,
  cutoff: Date,
  processedAt: Date,
  signal: AbortSignal,
): Promise<ModelStatsHourProcessingResult> {
  const query = modelStatsHourProcessingSql({
    modelStatsModelIds: getModelStatsModelIds(),
    observationModelExpr: modelUsageObservationModelExpression(),
    processedAt: utcTimestampParam(processedAt),
    cutoff: utcTimestampParam(cutoff),
  });

  const result = await db.transaction(async (tx) => {
    await lockModelStatsAggregation(tx);
    signal.throwIfAborted();
    const rows = await executeRawRows(
      tx,
      query,
      modelStatsHourProcessingRowSchema,
    );
    signal.throwIfAborted();

    const [row] = rows;
    if (rows.length !== 1 || !row) {
      throw new Error(
        "Model stats processing returned an unexpected summary row count",
      );
    }
    return row;
  });
  signal.throwIfAborted();
  return result;
}

async function cleanupAppliedModelUsageObservations(
  db: Db,
  cutoff: Date,
  signal: AbortSignal,
): Promise<number> {
  let deletedObservations = 0;

  for (
    let batch = 0;
    batch < MODEL_USAGE_OBSERVATION_CLEANUP_MAX_BATCHES;
    batch += 1
  ) {
    signal.throwIfAborted();
    const candidates = db
      .select({
        idempotencyKey: modelUsageObservation.idempotencyKey,
      })
      .from(modelUsageObservation)
      .where(
        and(
          isNotNull(modelUsageObservation.aggregatedAt),
          lt(modelUsageObservation.observedAt, cutoff),
        ),
      )
      .orderBy(
        asc(modelUsageObservation.observedAt),
        asc(modelUsageObservation.idempotencyKey),
      )
      .limit(MODEL_USAGE_OBSERVATION_CLEANUP_BATCH_SIZE)
      .for("update", { skipLocked: true });
    const { rowCount } = await db
      .delete(modelUsageObservation)
      .where(inArray(modelUsageObservation.idempotencyKey, candidates));
    signal.throwIfAborted();

    const batchDeleted = rowCount ?? 0;
    deletedObservations += batchDeleted;
    if (batchDeleted < MODEL_USAGE_OBSERVATION_CLEANUP_BATCH_SIZE) {
      break;
    }
  }

  return deletedObservations;
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
  async ({ set }, signal: AbortSignal): Promise<ModelStatsProcessingResult> => {
    const db = set(writeDb$);
    const startedAt = performance.now();
    const processedAt = nowDate();
    const cutoff = utcHourStart(processedAt);
    const cleanupCutoff = new Date(processedAt.getTime() - HOUR_MS);
    let processedHours = 0;
    let processedObservations = 0;
    let updatedStats = 0;
    let firstProcessedHour: Date | null = null;
    let lastProcessedHour: Date | null = null;

    while (true) {
      signal.throwIfAborted();
      const result = await processOldestPendingModelStatsHour(
        db,
        cutoff,
        processedAt,
        signal,
      );
      signal.throwIfAborted();
      if (!result.hourStart) {
        break;
      }

      firstProcessedHour ??= result.hourStart;
      lastProcessedHour = result.hourStart;
      processedHours++;
      processedObservations += result.processedObservations;
      updatedStats += result.updatedStats;
    }

    const deletedObservations = await cleanupAppliedModelUsageObservations(
      db,
      cleanupCutoff,
      signal,
    );
    signal.throwIfAborted();

    const durationMs = Math.round(performance.now() - startedAt);
    L.debug("model stats processing completed", {
      cutoff: cutoff.toISOString(),
      cleanupCutoff: cleanupCutoff.toISOString(),
      firstProcessedHour: firstProcessedHour?.toISOString() ?? null,
      lastProcessedHour: lastProcessedHour?.toISOString() ?? null,
      oldestCompleteBacklogAgeHours:
        firstProcessedHour === null
          ? 0
          : (cutoff.getTime() - firstProcessedHour.getTime()) / HOUR_MS,
      processedHours,
      processedObservations,
      updatedStats,
      deletedObservations,
      remainingCompletePendingObservations: 0,
      durationMs,
    });

    return {
      cutoff,
      processedHours,
      processedObservations,
      updatedStats,
      deletedObservations,
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
