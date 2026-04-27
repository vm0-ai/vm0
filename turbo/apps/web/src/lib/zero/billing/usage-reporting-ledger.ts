import { and, eq, gte, lt, sql } from "drizzle-orm";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import type { Database } from "../../../types/global";

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
  cacheTokens: number;
  creditsCharged: number;
  model: string | null;
  userId: string;
}

/**
 * Legacy reporting aggregate for member usage.
 *
 * Uses credit_usage.created_at to preserve current reporting semantics. The
 * usage_event follow-up should extend this boundary without changing callers.
 */
export async function getLegacyMemberUsageTotals(
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
        gte(creditUsage.createdAt, period.start),
        lt(creditUsage.createdAt, period.end),
      ),
    )
    .groupBy(creditUsage.userId);
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
        "input_tokens_sum",
      ),
    outputTokens:
      sql<number>`COALESCE(SUM(${creditUsage.outputTokens}), 0)::bigint`.as(
        "output_tokens_sum",
      ),
    cacheTokens:
      sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens}) + SUM(${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
        "cache_tokens_sum",
      ),
    creditsCharged:
      sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
        "credits_sum",
      ),
    model: sql<string>`MAX(${creditUsage.model})`.as("model"),
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
