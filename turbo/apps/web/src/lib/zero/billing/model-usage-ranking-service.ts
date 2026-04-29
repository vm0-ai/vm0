import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { usageEvent } from "@vm0/db/schema/usage-event";
import type {
  ModelUsageRankingRange,
  ModelUsageRankingResponse,
} from "@vm0/api-contracts/contracts/zero-model-usage-ranking";
import type { Database } from "../../../types/global";
import {
  MODEL_TOKEN_CATEGORIES,
  MODEL_USAGE_KIND,
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
} from "./model-usage-categories";

const DAY_MS = 86_400_000;
const MODEL_USAGE_RANKING_LIMIT = 10;

interface ModelUsageAggregateRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  credits: number;
}

interface ModelUsageRowWithTotal extends ModelUsageAggregateRow {
  totalTokens: number;
}

interface ModelUsageDailyAggregateRow {
  date: string;
  model: string;
  credits: number;
  totalTokens: number;
}

function getRangeDays(range: ModelUsageRankingRange): number {
  return range === "1d" ? 1 : range === "7d" ? 7 : 30;
}

function floorUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function getRangeStart(range: ModelUsageRankingRange, now: Date): Date {
  const days = getRangeDays(range);
  return new Date(floorUtcDay(now).getTime() - (days - 1) * DAY_MS);
}

function getDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDateKeys(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    return getDateKey(new Date(start.getTime() + index * DAY_MS));
  });
}

function usageEventTokenSum(category: string, alias: string) {
  return sql<number>`COALESCE(SUM(CASE WHEN ${usageEvent.category} = ${category} THEN ${usageEvent.quantity} ELSE 0 END), 0)::bigint`.as(
    alias,
  );
}

async function queryUsageEventDailyRows(
  db: Database,
  start: Date,
  end: Date,
): Promise<ModelUsageDailyAggregateRow[]> {
  const dateExpr = sql<string>`to_char(date_trunc('day', ${usageEvent.processedAt}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date: dateExpr.as("date"),
      model: usageEvent.provider,
      credits:
        sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
      totalTokens:
        sql<number>`COALESCE(SUM(${usageEvent.quantity}), 0)::bigint`.as(
          "total_tokens",
        ),
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.kind, MODEL_USAGE_KIND),
        eq(usageEvent.status, "processed"),
        inArray(usageEvent.category, MODEL_TOKEN_CATEGORIES),
        gte(usageEvent.processedAt, start),
        lt(usageEvent.processedAt, end),
      ),
    )
    .groupBy(dateExpr, usageEvent.provider);

  return rows.map((row) => {
    return {
      date: row.date,
      model: row.model,
      credits: Number(row.credits),
      totalTokens: Number(row.totalTokens),
    };
  });
}

async function queryLegacyCreditUsageDailyRows(
  db: Database,
  start: Date,
  end: Date,
): Promise<ModelUsageDailyAggregateRow[]> {
  const dateExpr = sql<string>`to_char(date_trunc('day', ${creditUsage.processedAt}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date: dateExpr.as("date"),
      model: creditUsage.model,
      credits:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
      totalTokens:
        sql<number>`COALESCE(SUM(${creditUsage.inputTokens} + ${creditUsage.outputTokens} + ${creditUsage.cacheReadInputTokens} + ${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
          "total_tokens",
        ),
    })
    .from(creditUsage)
    .where(
      and(
        eq(creditUsage.status, "processed"),
        gte(creditUsage.processedAt, start),
        lt(creditUsage.processedAt, end),
      ),
    )
    .groupBy(dateExpr, creditUsage.model);

  return rows.map((row) => {
    return {
      date: row.date,
      model: row.model,
      credits: Number(row.credits),
      totalTokens: Number(row.totalTokens),
    };
  });
}

async function queryUsageEventModelRows(
  db: Database,
  start: Date,
  end: Date,
): Promise<ModelUsageAggregateRow[]> {
  const rows = await db
    .select({
      model: usageEvent.provider,
      inputTokens: usageEventTokenSum(TOKEN_CATEGORY_INPUT, "input_tokens"),
      outputTokens: usageEventTokenSum(TOKEN_CATEGORY_OUTPUT, "output_tokens"),
      cacheTokens:
        sql<number>`COALESCE(SUM(CASE WHEN ${usageEvent.category} IN (${TOKEN_CATEGORY_CACHE_READ}, ${TOKEN_CATEGORY_CACHE_CREATION}) THEN ${usageEvent.quantity} ELSE 0 END), 0)::bigint`.as(
          "cache_tokens",
        ),
      credits:
        sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.kind, MODEL_USAGE_KIND),
        eq(usageEvent.status, "processed"),
        inArray(usageEvent.category, MODEL_TOKEN_CATEGORIES),
        gte(usageEvent.processedAt, start),
        lt(usageEvent.processedAt, end),
      ),
    )
    .groupBy(usageEvent.provider);

  return rows.map((row) => {
    return {
      model: row.model,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheTokens: Number(row.cacheTokens),
      credits: Number(row.credits),
    };
  });
}

async function queryLegacyCreditUsageModelRows(
  db: Database,
  start: Date,
  end: Date,
): Promise<ModelUsageAggregateRow[]> {
  const rows = await db
    .select({
      model: creditUsage.model,
      inputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.inputTokens}), 0)::bigint`.as(
          "input_tokens",
        ),
      outputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.outputTokens}), 0)::bigint`.as(
          "output_tokens",
        ),
      cacheTokens:
        sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens} + ${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
          "cache_tokens",
        ),
      credits:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits",
        ),
    })
    .from(creditUsage)
    .where(
      and(
        eq(creditUsage.status, "processed"),
        gte(creditUsage.processedAt, start),
        lt(creditUsage.processedAt, end),
      ),
    )
    .groupBy(creditUsage.model);

  return rows.map((row) => {
    return {
      model: row.model,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheTokens: Number(row.cacheTokens),
      credits: Number(row.credits),
    };
  });
}

function mergeRows(rows: ModelUsageAggregateRow[]): ModelUsageAggregateRow[] {
  const byModel = new Map<string, ModelUsageAggregateRow>();
  for (const row of rows) {
    const current = byModel.get(row.model);
    if (!current) {
      byModel.set(row.model, { ...row });
      continue;
    }
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheTokens += row.cacheTokens;
    current.credits += row.credits;
  }
  return [...byModel.values()];
}

function mergeDailyRows(
  rows: ModelUsageDailyAggregateRow[],
): ModelUsageDailyAggregateRow[] {
  const byDateAndModel = new Map<string, ModelUsageDailyAggregateRow>();
  for (const row of rows) {
    const key = `${row.date}:${row.model}`;
    const current = byDateAndModel.get(key);
    if (!current) {
      byDateAndModel.set(key, { ...row });
      continue;
    }
    current.credits += row.credits;
    current.totalTokens += row.totalTokens;
  }
  return [...byDateAndModel.values()];
}

function withTotalTokens(
  rows: ModelUsageAggregateRow[],
): ModelUsageRowWithTotal[] {
  return rows.map((row) => {
    return {
      ...row,
      totalTokens: row.inputTokens + row.outputTokens + row.cacheTokens,
    };
  });
}

export async function getModelUsageRanking(
  range: ModelUsageRankingRange,
  options: { now?: Date } = {},
): Promise<ModelUsageRankingResponse> {
  const now = options.now ?? new Date();
  const start = getRangeStart(range, now);
  const days = getRangeDays(range);
  const previousStart = new Date(start.getTime() - days * DAY_MS);
  const db = globalThis.services.db;

  const [
    eventRows,
    legacyRows,
    previousEventRows,
    previousLegacyRows,
    dailyEventRows,
    dailyLegacyRows,
  ] = await Promise.all([
    queryUsageEventModelRows(db, start, now),
    queryLegacyCreditUsageModelRows(db, start, now),
    queryUsageEventModelRows(db, previousStart, start),
    queryLegacyCreditUsageModelRows(db, previousStart, start),
    queryUsageEventDailyRows(db, start, now),
    queryLegacyCreditUsageDailyRows(db, start, now),
  ]);
  const rows = withTotalTokens(mergeRows([...eventRows, ...legacyRows]));
  const previousRows = mergeRows([...previousEventRows, ...previousLegacyRows]);
  const previousCreditsByModel = new Map(
    previousRows.map((row) => {
      return [row.model, row.credits] as const;
    }),
  );

  const grandTotalTokens = rows.reduce((sum, row) => {
    return sum + row.totalTokens;
  }, 0);
  const grandTotalCredits = rows.reduce((sum, row) => {
    return sum + row.credits;
  }, 0);

  const models = rows
    .filter((row) => {
      return row.credits > 0;
    })
    .sort((a, b) => {
      return b.credits - a.credits;
    })
    .slice(0, MODEL_USAGE_RANKING_LIMIT)
    .map((row) => {
      const previousCredits = previousCreditsByModel.get(row.model) ?? 0;
      return {
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheTokens: row.cacheTokens,
        totalTokens: row.totalTokens,
        credits: row.credits,
        previousCredits,
        changePercent:
          previousCredits > 0
            ? (row.credits - previousCredits) / previousCredits
            : null,
        share: grandTotalCredits > 0 ? row.credits / grandTotalCredits : 0,
      };
    });
  const rankedModels = models.map((row) => {
    return row.model;
  });
  const dailyRows = mergeDailyRows([...dailyEventRows, ...dailyLegacyRows]);
  const dailyRowsByDateAndModel = new Map(
    dailyRows.map((row) => {
      return [`${row.date}:${row.model}`, row] as const;
    }),
  );
  const daily = getDateKeys(start, days).map((date) => {
    const dailyModels = rankedModels.map((model) => {
      const row = dailyRowsByDateAndModel.get(`${date}:${model}`);
      return {
        model,
        credits: row?.credits ?? 0,
        totalTokens: row?.totalTokens ?? 0,
      };
    });
    return {
      date,
      totalCredits: dailyModels.reduce((sum, row) => {
        return sum + row.credits;
      }, 0),
      totalTokens: dailyModels.reduce((sum, row) => {
        return sum + row.totalTokens;
      }, 0),
      models: dailyModels,
    };
  });

  return {
    range,
    generatedAt: now.toISOString(),
    grandTotalTokens,
    grandTotalCredits,
    models,
    daily,
  };
}
