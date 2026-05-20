import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, randomUUID } from "crypto";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
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
import {
  REALTIME_PROVIDER,
  REALTIME_TOKEN_CATEGORIES,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
} from "../../lib/zero/billing/model-usage-categories";

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
 * these from scratch — the Stripe checkout webhook reads `stripeCustomerId`
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
    updatedAt?: Date;
  },
): Promise<void> {
  initServices();
  const { updatedAt, ...billingFields } = fields;
  await globalThis.services.db
    .update(orgMetadata)
    .set({ ...billingFields, updatedAt: updatedAt ?? new Date() })
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
 * Insert a credit expires record for testing.
 *
 * @why-db-direct Credit expires records are normally created by
 * subscription renewal handling. Tests need precise
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
 * Delete a usage_pricing row for tests that need to exercise missing-pricing
 * fallback/error paths.
 *
 * @why-db-direct Usage pricing is normally seeded by migrations/dev seed.
 * Tests that validate unconfigured billing paths need precise control over
 * this ledger row.
 */
export async function deleteTestUsagePricing(params: {
  kind: string;
  provider: string;
  category: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, params.kind),
        eq(usagePricing.provider, params.provider),
        eq(usagePricing.category, params.category),
      ),
    );
}

/**
 * Seed the full Realtime + transcription pricing matrix used by the
 * voice-chat realtime billing path (Plan D). Idempotent (each row upserts on
 * `(kind, provider, category)`), so it is safe to call from any test that
 * needs the realtime billable categories priced. Tests that exercise the
 * missing-pricing-503 path can call `deleteTestUsagePricing(...)` for one
 * specific (provider, category) pair after this helper has seeded the matrix.
 *
 * @why-db-direct Same rationale as `insertTestUsagePricing`. Pricing is
 * reference data normally managed via migrations/dev seed; tests need
 * precise control over which categories are present without touching the
 * production seeder.
 */
export async function seedRealtimeBillingPricing(): Promise<void> {
  const rows: Array<{ provider: string; category: string }> = [
    ...REALTIME_TOKEN_CATEGORIES.map((category) => {
      return { provider: REALTIME_PROVIDER, category };
    }),
    ...TRANSCRIPTION_TOKEN_CATEGORIES.map((category) => {
      return { provider: TRANSCRIPTION_PROVIDER, category };
    }),
  ];
  for (const row of rows) {
    await insertTestUsagePricing({
      kind: "model",
      provider: row.provider,
      category: row.category,
      unitPrice: 1,
      unitSize: 1_000_000,
    });
  }
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
    runId?: string | null;
    idempotencyKey?: string;
    /** activityTime for reporting tests: maps to usage_event.created_at. */
    createdAt?: Date;
    /** billingTime for reporting tests: maps to usage_event.processed_at. */
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
      runId: options.runId ?? null,
      orgId,
      userId: options.userId ?? "test-user",
      kind: options.kind ?? "connector",
      provider: options.provider ?? "x",
      category: options.category ?? "tweet.read",
      quantity: options.quantity ?? 1,
      status: options.status ?? "pending",
      creditsCharged: options.creditsCharged ?? null,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      processedAt,
    })
    .returning({ id: usageEvent.id });
  return record!.id;
}

/**
 * Delete usage_event records by provider for tests that use platform-wide
 * queries and cannot rely on org/user scoping for isolation.
 */
export async function deleteTestUsageEventsByProvider(
  providers: string[],
): Promise<void> {
  if (providers.length === 0) {
    return;
  }
  initServices();
  await globalThis.services.db
    .delete(usageEvent)
    .where(inArray(usageEvent.provider, providers));
}

async function insertModelUsageEventRows(params: {
  runId: string;
  orgId: string;
  userId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  status?: string;
  creditsCharged?: number | null;
  createdAt?: Date;
  processedAt?: Date | null;
}): Promise<string> {
  const status = params.status ?? "pending";
  const createdAt = params.createdAt ?? new Date();
  const processedAt =
    params.processedAt !== undefined
      ? params.processedAt
      : status === "processed"
        ? createdAt
        : null;
  const provider = params.model ?? "claude-sonnet-4-6";
  const quantities = [
    ["tokens.input", params.inputTokens ?? 0],
    ["tokens.output", params.outputTokens ?? 0],
    ["tokens.cache_read", params.cacheReadInputTokens ?? 0],
    ["tokens.cache_creation", params.cacheCreationInputTokens ?? 0],
  ] as const;
  const billableRows = quantities.filter(([_category, quantity], index) => {
    return index === 0 || quantity > 0;
  });

  const [record] = await globalThis.services.db
    .insert(usageEvent)
    .values(
      billableRows.map(([category, quantity], index) => {
        return {
          runId: params.runId,
          orgId: params.orgId,
          userId: params.userId,
          kind: "model",
          provider,
          category,
          quantity,
          status,
          creditsCharged: index === 0 ? (params.creditsCharged ?? null) : null,
          idempotencyKey: randomUUID(),
          createdAt,
          processedAt,
        };
      }),
    )
    .returning({ id: usageEvent.id });

  return record!.id;
}

/**
 * Insert model usage_event records for testing and create run dependencies.
 *
 * @why-db-direct Usage events are normally written by the agent usage-event
 * webhook. Tests need precise control over token counts, status, billing
 * timestamps, and FK relationships without running actual agents.
 *
 * @returns The first usage_event record ID
 */
export async function insertTestModelUsageEvent(
  orgId: string,
  options: {
    userId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
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

  // Create a run for run-scoped usage reporting.
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

  return insertModelUsageEventRows({
    runId: run!.id,
    orgId,
    userId,
    model: options.model,
    inputTokens: options.inputTokens ?? 1000,
    outputTokens: options.outputTokens ?? 500,
    cacheReadInputTokens: options.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: options.cacheCreationInputTokens ?? 0,
    status: options.status,
    creditsCharged: options.creditsCharged,
    processedAt: options.processedAt,
  });
}

/**
 * Insert model usage_event records for an existing run.
 *
 * @why-db-direct Simplified usage event insertion for a known run. Tests
 * need precise control over usage attributes without agent execution.
 */
export async function insertTestModelUsageEventForRun(params: {
  runId: string;
  orgId: string;
  userId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  status?: string;
  creditsCharged?: number;
  processedAt?: Date | null;
}): Promise<{ id: string }> {
  initServices();
  const id = await insertModelUsageEventRows({
    runId: params.runId,
    orgId: params.orgId,
    userId: params.userId,
    inputTokens: params.inputTokens ?? 100,
    outputTokens: params.outputTokens ?? 50,
    cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
    status: params.status,
    creditsCharged: params.creditsCharged,
    processedAt: params.processedAt,
  });

  return { id };
}

/**
 * Back-date a model usage_event group's createdAt for testing
 * date-range filtering.
 *
 * @why-db-direct No API supports timestamp manipulation on usage event
 * records. Tests need specific createdAt values for date-range queries.
 */
export async function setTestUsageEventCreatedAt(
  id: string,
  createdAt: Date,
): Promise<void> {
  initServices();
  const [record] = await globalThis.services.db
    .select({
      runId: usageEvent.runId,
      originalCreatedAt: usageEvent.createdAt,
    })
    .from(usageEvent)
    .where(eq(usageEvent.id, id))
    .limit(1);

  if (!record) return;

  await globalThis.services.db
    .update(usageEvent)
    .set({ createdAt })
    .where(
      record.runId
        ? and(
            eq(usageEvent.runId, record.runId),
            eq(usageEvent.createdAt, record.originalCreatedAt),
          )
        : eq(usageEvent.id, id),
    );
}

/**
 * Seed model usage_event records for testing insights aggregation.
 *
 * @why-db-direct Seeds usage events with specific createdAt/processedAt
 * timestamps for insights aggregation tests. Normally created by agent
 * webhooks, but tests need controlled timestamps.
 */
export async function seedUsageEventRecord(options: {
  runId: string;
  orgId: string;
  userId: string;
  creditsCharged: number;
  createdAt: Date;
  processedAt?: Date;
}): Promise<void> {
  initServices();
  await insertModelUsageEventRows({
    runId: options.runId,
    orgId: options.orgId,
    userId: options.userId,
    model: "claude-sonnet-4-20250514",
    inputTokens: 100,
    outputTokens: 50,
    creditsCharged: options.creditsCharged,
    status: "processed",
    createdAt: options.createdAt,
    processedAt: options.processedAt ?? options.createdAt,
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
  options: { updatedAt?: Date } = {},
): Promise<void> {
  initServices();
  const values = {
    orgId,
    userId: userId ?? "user_test_default",
    date,
    data,
    ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
  };
  await globalThis.services.db
    .insert(insightsDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [insightsDaily.orgId, insightsDaily.userId, insightsDaily.date],
      set: { data, updatedAt: options.updatedAt ?? new Date() },
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
