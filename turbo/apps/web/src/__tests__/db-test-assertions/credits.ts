import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";
import { creditExpiresRecord } from "../../db/schema/credit-expires-record";
import { creditUsage } from "../../db/schema/credit-usage";
import { clientCreditUsage } from "../../db/schema/client-credit-usage";
import { usageDaily } from "../../db/schema/usage-daily";
import { insightsDaily } from "../../db/schema/insights-daily";
import { orgPromoRedemption } from "../../db/schema/org-promo-redemption";

// ---------------------------------------------------------------------------
// Read-only assertion helpers for billing / credit test verification.
// ---------------------------------------------------------------------------

/**
 * Read all billing-related fields from an org in the `org_metadata` table.
 */
export async function getOrgBillingFields(orgId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      tier: orgMetadata.tier,
      credits: orgMetadata.credits,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/**
 * Read auto-recharge fields from an org.
 */
export async function getOrgAutoRechargeFields(orgId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
      autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
      autoRechargeAmount: orgMetadata.autoRechargeAmount,
      autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/**
 * Find all credit expires records for an org, ordered by expires_at ASC.
 */
export async function findCreditExpiresRecords(orgId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, orgId))
    .orderBy(creditExpiresRecord.expiresAt);
}

/**
 * Look up a credit_expires_record by (orgId, stripeInvoiceId). Used by
 * one-time purchase webhook tests that assert credits landed with the
 * correct source / expiry metadata for a specific Stripe session id.
 */
export async function findCreditExpiresRecordByStripeInvoiceId(
  orgId: string,
  stripeInvoiceId: string,
) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        eq(creditExpiresRecord.stripeInvoiceId, stripeInvoiceId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Read the current stripe_session_id stored on the org_promo_redemption row
 * for (orgId, campaignKey). Returns undefined if no row exists.
 */
export async function findOrgPromoRedemption(params: {
  orgId: string;
  campaignKey: string;
}): Promise<{ stripeSessionId: string } | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ stripeSessionId: orgPromoRedemption.stripeSessionId })
    .from(orgPromoRedemption)
    .where(
      and(
        eq(orgPromoRedemption.orgId, params.orgId),
        eq(orgPromoRedemption.campaignKey, params.campaignKey),
      ),
    )
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Usage / insights assertion helpers.
// ---------------------------------------------------------------------------

/**
 * Read a credit_usage record by ID.
 */
export async function findTestCreditUsage(id: string): Promise<
  | {
      id: string;
      status: string;
      creditsCharged: number | null;
      processedAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [record] = await globalThis.services.db
    .select({
      id: creditUsage.id,
      status: creditUsage.status,
      creditsCharged: creditUsage.creditsCharged,
      processedAt: creditUsage.processedAt,
    })
    .from(creditUsage)
    .where(eq(creditUsage.id, id))
    .limit(1);
  return record;
}

/**
 * Find credit_usage records by runId.
 * Returns all records for the run (one per result event).
 */
export async function findTestCreditUsagesByRunId(runId: string): Promise<
  Array<{
    id: string;
    runId: string | null;
    resultUuid: string | null;
    orgId: string;
    userId: string;
    model: string;
    modelProvider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUsd: string | null;
    status: string;
    creditsCharged: number | null;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      id: creditUsage.id,
      runId: creditUsage.runId,
      resultUuid: creditUsage.resultUuid,
      orgId: creditUsage.orgId,
      userId: creditUsage.userId,
      model: creditUsage.model,
      modelProvider: creditUsage.modelProvider,
      inputTokens: creditUsage.inputTokens,
      outputTokens: creditUsage.outputTokens,
      cacheReadInputTokens: creditUsage.cacheReadInputTokens,
      cacheCreationInputTokens: creditUsage.cacheCreationInputTokens,
      webSearchRequests: creditUsage.webSearchRequests,
      costUsd: creditUsage.costUsd,
      status: creditUsage.status,
      creditsCharged: creditUsage.creditsCharged,
    })
    .from(creditUsage)
    .where(eq(creditUsage.runId, runId));
}

/**
 * Find client_credit_usage records by runId.
 */
export async function findTestClientCreditUsagesByRunId(runId: string): Promise<
  Array<{
    id: string;
    runId: string | null;
    resultUuid: string | null;
    orgId: string;
    userId: string;
    model: string;
    modelProvider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUsd: string | null;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      id: clientCreditUsage.id,
      runId: clientCreditUsage.runId,
      resultUuid: clientCreditUsage.resultUuid,
      orgId: clientCreditUsage.orgId,
      userId: clientCreditUsage.userId,
      model: clientCreditUsage.model,
      modelProvider: clientCreditUsage.modelProvider,
      inputTokens: clientCreditUsage.inputTokens,
      outputTokens: clientCreditUsage.outputTokens,
      cacheReadInputTokens: clientCreditUsage.cacheReadInputTokens,
      cacheCreationInputTokens: clientCreditUsage.cacheCreationInputTokens,
      webSearchRequests: clientCreditUsage.webSearchRequests,
      costUsd: clientCreditUsage.costUsd,
    })
    .from(clientCreditUsage)
    .where(eq(clientCreditUsage.runId, runId));
}

/**
 * Look up a usage_daily record for verification in tests.
 */
export async function findUsageDaily(
  userId: string,
  orgId: string,
  date: string,
): Promise<{ runCount: number; runTimeMs: number } | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      runCount: usageDaily.runCount,
      runTimeMs: usageDaily.runTimeMs,
    })
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.userId, userId),
        eq(usageDaily.orgId, orgId),
        eq(usageDaily.date, date),
      ),
    );
  return row;
}

/**
 * Look up an insights_daily record for verification in tests.
 */
export async function findInsightsDaily(
  orgId: string,
  date: string,
  userId?: string,
): Promise<{ data: Record<string, unknown> } | undefined> {
  initServices();
  const conditions = [
    eq(insightsDaily.orgId, orgId),
    eq(insightsDaily.date, date),
  ];
  if (userId) {
    conditions.push(eq(insightsDaily.userId, userId));
  }
  const [row] = await globalThis.services.db
    .select({ data: insightsDaily.data })
    .from(insightsDaily)
    .where(and(...conditions));
  return row as { data: Record<string, unknown> } | undefined;
}
