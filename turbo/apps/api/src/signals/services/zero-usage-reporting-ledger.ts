import {
  and,
  eq,
  inArray,
  isNotNull,
  max,
  sql,
  sum,
  type SQLWrapper,
} from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";
import { normalizeFinalizedUsagePeriod } from "./finalized-usage-time";
import {
  MODEL_CACHE_CREATION_TOKEN_CATEGORIES,
  MODEL_CACHE_READ_TOKEN_CATEGORIES,
  MODEL_INPUT_TOKEN_CATEGORIES,
  MODEL_OUTPUT_TOKEN_CATEGORIES,
} from "./model-token-categories";

const MODEL_USAGE_KIND = "model";
const ALL_CACHE_TOKEN_CATEGORIES = [
  ...MODEL_CACHE_READ_TOKEN_CATEGORIES,
  ...MODEL_CACHE_CREATION_TOKEN_CATEGORIES,
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
  const usage = buildFinalizedUsageRelation(
    normalizeFinalizedUsagePeriod(billingWindow),
  );
  const totalsSelect = {
    userId: usage.userId,
    inputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_INPUT_TOKEN_CATEGORIES,
      "input_tokens",
    ),
    outputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_OUTPUT_TOKEN_CATEGORIES,
      "output_tokens",
    ),
    cacheReadInputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens",
    ),
    cacheCreationInputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_CACHE_CREATION_TOKEN_CATEGORIES,
      "cache_creation_input_tokens",
    ),
    creditsCharged: usageCreditsSum(usage, "credits_charged"),
  } satisfies Record<keyof UsageMemberTotalsRow, unknown>;

  return await db
    .select(totalsSelect)
    .from(usage)
    .where(eq(usage.orgId, orgId))
    .groupBy(usage.userId);
}

export function buildFinalizedUsageRunTotalsSubquery(db: Db, orgId: string) {
  const usage = buildFinalizedUsageRelation();
  const totalsSelect = {
    runId: usage.runId,
    inputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_INPUT_TOKEN_CATEGORIES,
      "input_tokens_sum",
    ),
    outputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_OUTPUT_TOKEN_CATEGORIES,
      "output_tokens_sum",
    ),
    cacheReadInputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens_sum",
    ),
    cacheCreationInputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_CACHE_CREATION_TOKEN_CATEGORIES,
      "cache_creation_input_tokens_sum",
    ),
    cacheTokens: finalizedUsageTokenSum(
      usage,
      ALL_CACHE_TOKEN_CATEGORIES,
      "cache_tokens_sum",
    ),
    creditsCharged: usageCreditsSum(usage, "credits_sum"),
    model: max(
      sql`CASE WHEN ${eq(usage.kind, MODEL_USAGE_KIND)} THEN ${usage.provider} ELSE NULL END`,
    )
      .mapWith(nullableTextDecoder)
      .as("model"),
    userId: max(usage.userId).mapWith(pgTextDecoder).as("user_id"),
  } satisfies Record<keyof UsageRunTotalsRow, unknown>;

  return db
    .select(totalsSelect)
    .from(usage)
    .where(and(eq(usage.orgId, orgId), isNotNull(usage.runId)))
    .groupBy(usage.runId)
    .as("finalized_usage_run_totals");
}

type FinalizedUsageRunTotalsSubquery = ReturnType<
  typeof buildFinalizedUsageRunTotalsSubquery
>;

export function hasRunUsageTotals(events: FinalizedUsageRunTotalsSubquery) {
  return isNotNull(events.runId);
}

export function mergedRunInputTokens(events: FinalizedUsageRunTotalsSubquery) {
  return coalesceRunTotal(events.inputTokens, "input_tokens");
}

export function mergedRunOutputTokens(events: FinalizedUsageRunTotalsSubquery) {
  return coalesceRunTotal(events.outputTokens, "output_tokens");
}

export function mergedRunCacheTokens(events: FinalizedUsageRunTotalsSubquery) {
  return coalesceRunTotal(events.cacheTokens, "cache_tokens");
}

export function mergedRunCreditsCharged(
  events: FinalizedUsageRunTotalsSubquery,
) {
  return coalesceRunTotal(events.creditsCharged, "credits_charged");
}

export function mergedRunModel(events: FinalizedUsageRunTotalsSubquery) {
  return events.model;
}

function finalizedUsageTokenSum(
  usage: FinalizedUsageRelation,
  categories: readonly string[],
  alias: string,
) {
  return sql`COALESCE(${sum(
    sql`CASE WHEN ${and(
      eq(usage.kind, MODEL_USAGE_KIND),
      inArray(usage.category, categories),
    )} THEN ${usage.quantity} ELSE 0 END`,
  )}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function coalesceRunTotal(column: SQLWrapper, alias: string) {
  return sql`COALESCE(${column}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function usageCreditsSum(usage: FinalizedUsageRelation, alias: string) {
  return sql`COALESCE(${sum(
    sql`${usage.creditsCharged} + ${usage.allowanceUnits}`,
  )}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}
