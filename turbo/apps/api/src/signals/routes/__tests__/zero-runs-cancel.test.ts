import { randomUUID } from "node:crypto";

import { zeroRunsCancelContract } from "@vm0/api-contracts/contracts/zero-runs";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("POST /api/zero/runs/:id/cancel", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 403 for sandbox token without agent-run:write capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId,
      orgId,
      runId,
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("agent-run:write");
  });

  it("returns 404 when run not found", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("cancels a running run (DB read-after-write + Ably runner cancel)", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      id: runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(row?.status).toBe("cancelled");

    // Settle the detached waitUntil work then assert Ably publish surface.
    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `runChanged:${runId}`,
      { status: "cancelled" },
    );
  });

  it("returns 400 RUN_NOT_CANCELLABLE when run already completed", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("RUN_NOT_CANCELLABLE");
    expect(response.body.error.message).toContain("cannot be cancelled");
  });

  it("returns 200 when run is already cancelled (idempotent; no side effects)", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "cancelled",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroRunsCancelContract);
    const response = await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      id: runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });

    // Idempotent path: NO Ably publishes scheduled.
    await clearAllDetached();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("drains the org queue and promotes the next queued run to pending", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: runningRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );
    const { runId: queuedRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "queued",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    await writeDb.insert(agentRunQueue).values({
      runId: queuedRunId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      createdAt: nowDate(),
      expiresAt: new Date(now() + 60_000),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runningRunId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Cancelled run reflects the cancel.
    const [cancelledRow] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runningRunId));
    expect(cancelledRow?.status).toBe("cancelled");

    // Queue drain promoted the queued run to pending.
    const [queuedRow] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, queuedRunId));
    expect(queuedRow?.status).toBe("pending");

    // Queue entry is gone.
    const queueRows = await writeDb
      .select()
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queuedRunId));
    expect(queueRows).toHaveLength(0);
  });

  it("processes pending usage_event records and deducts credits on cancel", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    // Seed initial credit balance.
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 1000,
      tier: "free",
    });
    // Seed pricing: 1 credit per 1000 input tokens.
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1000,
    });
    // Seed pending usage_event: 5000 input tokens → 5 credits.
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 5000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Event marked processed with creditsCharged.
    const [eventRow] = await writeDb
      .select({
        status: usageEvent.status,
        creditsCharged: usageEvent.creditsCharged,
      })
      .from(usageEvent)
      .where(eq(usageEvent.runId, runId));
    expect(eventRow?.status).toBe("processed");
    expect(eventRow?.creditsCharged).toBe(5);

    // Org credits reduced by 5.
    const [orgRow] = await writeDb
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(orgRow?.credits).toBe(995);

    // Cleanup the inserted pricing row to avoid bleed across tests.
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });

  it("does not reconcile credits on the idempotent path (run already cancelled)", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "cancelled",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 1000,
      tier: "free",
    });
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider: "test-provider",
      category: "tokens.input",
      quantity: 5000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Idempotent path returns early — usage_event still pending, balance untouched.
    const [eventRow] = await writeDb
      .select({ status: usageEvent.status })
      .from(usageEvent)
      .where(eq(usageEvent.runId, runId));
    expect(eventRow?.status).toBe("pending");

    const [orgRow] = await writeDb
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(orgRow?.credits).toBe(1000);
  });

  it("idempotent path does not drain the queue", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: cancelledRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "cancelled",
      },
      context.signal,
    );
    const { runId: queuedRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "queued",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    await writeDb.insert(agentRunQueue).values({
      runId: queuedRunId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      createdAt: nowDate(),
      expiresAt: new Date(now() + 60_000),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: cancelledRunId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Idempotent path skipped dispatchCancelSideEffects$ entirely; the
    // queue entry and queued run are untouched.
    const [queuedRow] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, queuedRunId));
    expect(queuedRow?.status).toBe("queued");

    const queueRows = await writeDb
      .select()
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queuedRunId));
    expect(queueRows).toHaveLength(1);
  });

  it("triggers Stripe auto-recharge when balance crosses threshold", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    // Seed paid org with auto-recharge enabled at threshold=500.
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 600,
      tier: "team",
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
      autoRechargeEnabled: true,
      autoRechargeThreshold: 500,
      autoRechargeAmount: 10_000,
    });
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    // 200 quantity × $1 / 1 unit = 200 credits → balance drops 600 → 400 (≤ 500).
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 200,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    // Stub Stripe responses.
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      deleted: false,
      invoice_settings: { default_payment_method: "pm_test" },
    });
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: "in_test",
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: "ii_test",
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_test",
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: "in_test",
      status: "paid",
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Stripe invoice created with the expected metadata.
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        auto_advance: false,
        default_payment_method: "pm_test",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: fixture.orgId,
          creditsAmount: "10000",
        }),
      }),
    );
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      "in_test",
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith("in_test");

    // pendingAt set by the atomic claim.
    const [orgRow] = await writeDb
      .select({ pendingAt: orgMetadata.autoRechargePendingAt })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(orgRow?.pendingAt).toBeInstanceOf(Date);

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });

  it("does not trigger auto-recharge when balance is above threshold", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 100_000,
      tier: "team",
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
      autoRechargeEnabled: true,
      autoRechargeThreshold: 500,
      autoRechargeAmount: 10_000,
    });
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 5,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Balance well above threshold → atomic claim returns no rows → no Stripe.
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });

  it("does not re-trigger auto-recharge when claim is already pending", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    // pendingAt within the 10-min stale-threshold window → atomic claim
    // refuses (already-pending).
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 400,
      tier: "team",
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
      autoRechargeEnabled: true,
      autoRechargeThreshold: 500,
      autoRechargeAmount: 10_000,
      autoRechargePendingAt: nowDate(),
    });
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 50,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // Already-pending → atomic claim returns no rows → no Stripe.
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });

  it("disables a member when processed usage meets the cap on cancel", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    // Paid org with billing period set so getOrgBillingPeriod resolves
    // without hitting Stripe.
    const periodEnd = new Date(now() + 30 * 24 * 60 * 60 * 1000);
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 1000,
      tier: "team",
      currentPeriodEnd: periodEnd,
    });
    // Member with a cap = 8 and creditEnabled = true.
    await writeDb.insert(orgMembersMetadata).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      creditCap: 8,
      creditEnabled: true,
    });
    // Pricing: 1 credit per 1000 input tokens.
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1000,
    });
    // Pre-existing processed usage from earlier in the period — 4 credits.
    // The cancel will add 5 more → cumulative 9, exceeds cap.
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 4000,
      creditsCharged: 4,
      status: "processed",
      processedAt: nowDate(),
      idempotencyKey: randomUUID(),
    });
    // Pending usage_event for this cancel: 5000 tokens → 5 credits.
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 5000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    const [memberRow] = await writeDb
      .select({ creditEnabled: orgMembersMetadata.creditEnabled })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    expect(memberRow?.creditEnabled).toBeFalsy();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });

  it("does not touch member caps when no usage events are processed", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    // Run in pending state — no usage_events accumulated; cancel triggers
    // processOrgUsageEvents$ but pendingRecords is empty so the cap path
    // short-circuits before reaching evaluateMemberCaps$.
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "pending",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const periodEnd = new Date(now() + 30 * 24 * 60 * 60 * 1000);
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 1000,
      tier: "team",
      currentPeriodEnd: periodEnd,
    });
    // Member with a cap of 1 and creditEnabled = true. Even though their
    // usage might already be over cap from prior periods, the cancel path
    // must NOT re-evaluate when no events are processed.
    await writeDb.insert(orgMembersMetadata).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      creditCap: 1,
      creditEnabled: true,
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    const [memberRow] = await writeDb
      .select({ creditEnabled: orgMembersMetadata.creditEnabled })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    expect(memberRow?.creditEnabled).toBeTruthy();
  });

  it("only re-evaluates the run-owner's cap, not other org members'", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "running",
      },
      context.signal,
    );

    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    const otherUserId = `user_other_${randomUUID().slice(0, 8)}`;
    const periodEnd = new Date(now() + 30 * 24 * 60 * 60 * 1000);
    await writeDb.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 1000,
      tier: "team",
      currentPeriodEnd: periodEnd,
    });
    // Run-owner: high cap, well under usage.
    await writeDb.insert(orgMembersMetadata).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      creditCap: 1000,
      creditEnabled: true,
    });
    // Other org member: low cap, already over usage from a prior batch
    // — would normally be flipped off if re-evaluated, but cancel of the
    // run-owner's run must not include the other user in affectedUserIds.
    await writeDb.insert(orgMembersMetadata).values({
      orgId: fixture.orgId,
      userId: otherUserId,
      creditCap: 1,
      creditEnabled: true,
    });
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1000,
    });
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: otherUserId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 999_000,
      creditsCharged: 999,
      status: "processed",
      processedAt: nowDate(),
      idempotencyKey: randomUUID(),
    });
    // Pending event for the run-owner only.
    await writeDb.insert(usageEvent).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 1000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await clearAllDetached();

    // The other user should remain enabled — they were not in the
    // affectedUserIds set passed to evaluateMemberCaps$.
    const [otherRow] = await writeDb
      .select({ creditEnabled: orgMembersMetadata.creditEnabled })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, otherUserId),
        ),
      );
    expect(otherRow?.creditEnabled).toBeTruthy();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });
});
