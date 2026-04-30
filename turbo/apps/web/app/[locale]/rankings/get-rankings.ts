import { sql } from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";
import {
  VM0_MODEL_ALIAS_TO_MODEL,
  normalizeVm0ModelId,
} from "@vm0/api-contracts/contracts/model-providers";
import { initServices } from "../../../src/lib/init-services";
import { MODELS, vendorIconPath, type ModelEntry } from "../models/data";
import type { PeriodKey } from "./data";

const HOUR_MS = 60 * 60_000;

interface RankingRow {
  readonly rank: number;
  readonly model: string;
  readonly name: string;
  readonly vendor: string;
  readonly iconPath: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly totalTokens: number;
  readonly previousTotalTokens: number;
  readonly share: number;
}

interface RawRankingRow {
  readonly model: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_tokens: unknown;
  readonly total_tokens: unknown;
  readonly previous_total_tokens: unknown;
}

const MODELS_BY_ID = new Map(
  MODELS.flatMap((model) => {
    return [
      [model.modelId.toLowerCase(), model],
      [model.slug.toLowerCase(), model],
    ] as const;
  }),
);

function getModelAliasEntries() {
  return Object.entries(VM0_MODEL_ALIAS_TO_MODEL);
}

function resolveModel(modelId: string): ModelEntry | undefined {
  const normalizedModelId = normalizeVm0ModelId(modelId);
  const direct = MODELS_BY_ID.get(normalizedModelId.toLowerCase());
  if (direct) return direct;

  const [, suffix] = normalizedModelId.split("/");
  if (!suffix) return undefined;

  return MODELS_BY_ID.get(suffix.toLowerCase());
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

function currentUtcHour(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    ),
  );
}

function currentWindow(
  period: PeriodKey,
  now: Date,
): { start: Date; end: Date } {
  const end = currentUtcHour(now);
  if (period === "today") {
    return { start: startOfUtcDay(now), end };
  }
  if (period === "month") {
    return { start: startOfUtcMonth(now), end };
  }
  return { start: startOfUtcWeek(now), end };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
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

export async function getRankings(period: PeriodKey): Promise<{
  rows: RankingRow[];
  totalTokens: number;
  windowStart: Date;
  windowEnd: Date;
}> {
  initServices();

  const window = currentWindow(period, new Date());
  const duration = Math.max(window.end.getTime() - window.start.getTime(), 0);
  const previousEnd = window.start;
  const previousStart = new Date(previousEnd.getTime() - duration);
  const modelExpr = modelStatModelExpression();

  const result = await globalThis.services.db.execute(sql`
    WITH current_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.inputTokens}), 0)::bigint AS input_tokens,
        COALESCE(SUM(${modelStat.outputTokens}), 0)::bigint AS output_tokens,
        COALESCE(SUM(${modelStat.cacheReadInputTokens} + ${modelStat.cacheCreationInputTokens}), 0)::bigint AS cache_tokens,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${window.start}
        AND ${modelStat.hourStart} < ${window.end}
      GROUP BY 1
    ),
    previous_period AS (
      SELECT
        ${modelExpr} AS model,
        COALESCE(SUM(${modelStat.totalTokens}), 0)::bigint AS previous_total_tokens
      FROM ${modelStat}
      WHERE ${modelStat.hourStart} >= ${previousStart}
        AND ${modelStat.hourStart} < ${previousEnd}
      GROUP BY 1
    )
    SELECT
      current_period.model,
      current_period.input_tokens,
      current_period.output_tokens,
      current_period.cache_tokens,
      current_period.total_tokens,
      COALESCE(previous_period.previous_total_tokens, 0)::bigint AS previous_total_tokens
    FROM current_period
    LEFT JOIN previous_period ON previous_period.model = current_period.model
    WHERE current_period.total_tokens > 0
    ORDER BY current_period.total_tokens DESC
    LIMIT 50
  `);

  const rawRows = result.rows as unknown as RawRankingRow[];
  const knownRows: {
    readonly row: RawRankingRow;
    readonly model: string;
    readonly modelEntry: ModelEntry;
    readonly totalTokens: number;
  }[] = [];

  for (const row of rawRows) {
    const model = String(row.model);
    const modelEntry = resolveModel(model);
    if (!modelEntry) continue;
    knownRows.push({
      row,
      model,
      modelEntry,
      totalTokens: toNumber(row.total_tokens),
    });
  }

  const totalTokens = knownRows.reduce((sum, row) => {
    return sum + row.totalTokens;
  }, 0);

  return {
    totalTokens,
    windowStart: window.start,
    windowEnd: window.end,
    rows: knownRows.map((item, index) => {
      return {
        rank: index + 1,
        model: item.model,
        name: item.modelEntry.name,
        vendor: item.modelEntry.vendor,
        iconPath: vendorIconPath(item.modelEntry.vendor),
        inputTokens: toNumber(item.row.input_tokens),
        outputTokens: toNumber(item.row.output_tokens),
        cacheTokens: toNumber(item.row.cache_tokens),
        totalTokens: item.totalTokens,
        previousTotalTokens: toNumber(item.row.previous_total_tokens),
        share: totalTokens > 0 ? (item.totalTokens / totalTokens) * 100 : 0,
      };
    }),
  };
}
