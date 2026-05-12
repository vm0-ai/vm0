import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { usageEvent } from "@vm0/db/schema/usage-event";

import type { Db } from "../external/db";

const MODEL_USAGE_KIND = "model";
const TOKEN_CATEGORY_INPUT = "tokens.input";
const TOKEN_CATEGORY_OUTPUT = "tokens.output";
const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";

const INPUT_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_INPUT,
  "tokens.input.text",
  "tokens.input.audio",
] as const;

const OUTPUT_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_OUTPUT,
  "tokens.output.text",
  "tokens.output.audio",
] as const;

const CACHE_READ_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_CACHE_READ,
  "tokens.input.cached_text",
  "tokens.input.cached_audio",
] as const;

const CACHE_CREATION_TOKEN_CATEGORIES = [
  TOKEN_CATEGORY_CACHE_CREATION,
] as const;

const ALL_CACHE_TOKEN_CATEGORIES = [
  ...CACHE_READ_TOKEN_CATEGORIES,
  ...CACHE_CREATION_TOKEN_CATEGORIES,
] as const;

interface BillingWindow {
  readonly start: Date;
  readonly end: Date;
}

interface UsageMemberTotalsRow {
  readonly userId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly creditsCharged: number;
}

interface UsageRunTotalsRow {
  readonly runId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheTokens: number;
  readonly creditsCharged: number;
  readonly model: string | null;
  readonly userId: string;
}

export async function getMemberUsageTotals(
  db: Db,
  orgId: string,
  billingWindow: BillingWindow,
): Promise<UsageMemberTotalsRow[]> {
  const totalsSelect = {
    userId: usageEvent.userId,
    inputTokens: usageEventTokenSum(INPUT_TOKEN_CATEGORIES, "input_tokens"),
    outputTokens: usageEventTokenSum(OUTPUT_TOKEN_CATEGORIES, "output_tokens"),
    cacheReadInputTokens: usageEventTokenSum(
      CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens",
    ),
    cacheCreationInputTokens: usageEventTokenSum(
      CACHE_CREATION_TOKEN_CATEGORIES,
      "cache_creation_input_tokens",
    ),
    creditsCharged:
      sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
        "credits_charged",
      ),
  } satisfies Record<keyof UsageMemberTotalsRow, unknown>;

  return await db
    .select(totalsSelect)
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, orgId),
        eq(usageEvent.status, "processed"),
        gte(usageEvent.processedAt, billingWindow.start),
        lt(usageEvent.processedAt, billingWindow.end),
      ),
    )
    .groupBy(usageEvent.userId);
}

export function buildUsageEventRunUsageTotalsSubquery(db: Db, orgId: string) {
  const totalsSelect = {
    runId: usageEvent.runId,
    inputTokens: usageEventTokenSum(INPUT_TOKEN_CATEGORIES, "input_tokens_sum"),
    outputTokens: usageEventTokenSum(
      OUTPUT_TOKEN_CATEGORIES,
      "output_tokens_sum",
    ),
    cacheReadInputTokens: usageEventTokenSum(
      CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens_sum",
    ),
    cacheCreationInputTokens: usageEventTokenSum(
      CACHE_CREATION_TOKEN_CATEGORIES,
      "cache_creation_input_tokens_sum",
    ),
    cacheTokens: usageEventTokenSum(
      ALL_CACHE_TOKEN_CATEGORIES,
      "cache_tokens_sum",
    ),
    creditsCharged:
      sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
        "credits_sum",
      ),
    model: sql<
      string | null
    >`MAX(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} THEN ${usageEvent.provider} ELSE NULL END)`.as(
      "model",
    ),
    userId: sql<string>`MAX(${usageEvent.userId})`.as("user_id"),
  } satisfies Record<keyof UsageRunTotalsRow, unknown>;

  return db
    .select(totalsSelect)
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, orgId),
        eq(usageEvent.status, "processed"),
        isNotNull(usageEvent.runId),
      ),
    )
    .groupBy(usageEvent.runId)
    .as("usage_event_run_usage_totals");
}

type UsageEventRunUsageTotalsSubquery = ReturnType<
  typeof buildUsageEventRunUsageTotalsSubquery
>;

export function hasRunUsageTotals(events: UsageEventRunUsageTotalsSubquery) {
  return isNotNull(events.runId);
}

export function mergedRunInputTokens(events: UsageEventRunUsageTotalsSubquery) {
  return coalesceRunTotal(events.inputTokens, "input_tokens");
}

export function mergedRunOutputTokens(
  events: UsageEventRunUsageTotalsSubquery,
) {
  return coalesceRunTotal(events.outputTokens, "output_tokens");
}

export function mergedRunCacheTokens(events: UsageEventRunUsageTotalsSubquery) {
  return coalesceRunTotal(events.cacheTokens, "cache_tokens");
}

export function mergedRunCreditsCharged(
  events: UsageEventRunUsageTotalsSubquery,
) {
  return coalesceRunTotal(events.creditsCharged, "credits_charged");
}

export function mergedRunModel(events: UsageEventRunUsageTotalsSubquery) {
  return sql<string | null>`${events.model}`.as("model");
}

function usageEventTokenSum(categories: readonly string[], alias: string) {
  const list = sql.join(
    categories.map((category) => {
      return sql`${category}`;
    }),
    sql.raw(", "),
  );
  return sql<number>`COALESCE(SUM(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} AND ${usageEvent.category} IN (${list}) THEN ${usageEvent.quantity} ELSE 0 END), 0)::bigint`.as(
    alias,
  );
}

function coalesceRunTotal(column: unknown, alias: string) {
  return sql<number>`COALESCE(${column}, 0)::bigint`.as(alias);
}
