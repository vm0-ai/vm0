import {
  and,
  eq,
  inArray,
  isNotNull,
  max,
  sql,
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
  const usage = buildFinalizedUsageRelation(
    normalizeFinalizedUsagePeriod(billingWindow),
  );
  const totalsSelect = {
    userId: usage.userId,
    inputTokens: finalizedUsageTokenSum(
      usage,
      INPUT_TOKEN_CATEGORIES,
      "input_tokens",
    ),
    outputTokens: finalizedUsageTokenSum(
      usage,
      OUTPUT_TOKEN_CATEGORIES,
      "output_tokens",
    ),
    cacheReadInputTokens: finalizedUsageTokenSum(
      usage,
      CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens",
    ),
    cacheCreationInputTokens: finalizedUsageTokenSum(
      usage,
      CACHE_CREATION_TOKEN_CATEGORIES,
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
      INPUT_TOKEN_CATEGORIES,
      "input_tokens_sum",
    ),
    outputTokens: finalizedUsageTokenSum(
      usage,
      OUTPUT_TOKEN_CATEGORIES,
      "output_tokens_sum",
    ),
    cacheReadInputTokens: finalizedUsageTokenSum(
      usage,
      CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens_sum",
    ),
    cacheCreationInputTokens: finalizedUsageTokenSum(
      usage,
      CACHE_CREATION_TOKEN_CATEGORIES,
      "cache_creation_input_tokens_sum",
    ),
    cacheTokens: finalizedUsageTokenSum(
      usage,
      ALL_CACHE_TOKEN_CATEGORIES,
      "cache_tokens_sum",
    ),
    creditsCharged: usageCreditsSum(usage, "credits_sum"),
    model:
      sql`MAX(CASE WHEN ${eq(usage.kind, MODEL_USAGE_KIND)} THEN ${usage.provider} ELSE NULL END)`
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
  return sql`${events.model}`.mapWith(nullableTextDecoder).as("model");
}

function finalizedUsageTokenSum(
  usage: FinalizedUsageRelation,
  categories: readonly string[],
  alias: string,
) {
  return sql`COALESCE(SUM(CASE WHEN ${and(
    eq(usage.kind, MODEL_USAGE_KIND),
    inArray(usage.category, categories),
  )} THEN ${usage.quantity} ELSE 0 END), 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function coalesceRunTotal(column: SQLWrapper, alias: string) {
  return sql`COALESCE(${column}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function usageCreditsSum(usage: FinalizedUsageRelation, alias: string) {
  return sql`COALESCE(SUM(${usage.creditsCharged} + ${usage.allowanceUnits}), 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}
