import { and, eq, isNull } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgPromoRedemption } from "@vm0/db/schema/org-promo-redemption";

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

/**
 * Read a usage_event record by ID.
 */
export async function findTestUsageEvent(id: string): Promise<
  | {
      id: string;
      status: string;
      creditsCharged: number | null;
      processedAt: Date | null;
      billingError: string | null;
    }
  | undefined
> {
  initServices();
  const [record] = await globalThis.services.db
    .select({
      id: usageEvent.id,
      status: usageEvent.status,
      creditsCharged: usageEvent.creditsCharged,
      processedAt: usageEvent.processedAt,
      billingError: usageEvent.billingError,
    })
    .from(usageEvent)
    .where(eq(usageEvent.id, id))
    .limit(1);
  return record;
}

/**
 * Find all usage_event records by runId.
 */
export async function findTestUsageEventsByRunId(runId: string): Promise<
  Array<{
    idempotencyKey: string;
    kind: string;
    provider: string;
    category: string;
    quantity: number;
    status: string;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      idempotencyKey: usageEvent.idempotencyKey,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      status: usageEvent.status,
    })
    .from(usageEvent)
    .where(eq(usageEvent.runId, runId))
    .orderBy(usageEvent.kind, usageEvent.provider, usageEvent.category);
}

/**
 * Find runless usage_event records by org and provider.
 */
export async function findTestRunlessUsageEventsByOrgProvider(
  orgId: string,
  provider: string,
): Promise<
  Array<{
    runId: string | null;
    kind: string;
    provider: string;
    category: string;
    quantity: number;
    creditsCharged: number | null;
    status: string;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      runId: usageEvent.runId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      creditsCharged: usageEvent.creditsCharged,
      status: usageEvent.status,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, orgId),
        eq(usageEvent.provider, provider),
        isNull(usageEvent.runId),
      ),
    )
    .orderBy(usageEvent.kind, usageEvent.provider, usageEvent.category);
}
