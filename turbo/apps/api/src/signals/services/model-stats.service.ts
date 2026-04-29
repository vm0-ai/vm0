import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { creditUsage } from "@vm0/db/schema/credit-usage";
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
const MODEL_USAGE_KIND = "model";
const TOKEN_CATEGORY_INPUT = "tokens.input";
const TOKEN_CATEGORY_OUTPUT = "tokens.output";
const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";

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

function creditUsageModelExpression() {
  const modelColumn = sql.raw('"credit_usage"."model"');
  return sql<string>`CASE ${sql.join(
    getModelAliasEntries().map(([alias, model]) => {
      return sql`WHEN ${modelColumn} = ${alias} THEN ${model}`;
    }),
    sql` `,
  )} ELSE ${modelColumn} END`;
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

async function replaceModelStats(
  db: Db,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const creditUsageModelExpr = creditUsageModelExpression();
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
          date_trunc('hour', ${creditUsage.createdAt})::timestamp AS hour_start,
          ${creditUsageModelExpr} AS model,
          ${creditUsage.orgId} AS org_id,
          ${creditUsage.userId} AS user_id,
          COALESCE(${creditUsage.runId}::text, ${creditUsage.id}::text) AS request_key,
          ${creditUsage.inputTokens}::bigint AS input_tokens,
          ${creditUsage.outputTokens}::bigint AS output_tokens,
          ${creditUsage.cacheReadInputTokens}::bigint AS cache_read_input_tokens,
          ${creditUsage.cacheCreationInputTokens}::bigint AS cache_creation_input_tokens,
          COALESCE(${creditUsage.creditsCharged}, 0)::bigint AS credits_charged
        FROM ${creditUsage}
        WHERE ${creditUsage.createdAt} >= ${windowStart}
          AND ${creditUsage.createdAt} < ${windowEnd}
          AND ${creditUsage.model} IN (${modelStatsModelIdSql})

        UNION ALL

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
