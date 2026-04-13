import { and, eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";
import { creditUsage } from "../../db/schema/credit-usage";
import { clientCreditUsage } from "../../db/schema/client-credit-usage";
import { creditPricing } from "../../db/schema/credit-pricing";
import { creditExpiresRecord } from "../../db/schema/credit-expires-record";
import { usageDaily } from "../../db/schema/usage-daily";
import { insightsDaily } from "../../db/schema/insights-daily";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { grantOrgCredits } from "../../lib/zero/org/org-service";
import {
  deductFromExpiresRecords,
  expireCredits,
} from "../../lib/zero/credit/credit-expires-service";

// ---------------------------------------------------------------------------
// org credit helpers
// ---------------------------------------------------------------------------

/**
 * Grant credits to an org atomically. Wraps grantOrgCredits in a transaction.
 */
export async function grantCreditsToOrg(
  orgId: string,
  amount: number,
): Promise<void> {
  await globalThis.services.db.transaction(async (tx) => {
    await grantOrgCredits(tx, orgId, amount);
  });
}

// ---------------------------------------------------------------------------
// Stripe billing helpers
// ---------------------------------------------------------------------------

/**
 * Set Stripe billing fields on an org in the `org_metadata` table.
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
  await globalThis.services.db
    .update(orgMetadata)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Read all billing-related fields from an org in the `org_metadata` table.
 */
export async function getOrgBillingFields(orgId: string) {
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

// ---------------------------------------------------------------------------
// Auto-recharge helpers
// ---------------------------------------------------------------------------

/**
 * Configure auto-recharge settings on an org.
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
  await globalThis.services.db
    .update(orgMetadata)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Read auto-recharge fields from an org.
 */
export async function getOrgAutoRechargeFields(orgId: string) {
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
 * Set Stripe subscription fields on org_metadata for testing billing-related flows.
 */
export async function updateOrgStripeSubscription(
  orgId: string,
  subscriptionId: string,
  status: string,
): Promise<void> {
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
 * Insert a credit_usage record for testing.
 * Creates the required compose, version, and run records as FK dependencies.
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

  // Create a run (FK required by credit_usage)
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      prompt: "test",
      status: "completed",
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
 * Insert a client_credit_usage record for testing.
 * Creates the required compose, version, and run records as FK dependencies
 * unless a runId is provided.
 */
export async function insertTestClientCreditUsage(
  orgId: string,
  options: {
    userId?: string;
    runId?: string;
    resultUuid?: string;
    model?: string;
    modelProvider?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    webSearchRequests?: number;
    costUsd?: string;
  },
): Promise<string> {
  initServices();
  const userId = options.userId ?? "test-user";

  let runId = options.runId;
  if (!runId) {
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

    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        agentComposeVersionId: versionId,
        prompt: "test",
        status: "completed",
      })
      .returning();
    runId = run!.id;
  }

  const [record] = await globalThis.services.db
    .insert(clientCreditUsage)
    .values({
      runId,
      resultUuid: options.resultUuid ?? null,
      orgId,
      userId,
      model: options.model ?? "claude-3-5-sonnet-20241022",
      modelProvider: options.modelProvider ?? "anthropic",
      inputTokens: options.inputTokens ?? 100,
      outputTokens: options.outputTokens ?? 50,
      cacheReadInputTokens: options.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: options.cacheCreationInputTokens ?? 0,
      webSearchRequests: options.webSearchRequests ?? 0,
      costUsd: options.costUsd ?? null,
    })
    .returning();

  return record!.id;
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
 * Look up a usage_daily record for verification in tests.
 */
export async function findUsageDaily(
  userId: string,
  orgId: string,
  date: string,
): Promise<{ runCount: number; runTimeMs: number } | undefined> {
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
 * Seed a credit_usage record for testing insights aggregation.
 */
export async function seedCreditUsageRecord(options: {
  runId: string;
  orgId: string;
  userId: string;
  creditsCharged: number;
  createdAt: Date;
}): Promise<void> {
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
 */
export async function seedInsightsDaily(
  orgId: string,
  date: string,
  data: Record<string, unknown>,
  userId?: string,
): Promise<void> {
  await globalThis.services.db
    .insert(insightsDaily)
    .values({ orgId, userId: userId ?? "user_test_default", date, data })
    .onConflictDoUpdate({
      target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
      set: { data, updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Proxy usage comparison helpers
// ---------------------------------------------------------------------------

/**
 * Create a completed run with a specific completedAt timestamp.
 * Used by proxy usage comparison tests that need to control the time window.
 */
export async function createCompletedRun(
  orgId: string,
  userId: string,
  completedAt: Date,
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
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      prompt: "test",
      status: "completed",
      completedAt,
    })
    .returning();
  return run!.id;
}

/**
 * Insert a proxy_credit_usage row for testing.
 */
export async function insertTestProxyCreditUsage(params: {
  runId: string;
  orgId: string;
  userId: string;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  const { proxyCreditUsage } =
    await import("../../db/schema/proxy-credit-usage");
  await globalThis.services.db.insert(proxyCreditUsage).values({
    runId: params.runId,
    orgId: params.orgId,
    userId: params.userId,
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokens: params.inputTokens ?? 100,
    outputTokens: params.outputTokens ?? 50,
  });
}

// ---------------------------------------------------------------------------
// Credit expires record helpers
// ---------------------------------------------------------------------------

/**
 * Insert a credit expires record for testing.
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
 * Deduct from expires records within a transaction (test helper).
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
 */
export async function testExpireCredits(orgId: string): Promise<number> {
  initServices();
  let result = 0;
  await globalThis.services.db.transaction(async (tx) => {
    result = await expireCredits(tx, orgId);
  });
  return result;
}
