import {
  and,
  eq,
  gte,
  isNotNull,
  lt,
  max,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { usageAllowanceAllocations } from "@vm0/db/schema/org-usage-allowance";
import { usageEvent } from "@vm0/db/schema/usage-event";

import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
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
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);

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
    creditsCharged: usageCreditsSum("credits_charged"),
  } satisfies Record<keyof UsageMemberTotalsRow, unknown>;

  return await db
    .select(totalsSelect)
    .from(usageEvent)
    .leftJoin(
      usageAllowanceAllocations,
      eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
    )
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
    creditsCharged: usageCreditsSum("credits_sum"),
    model:
      sql`MAX(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} THEN ${usageEvent.provider} ELSE NULL END)`
        .mapWith(nullableTextDecoder)
        .as("model"),
    userId: max(usageEvent.userId).mapWith(pgTextDecoder).as("user_id"),
  } satisfies Record<keyof UsageRunTotalsRow, unknown>;

  return db
    .select(totalsSelect)
    .from(usageEvent)
    .leftJoin(
      usageAllowanceAllocations,
      eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
    )
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
  return sql`${events.model}`.mapWith(nullableTextDecoder).as("model");
}

function usageEventTokenSum(categories: readonly string[], alias: string) {
  const list = sql.join(
    categories.map((category) => {
      return sql`${category}`;
    }),
    sql`, `,
  );
  return sql`COALESCE(SUM(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} AND ${usageEvent.category} IN (${list}) THEN ${usageEvent.quantity} ELSE 0 END), 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function coalesceRunTotal(column: SQLWrapper, alias: string) {
  return sql`COALESCE(${column}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function usageCreditsSum(alias: string) {
  return sql`COALESCE(SUM(COALESCE(${usageEvent.creditsCharged}, 0) + COALESCE(${usageAllowanceAllocations.unitsApplied}, 0)), 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}
