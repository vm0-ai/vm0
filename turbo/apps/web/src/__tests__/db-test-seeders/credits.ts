import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "crypto";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { creditPricing } from "@vm0/db/schema/credit-pricing";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgPromoRedemption } from "@vm0/db/schema/org-promo-redemption";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { ensureTestAgentSession } from "./runs";
import { grantOrgCredits } from "../../lib/zero/org/org-service";
import {
  deductFromExpiresRecords,
  expireCredits,
} from "../../lib/zero/credit/credit-expires-service";

// ---------------------------------------------------------------------------
// DB-direct seeders for billing / Stripe test setup.
//
// Each function has a @why-db-direct annotation explaining why it cannot be
// replaced by a webhook simulation or API call.
// ---------------------------------------------------------------------------

/**
 * Set Stripe billing fields on an org in the `org_metadata` table.
 *
 * @why-db-direct Sets Stripe billing preconditions (stripeCustomerId,
 * subscriptionId, tier). These fields are normally written by Stripe
 * Dashboard / checkout flow. No API or webhook in our codebase bootstraps
 * these from scratch — `handleCheckoutCompleted` READS `stripeCustomerId`
 * to find the org, so it cannot create the initial association.
 */
export async function updateOrgStripeFields(
  orgId: string,
  fields: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: string | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    lastProcessedInvoiceId?: string | null;
    tier?: string;
  },
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Configure auto-recharge settings on an org.
 *
 * @why-db-direct Auto-recharge configuration is normally set via the billing
 * settings API which requires an active paid subscription. Direct seeding
 * avoids multi-step subscription ceremony for test setup.
 */
export async function updateOrgAutoRecharge(
  orgId: string,
  fields: {
    autoRechargeEnabled?: boolean;
    autoRechargeThreshold?: number | null;
    autoRechargeAmount?: number | null;
    autoRechargePendingAt?: Date | null;
  },
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Set Stripe subscription fields on org_metadata for testing billing-related flows.
 *
 * @why-db-direct Sets subscription ID and status for cleanup / deletion tests.
 * A subset of updateOrgStripeFields. No webhook creates subscription
 * associations from scratch.
 */
export async function updateOrgStripeSubscription(
  orgId: string,
  subscriptionId: string,
  status: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status,
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Insert a credit_pricing record for testing.
 * Uses upsert so tests can safely set pricing for the same model.
 *
 * @why-db-direct Credit pricing is reference data managed via database
 * migrations, not API endpoints or webhooks. No user-facing flow creates
 * pricing records.
 */
export async function insertTestCreditPricing(
  model: string,
  options?: {
    inputTokenPrice?: number;
    outputTokenPrice?: number;
    cacheReadTokenPrice?: number;
    cacheCreationTokenPrice?: number;
    modelProvider?: string;
  },
): Promise<void> {
  initServices();
  const inputTokenPrice = options?.inputTokenPrice ?? 100;
  const outputTokenPrice = options?.outputTokenPrice ?? 200;
  const cacheReadTokenPrice = options?.cacheReadTokenPrice ?? 0;
  const cacheCreationTokenPrice = options?.cacheCreationTokenPrice ?? 0;
  const modelProvider = options?.modelProvider ?? "";

  await globalThis.services.db
    .insert(creditPricing)
    .values({
      model,
      modelProvider,
      inputTokenPrice,
      outputTokenPrice,
      cacheReadTokenPrice,
      cacheCreationTokenPrice,
    })
    .onConflictDoUpdate({
      target: [creditPricing.model, creditPricing.modelProvider],
      set: {
        inputTokenPrice,
        outputTokenPrice,
        cacheReadTokenPrice,
        cacheCreationTokenPrice,
      },
    });
}

/**
 * Insert a credit expires record for testing.
 *
 * @why-db-direct Credit expires records are normally created by
 * `handleInvoicePaid` during subscription renewal. Tests need precise
 * control over amounts, remaining balances, and expiry dates that cannot
 * be achieved through the webhook flow.
 */
export async function insertCreditExpiresRecord(params: {
  orgId: string;
  source?: string;
  stripeInvoiceId?: string;
  amount: number;
  remaining?: number;
  expiresAt: Date;
}): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(creditExpiresRecord)
    .values({
      orgId: params.orgId,
      source: params.source ?? "subscription_renewal",
      stripeInvoiceId: params.stripeInvoiceId ?? null,
      amount: params.amount,
      remaining: params.remaining ?? params.amount,
      expiresAt: params.expiresAt,
    })
    .returning({ id: creditExpiresRecord.id });
  return row!.id;
}

/**
 * Insert an org_promo_redemption row — simulates the state after a previous
 * `POST /api/zero/billing/redeem/:campaign` attempt claimed the (org, campaign) slot.
 *
 * @why-db-direct The row is normally written by the `POST /api/zero/billing/redeem/:campaign`
 * route after a successful Stripe session create. Tests exercise the route's
 * resume branches (open/expired/complete) and need to pre-plant a session id
 * that the Stripe mock returns a specific status for.
 */
export async function insertOrgPromoRedemption(params: {
  orgId: string;
  campaignKey: string;
  stripeSessionId: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(orgPromoRedemption).values({
    orgId: params.orgId,
    campaignKey: params.campaignKey,
    stripeSessionId: params.stripeSessionId,
  });
}

// ---------------------------------------------------------------------------
// Usage / insights seeders.
// ---------------------------------------------------------------------------

/**
 * Insert a usage_pricing record for testing.
 * Uses upsert so tests can safely set pricing for the same triple.
 *
 * @why-db-direct Usage pricing is reference data managed via seeders/migrations,
 * not API endpoints. No user-facing flow creates pricing records.
 */
export async function insertTestUsagePricing(params: {
  kind: string;
  provider: string;
  category: string;
  unitPrice: number;
  unitSize?: number;
}): Promise<void> {
  initServices();
  const unitSize = params.unitSize ?? 1;
  await globalThis.services.db
    .insert(usagePricing)
    .values({
      kind: params.kind,
      provider: params.provider,
      category: params.category,
      unitPrice: params.unitPrice,
      unitSize,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: { unitPrice: params.unitPrice, unitSize, updatedAt: new Date() },
    });
}

/**
 * Insert a usage_event record for testing the billing processor.
 *
 * @why-db-direct Usage events are normally written by the agent usage-event
 * webhook. Tests need precise control over kind/provider/category/quantity
 * and status without executing agents.
 *
 * @returns The usage_event record ID
 */
export async function insertTestUsageEvent(
  orgId: string,
  options: {
    userId?: string;
    kind?: string;
    provider?: string;
    category?: string;
    quantity?: number;
    status?: string;
    creditsCharged?: number;
    idempotencyKey?: string;
    processedAt?: Date | null;
  },
): Promise<string> {
  initServices();
  const processedAt =
    options.processedAt !== undefined
      ? options.processedAt
      : options.status === "processed"
        ? new Date()
        : null;

  const [record] = await globalThis.services.db
    .insert(usageEvent)
    .values({
      orgId,
      userId: options.userId ?? "test-user",
      kind: options.kind ?? "connector",
      provider: options.provider ?? "x",
      category: options.category ?? "tweet.read",
      quantity: options.quantity ?? 1,
      status: options.status ?? "pending",
      creditsCharged: options.creditsCharged ?? null,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      processedAt,
    })
    .returning({ id: usageEvent.id });
  return record!.id;
}

/**
 * Insert a credit_usage record for testing.
 * Creates the required compose, version, and run records as FK dependencies.
 *
 * @why-db-direct Credit usage records are created by agent event webhooks
 * during run execution. Tests need precise control over token counts,
 * models, status, and FK relationships without running actual agents.
 *
 * @returns The credit_usage record ID
 */
export async function insertTestCreditUsage(
  orgId: string,
  options: {
    userId?: string;
    model?: string;
    modelProvider?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    webSearchRequests?: number;
    costUsd?: string;
    resultUuid?: string;
    messageId?: string;
    status?: string;
    creditsCharged?: number;
    processedAt?: Date | null;
  },
): Promise<string> {
  initServices();
  const userId = options.userId ?? "test-user";

  // Create compose for the run
  const composeName = `compose-${randomBytes(4).toString("hex")}`;
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name: composeName })
    .returning();

  // agentComposeVersions.id is a content-addressed SHA-256 hash
  const versionId = randomBytes(32).toString("hex");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: {},
    createdBy: userId,
  });

  const sessionId = await ensureTestAgentSession({
    userId,
    orgId,
    agentComposeId: compose!.id,
  });

  // Create a run (FK required by credit_usage)
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      prompt: "test",
      status: "completed",
      sessionId,
    })
    .returning();

  // Auto-set processedAt for processed records if not explicitly provided
  const processedAt =
    options.processedAt !== undefined
      ? options.processedAt
      : options.status === "processed"
        ? new Date()
        : null;

  const [record] = await globalThis.services.db
    .insert(creditUsage)
    .values({
      runId: run!.id,
      resultUuid: options.resultUuid ?? null,
      messageId: options.messageId ?? null,
      orgId,
      userId,
      model: options.model ?? "gpt-4",
      modelProvider: options.modelProvider ?? "",
      inputTokens: options.inputTokens ?? 1000,
      outputTokens: options.outputTokens ?? 500,
      cacheReadInputTokens: options.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: options.cacheCreationInputTokens ?? 0,
      webSearchRequests: options.webSearchRequests ?? 0,
      costUsd: options.costUsd ?? null,
      status: options.status ?? "pending",
      creditsCharged: options.creditsCharged ?? null,
      processedAt,
    })
    .returning();

  return record!.id;
}

/**
 * Insert a credit_usage record for an existing run.
 *
 * @why-db-direct Simplified credit usage insertion for a known run. Tests
 * need precise control over usage attributes without agent execution.
 */
export async function insertTestCreditUsageForRun(params: {
  runId: string;
  orgId: string;
  userId: string;
  messageId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  status?: string;
  creditsCharged?: number;
  processedAt?: Date | null;
}): Promise<{ id: string }> {
  initServices();
  const processedAt =
    params.processedAt !== undefined
      ? params.processedAt
      : params.status === "processed"
        ? new Date()
        : null;

  const [record] = await globalThis.services.db
    .insert(creditUsage)
    .values({
      runId: params.runId,
      orgId: params.orgId,
      userId: params.userId,
      model: "claude-3-5-sonnet-20241022",
      modelProvider: "anthropic",
      messageId: params.messageId ?? null,
      inputTokens: params.inputTokens ?? 100,
      outputTokens: params.outputTokens ?? 50,
      cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
      webSearchRequests: params.webSearchRequests ?? 0,
      status: params.status ?? "pending",
      creditsCharged: params.creditsCharged ?? null,
      processedAt,
    })
    .returning({ id: creditUsage.id });

  return { id: record!.id };
}

/**
 * Back-date an existing credit_usage record's createdAt for testing
 * date-range filtering.
 *
 * @why-db-direct No API supports timestamp manipulation on credit usage
 * records. Tests need specific createdAt values for date-range queries.
 */
export async function setTestCreditUsageCreatedAt(
  id: string,
  createdAt: Date,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(creditUsage)
    .set({ createdAt })
    .where(eq(creditUsage.id, id));
}

/**
 * Seed a credit_usage record for testing insights aggregation.
 *
 * @why-db-direct Seeds credit usage with specific createdAt for insights
 * aggregation tests. Normally created by agent webhooks, but tests need
 * controlled timestamps.
 */
export async function seedCreditUsageRecord(options: {
  runId: string;
  orgId: string;
  userId: string;
  creditsCharged: number;
  createdAt: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(creditUsage).values({
    runId: options.runId,
    orgId: options.orgId,
    userId: options.userId,
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokens: 100,
    outputTokens: 50,
    creditsCharged: options.creditsCharged,
    status: "processed",
    createdAt: options.createdAt,
  });
}

/**
 * Seed an insights_daily record for testing the insights API.
 *
 * @why-db-direct Seeds insights_daily records for testing the insights API.
 * Normally created by the aggregate-insights cron job. Tests need specific
 * aggregation states.
 */
export async function seedInsightsDaily(
  orgId: string,
  date: string,
  data: Record<string, unknown>,
  userId?: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(insightsDaily)
    .values({ orgId, userId: userId ?? "user_test_default", date, data })
    .onConflictDoUpdate({
      target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
      set: { data, updatedAt: new Date() },
    });
}

/**
 * Create a completed run with a specific completedAt timestamp.
 * Used by tests that need to control the completedAt time window.
 *
 * Also inserts a `zero_runs` row with a configurable modelProvider.  The
 * optional override lets tests simulate non-vm0 runs (user-paid providers) or
 * skip the `zero_runs` row entirely (plain agent runs) by passing `null`.
 *
 * @why-db-direct Run lifecycle is managed by the runner. Tests need precise
 * completedAt timestamp control for time-window queries.
 */
export async function createCompletedRun(
  orgId: string,
  userId: string,
  completedAt: Date,
  opts: { modelProvider?: string | null } = {},
): Promise<string> {
  initServices();
  const composeName = `compose-${randomBytes(4).toString("hex")}`;
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name: composeName })
    .returning();
  const versionId = randomBytes(32).toString("hex");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: {},
    createdBy: userId,
  });
  const sessionId = await ensureTestAgentSession({
    userId,
    orgId,
    agentComposeId: compose!.id,
  });
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      prompt: "test",
      status: "completed",
      completedAt,
      sessionId,
    })
    .returning();
  const modelProvider =
    opts.modelProvider === undefined ? "vm0" : opts.modelProvider;
  if (modelProvider !== null) {
    await globalThis.services.db.insert(zeroRuns).values({
      id: run!.id,
      triggerSource: "test",
      modelProvider,
    });
  }
  return run!.id;
}

// ---------------------------------------------------------------------------
// Transaction wrappers.
//
// These functions wrap production service functions that expect a transaction
// parameter (tx). They provide the transaction context for test usage.
// ---------------------------------------------------------------------------

/**
 * Grant credits to an org atomically. Wraps grantOrgCredits in a transaction.
 *
 * @why-db-direct Requires a database transaction wrapper to call grantOrgCredits
 * service; no API endpoint provides atomic credit grants
 */
export async function grantCreditsToOrg(
  orgId: string,
  amount: number,
): Promise<void> {
  initServices();
  await globalThis.services.db.transaction(async (tx) => {
    await grantOrgCredits(tx, orgId, amount);
  });
}

/**
 * Deduct from expires records within a transaction (test helper).
 *
 * @why-db-direct Requires a database transaction wrapper to call
 * deductFromExpiresRecords service; service expects tx parameter
 */
export async function testDeductFromExpiresRecords(
  orgId: string,
  amount: number,
): Promise<void> {
  initServices();
  await globalThis.services.db.transaction(async (tx) => {
    await deductFromExpiresRecords(tx, orgId, amount);
  });
}

/**
 * Expire credits within a transaction (test helper).
 * Returns the total expired amount.
 *
 * @why-db-direct Requires a database transaction wrapper to call expireCredits
 * service; service expects tx parameter
 */
export async function testExpireCredits(orgId: string): Promise<number> {
  initServices();
  let result = 0;
  await globalThis.services.db.transaction(async (tx) => {
    result = await expireCredits(tx, orgId);
  });
  return result;
}
