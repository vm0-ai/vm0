import { and, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { usageEvent } from "@vm0/db/schema/usage-event";
import type { Database } from "../../../types/global";
import {
  MODEL_USAGE_KIND,
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
} from "./model-usage-categories";

interface UsagePeriod {
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
 * Reporting aggregate for member usage across the legacy and usage_event
 * ledgers. Uses processed_at so reporting follows the posted ledger time.
 */
export async function getMemberUsageTotals(
  db: Database,
  orgId: string,
  period: UsagePeriod,
): Promise<UsageMemberTotalsRow[]> {
  const [creditRows, eventRows] = await Promise.all([
    getLegacyMemberUsageTotals(db, orgId, period),
    getUsageEventMemberUsageTotals(db, orgId, period),
  ]);

  return mergeMemberTotals([...creditRows, ...eventRows]);
}

function getLegacyMemberUsageTotals(
  db: Database,
  orgId: string,
  period: UsagePeriod,
): Promise<UsageMemberTotalsRow[]> {
  const totalsSelect = {
    userId: creditUsage.userId,
    inputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.inputTokens}), 0)::bigint`.as(
        "input_tokens",
      ),
    outputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.outputTokens}), 0)::bigint`.as(
        "output_tokens",
      ),
    cacheReadInputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens}), 0)::bigint`.as(
        "cache_read_input_tokens",
      ),
    cacheCreationInputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
        "cache_creation_input_tokens",
      ),
    creditsCharged:
      sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
        "credits_charged",
      ),
  } satisfies Record<keyof UsageMemberTotalsRow, unknown>;

  return db
    .select(totalsSelect)
    .from(creditUsage)
    .where(
      and(
        eq(creditUsage.orgId, orgId),
        eq(creditUsage.status, "processed"),
        gte(creditUsage.processedAt, period.start),
        lt(creditUsage.processedAt, period.end),
      ),
    )
    .groupBy(creditUsage.userId);
}

function getUsageEventMemberUsageTotals(
  db: Database,
  orgId: string,
  period: UsagePeriod,
): Promise<UsageMemberTotalsRow[]> {
  const totalsSelect = {
    userId: usageEvent.userId,
    inputTokens: usageEventTokenSum(TOKEN_CATEGORY_INPUT, "input_tokens"),
    outputTokens: usageEventTokenSum(TOKEN_CATEGORY_OUTPUT, "output_tokens"),
    cacheReadInputTokens: usageEventTokenSum(
      TOKEN_CATEGORY_CACHE_READ,
      "cache_read_input_tokens",
    ),
    cacheCreationInputTokens: usageEventTokenSum(
      TOKEN_CATEGORY_CACHE_CREATION,
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
        gte(usageEvent.processedAt, period.start),
        lt(usageEvent.processedAt, period.end),
      ),
    )
    .groupBy(usageEvent.userId);
}

function mergeMemberTotals(
  rows: UsageMemberTotalsRow[],
): UsageMemberTotalsRow[] {
  const totalsByUser = new Map<string, UsageMemberTotalsRow>();

  for (const row of rows) {
    const current = totalsByUser.get(row.userId);
    if (!current) {
      totalsByUser.set(row.userId, {
        userId: row.userId,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cacheReadInputTokens: Number(row.cacheReadInputTokens),
        cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
        creditsCharged: Number(row.creditsCharged),
      });
      continue;
    }

    current.inputTokens += Number(row.inputTokens);
    current.outputTokens += Number(row.outputTokens);
    current.cacheReadInputTokens += Number(row.cacheReadInputTokens);
    current.cacheCreationInputTokens += Number(row.cacheCreationInputTokens);
    current.creditsCharged += Number(row.creditsCharged);
  }

  return [...totalsByUser.values()];
}

/**
 * Legacy reporting aggregate for run usage.
 *
 * Kept as a subquery because run reporting applies filters, ordering, and
 * pagination on agent_runs after usage has been aggregated per run.
 */
export function buildLegacyRunUsageTotalsSubquery(db: Database, orgId: string) {
  const totalsSelect = {
    runId: creditUsage.runId,
    inputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.inputTokens}), 0)::bigint`.as(
        "legacy_input_tokens_sum",
      ),
    outputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.outputTokens}), 0)::bigint`.as(
        "legacy_output_tokens_sum",
      ),
    cacheReadInputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens}), 0)::bigint`.as(
        "legacy_cache_read_input_tokens_sum",
      ),
    cacheCreationInputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
        "legacy_cache_creation_input_tokens_sum",
      ),
    cacheTokens:
      sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens}) + SUM(${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
        "legacy_cache_tokens_sum",
      ),
    creditsCharged:
      sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
        "legacy_credits_sum",
      ),
    model: sql<string>`MAX(${creditUsage.model})`.as("legacy_model"),
    userId: sql<string>`MAX(${creditUsage.userId})`.as("cu_user_id"),
  } satisfies Record<keyof UsageRunTotalsRow, unknown>;

  return db
    .select(totalsSelect)
    .from(creditUsage)
    .where(
      and(eq(creditUsage.orgId, orgId), eq(creditUsage.status, "processed")),
    )
    .groupBy(creditUsage.runId)
    .as("legacy_run_usage_totals");
}

export function buildUsageEventRunUsageTotalsSubquery(
  db: Database,
  orgId: string,
) {
  const totalsSelect = {
    runId: usageEvent.runId,
    inputTokens: usageEventTokenSum(
      TOKEN_CATEGORY_INPUT,
      "event_input_tokens_sum",
    ),
    outputTokens: usageEventTokenSum(
      TOKEN_CATEGORY_OUTPUT,
      "event_output_tokens_sum",
    ),
    cacheReadInputTokens: usageEventTokenSum(
      TOKEN_CATEGORY_CACHE_READ,
      "event_cache_read_input_tokens_sum",
    ),
    cacheCreationInputTokens: usageEventTokenSum(
      TOKEN_CATEGORY_CACHE_CREATION,
      "event_cache_creation_input_tokens_sum",
    ),
    cacheTokens:
      sql<number>`COALESCE(SUM(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} AND ${usageEvent.category} IN (${TOKEN_CATEGORY_CACHE_READ}, ${TOKEN_CATEGORY_CACHE_CREATION}) THEN ${usageEvent.quantity} ELSE 0 END), 0)::bigint`.as(
        "event_cache_tokens_sum",
      ),
    creditsCharged:
      sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
        "event_credits_sum",
      ),
    model: sql<
      string | null
    >`MAX(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} THEN ${usageEvent.provider} ELSE NULL END)`.as(
      "event_model",
    ),
    userId: sql<string>`MAX(${usageEvent.userId})`.as("ue_user_id"),
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

export function hasRunUsageTotals(
  legacy: ReturnType<typeof buildLegacyRunUsageTotalsSubquery>,
  events: ReturnType<typeof buildUsageEventRunUsageTotalsSubquery>,
) {
  return or(isNotNull(legacy.runId), isNotNull(events.runId));
}

export function mergedRunInputTokens(
  legacy: ReturnType<typeof buildLegacyRunUsageTotalsSubquery>,
  events: ReturnType<typeof buildUsageEventRunUsageTotalsSubquery>,
) {
  return sumNullableLedgerColumns(legacy.inputTokens, events.inputTokens).as(
    "input_tokens",
  );
}

export function mergedRunOutputTokens(
  legacy: ReturnType<typeof buildLegacyRunUsageTotalsSubquery>,
  events: ReturnType<typeof buildUsageEventRunUsageTotalsSubquery>,
) {
  return sumNullableLedgerColumns(legacy.outputTokens, events.outputTokens).as(
    "output_tokens",
  );
}

export function mergedRunCacheTokens(
  legacy: ReturnType<typeof buildLegacyRunUsageTotalsSubquery>,
  events: ReturnType<typeof buildUsageEventRunUsageTotalsSubquery>,
) {
  return sumNullableLedgerColumns(legacy.cacheTokens, events.cacheTokens).as(
    "cache_tokens",
  );
}

export function mergedRunCreditsCharged(
  legacy: ReturnType<typeof buildLegacyRunUsageTotalsSubquery>,
  events: ReturnType<typeof buildUsageEventRunUsageTotalsSubquery>,
) {
  return sumNullableLedgerColumns(
    legacy.creditsCharged,
    events.creditsCharged,
  ).as("credits_charged");
}

export function mergedRunModel(
  legacy: ReturnType<typeof buildLegacyRunUsageTotalsSubquery>,
  events: ReturnType<typeof buildUsageEventRunUsageTotalsSubquery>,
) {
  return sql<string | null>`COALESCE(${legacy.model}, ${events.model})`.as(
    "model",
  );
}

function usageEventTokenSum(category: string, alias: string) {
  return sql<number>`COALESCE(SUM(CASE WHEN ${usageEvent.kind} = ${MODEL_USAGE_KIND} AND ${usageEvent.category} = ${category} THEN ${usageEvent.quantity} ELSE 0 END), 0)::bigint`.as(
    alias,
  );
}

function sumNullableLedgerColumns(
  left: unknown,
  right: unknown,
): ReturnType<typeof sql<number>> {
  return sql<number>`COALESCE(${left}, 0) + COALESCE(${right}, 0)`;
}
