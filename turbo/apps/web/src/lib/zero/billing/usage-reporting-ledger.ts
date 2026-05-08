import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { usageEvent } from "@vm0/db/schema/usage-event";
import type { Database } from "../../../types/global";
import {
  MODEL_USAGE_KIND,
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
} from "./model-usage-categories";

/**
 * Realtime/transcription providers emit per-modality token counts
 * (`tokens.input.text`, `tokens.input.audio`, `tokens.input.cached_*`,
 * `tokens.output.text`, `tokens.output.audio`) instead of the four flat
 * model-token buckets. Member and run totals merge those into the same
 * inputTokens/outputTokens/cacheReadInputTokens columns so the existing
 * UI/API surface treats audio cost as just another model cost.
 *
 *   tokens.input + tokens.input.text + tokens.input.audio
 *     -> inputTokens
 *   tokens.output + tokens.output.text + tokens.output.audio
 *     -> outputTokens
 *   tokens.cache_read + tokens.input.cached_text + tokens.input.cached_audio
 *     -> cacheReadInputTokens
 *   tokens.cache_creation
 *     -> cacheCreationInputTokens
 */
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

/**
 * Reporting time terms:
 * - activityTime maps to ledger created_at, when usage activity was recorded.
 * - billingTime maps to ledger processed_at, when credits were settled.
 */
interface BillingWindow {
  /** Half-open [start, end) window over billingTime. */
  start: Date;
  end: Date;
}

interface UsageMemberTotalsRow {
  userId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  creditsCharged: number;
}

interface UsageRunTotalsRow {
  runId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheTokens: number;
  creditsCharged: number;
  model: string | null;
  userId: string;
}

/**
 * Reporting aggregate for member usage from usage_event.
 * Member totals are billing-period data, so they use billingTime.
 */
export async function getMemberUsageTotals(
  db: Database,
  orgId: string,
  billingWindow: BillingWindow,
): Promise<UsageMemberTotalsRow[]> {
  return getUsageEventMemberUsageTotals(db, orgId, billingWindow);
}

function getUsageEventMemberUsageTotals(
  db: Database,
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

  return db
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

/**
 * Reporting aggregate for run usage.
 *
 * Kept as a subquery because run reporting applies filters, ordering, and
 * pagination on agent_runs after usage has been aggregated per run.
 */
export function buildUsageEventRunUsageTotalsSubquery(
  db: Database,
  orgId: string,
) {
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
    categories.map((c) => {
      return sql`${c}`;
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
