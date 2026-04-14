import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";
import { creditPricing } from "../../db/schema/credit-pricing";
import { creditExpiresRecord } from "../../db/schema/credit-expires-record";
import { creditUsage } from "../../db/schema/credit-usage";
import { clientCreditUsage } from "../../db/schema/client-credit-usage";
import { insightsDaily } from "../../db/schema/insights-daily";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";

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

// ---------------------------------------------------------------------------
// Usage / insights seeders.
// ---------------------------------------------------------------------------

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
 *
 * @why-db-direct Client credit usage records are created by agent event
 * webhooks. Tests need to seed specific client-side usage data with
 * controlled FK dependencies.
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
 * Used by proxy usage comparison tests that need to control the time window.
 *
 * @why-db-direct Run lifecycle is managed by the runner. Tests need precise
 * completedAt timestamp control for time-window queries.
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
