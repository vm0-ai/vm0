import { and, eq, gte, lt, sql } from "drizzle-orm";
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
 * model-token buckets. Member totals merge those into the same
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
