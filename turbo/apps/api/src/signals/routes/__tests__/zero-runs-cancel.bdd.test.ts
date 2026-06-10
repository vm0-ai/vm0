import { randomUUID } from "node:crypto";

import {
  zeroRunsCancelContract,
  zeroRunsByIdContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

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

// BDD migration of the legacy `zero-runs-cancel.test.ts`.
// The 17 legacy `it()`s collapse into 5 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org → 403 sandbox
// without `agent-run:write`), (2) 200 success + state +
// concurrent + idempotent chain (200 cancels running +
// publishes → 200 concurrent cancel publishes once → 200
// deletes pending runner job → 200 deletes queued run
// queue entry → 200 already-cancelled is a no-op → 200
// drains the org queue and promotes the next queued run
// to pending), (3) 404 + 400 chain (404 unknown → 400
// RUN_NOT_CANCELLABLE for completed), (4) credits
// reconciliation chain (200 processes pending usage_event
// and deducts credits → 200 does NOT reconcile on the
// idempotent path), (5) Stripe auto-recharge chain (200
// triggers Stripe when balance crosses threshold → 200 no
// Stripe above threshold → 200 no Stripe for stale
// free-tier → 200 no Stripe when already pending).
//
// Service-Level Exceptions: the queue row removal
// (`agentRunQueue`/`runnerJobQueue`), the credit
// reconciliation (`usageEvent` + `orgMetadata.credits`),
// the queue drain promotion (`agentRuns.status` from
// queued → pending), and the auto-recharge state
// (`orgMetadata.autoRechargePendingAt`) are internal
// service state that has no public read API. They are
// verified via direct DB SELECTs because no
// user-reachable endpoint exposes them — recording as
// Open Helper Gaps.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function cancelClient() {
  return setupApp({ context })(zeroRunsCancelContract);
}

function getByIdClient() {
  return setupApp({ context })(zeroRunsByIdContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function fixture(): Promise<{
  readonly fixture: UsageInsightFixture;
  readonly composeId: string;
}> {
  const fx = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const compose = await store.set(
    seedCompose$,
    { orgId: fx.orgId, userId: fx.userId },
    context.signal,
  );
  mocks.clerk.session(fx.userId, fx.orgId);
  return { fixture: fx, composeId: compose.composeId };
}

async function seedRun(
  fx: UsageInsightFixture,
  composeId: string,
  status: string,
): Promise<string> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fx.orgId,
      userId: fx.userId,
      composeId,
      status,
    },
    context.signal,
  );
  return runId;
}

describe("BDD POST /api/zero/runs/:id/cancel — auth boundary", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 no-org → 403 sandbox without agent-run:write", async () => {
    // When + Then: 401 (no auth header).
    const unauth = await accept(
      cancelClient().cancel({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a Clerk session that resolves to a user
    // without an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      cancelClient().cancel({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a sandbox token WITHOUT the agent-run:write
    // capability.
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });

    // When + Then: 403 with the capability hint.
    const sandbox = await accept(
      cancelClient().cancel({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(sandbox.body.error.code).toBe("FORBIDDEN");
    expect(sandbox.body.error.message).toContain("agent-run:write");
  });
});

describe("BDD POST /api/zero/runs/:id/cancel — 404 + 400 chain", () => {
  it("gwt-wt-wt: 404 unknown run → 400 RUN_NOT_CANCELLABLE for completed run", async () => {
    // Given: a fresh fixture + session.
    await fixture();

    // When + Then: 404 for an unknown run id.
    const unknown = await accept(
      cancelClient().cancel({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    // Given: a completed run.
    const fx = await fixture();
    const completedRunId = await seedRun(fx.fixture, fx.composeId, "completed");

    // When + Then: 400 RUN_NOT_CANCELLABLE.
    const notCancellable = await accept(
      cancelClient().cancel({
        params: { id: completedRunId },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(notCancellable.body.error.code).toBe("RUN_NOT_CANCELLABLE");
    expect(notCancellable.body.error.message).toContain("cannot be cancelled");
  });
});

describe("BDD POST /api/zero/runs/:id/cancel — 200 success + state + concurrent + idempotent chain", () => {
  it("gwt-wt-wt: 200 cancels running + publishes → 200 concurrent cancel publishes once → 200 deletes pending runner job → 200 deletes queued run entry → 200 already-cancelled no side effects → 200 drains org queue", async () => {
    // Given: a running run.
    const fx = await fixture();
    const runningRunId = await seedRun(fx.fixture, fx.composeId, "running");
    context.mocks.ably.publish.mockClear();

    // When + Then: 200 + the run state is reflected in
    // the public GET endpoint + the side-effect
    // publishes are observed.
    const runningCancel = await accept(
      cancelClient().cancel({
        params: { id: runningRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(runningCancel.body).toStrictEqual({
      id: runningRunId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });
    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `runChanged:${runningRunId}`,
      { status: "cancelled" },
    );

    // Follow-up GET verifies the run state via the public API.
    const getById = await accept(
      getByIdClient().getById({
        params: { id: runningRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(getById.body.status).toBe("cancelled");

    // Given: a running run with a runnerGroup + two
    // concurrent cancel attempts.
    const concurrentFx = await fixture();
    const concurrentRunId = await seedRun(
      concurrentFx.fixture,
      concurrentFx.composeId,
      "running",
    );
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(agentRuns)
      .set({ runnerGroup: "vm0/test" })
      .where(eq(agentRuns.id, concurrentRunId));
    context.mocks.ably.publish.mockClear();

    // When + Then: 200 + only one cancel publish was
    // emitted (the second was a no-op already-cancelled).
    const concurrentResponses = await Promise.all(
      [0, 1].map(() => {
        return accept(
          cancelClient().cancel({
            params: { id: concurrentRunId },
            headers: authHeaders(),
          }),
          [200],
        );
      }),
    );
    expect(concurrentResponses).toHaveLength(2);
    await clearAllDetached();
    const cancelPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic, payload]) => {
        const runIdValue =
          payload && typeof payload === "object" && "runId" in payload
            ? (payload as { readonly runId?: unknown }).runId
            : undefined;
        return topic === "cancel" && runIdValue === concurrentRunId;
      },
    );
    expect(cancelPublishes).toHaveLength(1);

    // Given: a pending run with a runnerJobQueue row.
    // Service-Level Exception: runnerJobQueue row
    // removal is verified by direct DB SELECT (Open
    // Helper Gap — no public read API for the job queue).
    const pendingFx = await fixture();
    const pendingRunId = await seedRun(
      pendingFx.fixture,
      pendingFx.composeId,
      "pending",
    );
    await writeDb.insert(runnerJobQueue).values({
      runId: pendingRunId,
      runnerGroup: "vm0/test",
      profile: "vm0/default",
      sessionId: null,
      executionContext: {
        storageManifest: null,
        environment: null,
        resumeSession: null,
        encryptedSecrets: null,
        cliAgentType: "claude-code",
      },
      expiresAt: new Date(now() + 60_000),
    });

    // When + Then: 200 + the pending job row is removed.
    await accept(
      cancelClient().cancel({
        params: { id: pendingRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    const remainingJobs = await writeDb
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, pendingRunId));
    expect(remainingJobs).toHaveLength(0);

    // Given: a queued run with an agentRunQueue row.
    // Service-Level Exception: agentRunQueue row removal
    // is verified by direct DB SELECT (Open Helper Gap).
    const queuedFx = await fixture();
    const queuedRunId = await seedRun(
      queuedFx.fixture,
      queuedFx.composeId,
      "queued",
    );
    await writeDb.insert(agentRunQueue).values({
      runId: queuedRunId,
      orgId: queuedFx.fixture.orgId,
      userId: queuedFx.fixture.userId,
      createdAt: nowDate(),
      expiresAt: new Date(now() + 60_000),
    });

    // When + Then: 200 + the run transitions to
    // cancelled (verified via follow-up GET) + the
    // queue row is removed.
    await accept(
      cancelClient().cancel({
        params: { id: queuedRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    const queuedGet = await accept(
      getByIdClient().getById({
        params: { id: queuedRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(queuedGet.body.status).toBe("cancelled");
    const queueRows = await writeDb
      .select({ runId: agentRunQueue.runId })
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queuedRunId));
    expect(queueRows).toHaveLength(0);

    // Given: an already-cancelled run.
    const cancelledFx = await fixture();
    const alreadyCancelledRunId = await seedRun(
      cancelledFx.fixture,
      cancelledFx.composeId,
      "cancelled",
    );
    context.mocks.ably.publish.mockClear();

    // When + Then: 200 + no publish (idempotent no-op).
    const alreadyCancelled = await accept(
      cancelClient().cancel({
        params: { id: alreadyCancelledRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(alreadyCancelled.body).toStrictEqual({
      id: alreadyCancelledRunId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });
    await clearAllDetached();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a running run + a queued run with a queue
    // row. Service-Level Exception: the queue drain
    // promotion of the next queued run to pending is
    // verified by direct DB SELECT (Open Helper Gap —
    // no public API to read the org queue).
    const drainFx = await fixture();
    const drainRunningId = await seedRun(
      drainFx.fixture,
      drainFx.composeId,
      "running",
    );
    const drainQueuedId = await seedRun(
      drainFx.fixture,
      drainFx.composeId,
      "queued",
    );
    await writeDb.insert(agentRunQueue).values({
      runId: drainQueuedId,
      orgId: drainFx.fixture.orgId,
      userId: drainFx.fixture.userId,
      createdAt: nowDate(),
      expiresAt: new Date(now() + 60_000),
    });

    // When + Then: 200 + the running run is cancelled
    // + the queued run is promoted to pending + the
    // queue row is removed.
    await accept(
      cancelClient().cancel({
        params: { id: drainRunningId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    const drainCancelledGet = await accept(
      getByIdClient().getById({
        params: { id: drainRunningId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(drainCancelledGet.body.status).toBe("cancelled");

    const [drainQueuedRow] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, drainQueuedId));
    expect(drainQueuedRow?.status).toBe("pending");

    const drainQueueRows = await writeDb
      .select({ runId: agentRunQueue.runId })
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, drainQueuedId));
    expect(drainQueueRows).toHaveLength(0);
  });
});

describe("BDD POST /api/zero/runs/:id/cancel — credits reconciliation chain", () => {
  it("gwt-wt-wt: 200 processes pending usage_event + deducts credits → 200 does NOT reconcile on the idempotent path", async () => {
    // Given: a running run with a pending usage_event
    // priced at 1 credit per 1000 input tokens. The
    // event quantity is 5000 → 5 credits. Initial org
    // balance is 1000.
    // Service-Level Exception: usageEvent and
    // orgMetadata.credits are internal service state
    // verified by direct DB SELECT (Open Helper Gap —
    // no public API exposes credit balance).
    const fx = await fixture();
    const runId = await seedRun(fx.fixture, fx.composeId, "running");
    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    await writeDb
      .update(orgMetadata)
      .set({ credits: 1000, tier: "free" })
      .where(eq(orgMetadata.orgId, fx.fixture.orgId));
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1000,
    });
    await writeDb.insert(usageEvent).values({
      orgId: fx.fixture.orgId,
      userId: fx.fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 5000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    // When + Then: 200 + the usage event is marked
    // processed (5 credits) + the org balance is
    // reduced by 5.
    await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    const [eventRow] = await writeDb
      .select({
        status: usageEvent.status,
        creditsCharged: usageEvent.creditsCharged,
      })
      .from(usageEvent)
      .where(eq(usageEvent.runId, runId));
    expect(eventRow?.status).toBe("processed");
    expect(eventRow?.creditsCharged).toBe(5);
    const [orgRow] = await writeDb
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fx.fixture.orgId));
    expect(orgRow?.credits).toBe(995);

    // Cleanup the inserted pricing row.
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );

    // Given: a fresh already-cancelled run with a
    // pending usage_event + 1000 credits.
    const idempotentFx = await fixture();
    const idempotentRunId = await seedRun(
      idempotentFx.fixture,
      idempotentFx.composeId,
      "cancelled",
    );
    await writeDb
      .update(orgMetadata)
      .set({ credits: 1000, tier: "free" })
      .where(eq(orgMetadata.orgId, idempotentFx.fixture.orgId));
    await writeDb.insert(usageEvent).values({
      orgId: idempotentFx.fixture.orgId,
      userId: idempotentFx.fixture.userId,
      runId: idempotentRunId,
      kind: "model",
      provider: "test-provider",
      category: "tokens.input",
      quantity: 5000,
      status: "pending",
      idempotencyKey: randomUUID(),
    });

    // When + Then: 200 + the idempotent path returns
    // early — the usage_event stays pending and the
    // balance is untouched.
    await accept(
      cancelClient().cancel({
        params: { id: idempotentRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    const [idempotentEventRow] = await writeDb
      .select({ status: usageEvent.status })
      .from(usageEvent)
      .where(eq(usageEvent.runId, idempotentRunId));
    expect(idempotentEventRow?.status).toBe("pending");
    const [idempotentOrgRow] = await writeDb
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, idempotentFx.fixture.orgId));
    expect(idempotentOrgRow?.credits).toBe(1000);
  });
});

describe("BDD POST /api/zero/runs/:id/cancel — Stripe auto-recharge chain", () => {
  it("gwt-wt-wt: 200 triggers Stripe when balance crosses threshold → 200 no Stripe above threshold → 200 no Stripe for stale free-tier → 200 no Stripe when already pending", async () => {
    // Given: a running run on a paid team org with
    // auto-recharge enabled. Initial credits 600, a
    // pending usage_event that drops the balance
    // 600 → 400 (≤ threshold 500), and a stubbed
    // Stripe customers.retrieve / invoices.create /
    // invoices.finalizeInvoice / invoices.pay surface.
    // Service-Level Exception: orgMetadata state
    // (credits, autoRechargePendingAt) is verified by
    // direct DB SELECT (Open Helper Gap).
    const fx = await fixture();
    const runId = await seedRun(fx.fixture, fx.composeId, "running");
    const writeDb = store.set(writeDb$);
    const provider = `test-provider-${randomUUID().slice(0, 8)}`;
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    await writeDb
      .update(orgMetadata)
      .set({
        credits: 600,
        tier: "team",
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        autoRechargeEnabled: true,
        autoRechargeThreshold: 500,
        autoRechargeAmount: 10_000,
      })
      .where(eq(orgMetadata.orgId, fx.fixture.orgId));
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    await writeDb.insert(usageEvent).values({
      orgId: fx.fixture.orgId,
      userId: fx.fixture.userId,
      runId,
      kind: "model",
      provider,
      category: "tokens.input",
      quantity: 200,
      status: "pending",
      idempotencyKey: randomUUID(),
    });
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

    // When + Then: 200 + the Stripe invoice was
    // created with the expected metadata + the atomic
    // claim set the autoRechargePendingAt timestamp.
    await accept(
      cancelClient().cancel({
        params: { id: runId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        auto_advance: false,
        default_payment_method: "pm_test",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: fx.fixture.orgId,
          creditsAmount: "10000",
        }),
      }),
    );
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      "in_test",
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith("in_test");
    const [rechargeOrgRow] = await writeDb
      .select({ pendingAt: orgMetadata.autoRechargePendingAt })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fx.fixture.orgId));
    expect(rechargeOrgRow?.pendingAt).toBeInstanceOf(Date);

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );

    // Given: a fresh running run on a paid team org
    // with credits well above the threshold + a small
    // pending event.
    const aboveFx = await fixture();
    const aboveRunId = await seedRun(
      aboveFx.fixture,
      aboveFx.composeId,
      "running",
    );
    const aboveProvider = `test-provider-${randomUUID().slice(0, 8)}`;
    const aboveCustomerId = `cus_${randomUUID().slice(0, 8)}`;
    await writeDb
      .update(orgMetadata)
      .set({
        credits: 100_000,
        tier: "team",
        stripeCustomerId: aboveCustomerId,
        stripeSubscriptionId: null,
        autoRechargeEnabled: true,
        autoRechargeThreshold: 500,
        autoRechargeAmount: 10_000,
      })
      .where(eq(orgMetadata.orgId, aboveFx.fixture.orgId));
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider: aboveProvider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    await writeDb.insert(usageEvent).values({
      orgId: aboveFx.fixture.orgId,
      userId: aboveFx.fixture.userId,
      runId: aboveRunId,
      kind: "model",
      provider: aboveProvider,
      category: "tokens.input",
      quantity: 5,
      status: "pending",
      idempotencyKey: randomUUID(),
    });
    context.mocks.stripe.invoices.create.mockClear();

    // When + Then: 200 + no Stripe call (balance above
    // threshold → atomic claim returns no rows).
    await accept(
      cancelClient().cancel({
        params: { id: aboveRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, aboveProvider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );

    // Given: a fresh running run on a free-tier org
    // (autoRechargeEnabled is moot on free tier — the
    // config is "stale" from a tier downgrade).
    const freeFx = await fixture();
    const freeRunId = await seedRun(
      freeFx.fixture,
      freeFx.composeId,
      "running",
    );
    const freeProvider = `test-provider-${randomUUID().slice(0, 8)}`;
    const freeCustomerId = `cus_${randomUUID().slice(0, 8)}`;
    await writeDb
      .update(orgMetadata)
      .set({
        credits: 400,
        tier: "free",
        stripeCustomerId: freeCustomerId,
        stripeSubscriptionId: null,
        autoRechargeEnabled: true,
        autoRechargeThreshold: 500,
        autoRechargeAmount: 10_000,
        autoRechargePendingAt: null,
      })
      .where(eq(orgMetadata.orgId, freeFx.fixture.orgId));
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider: freeProvider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    await writeDb.insert(usageEvent).values({
      orgId: freeFx.fixture.orgId,
      userId: freeFx.fixture.userId,
      runId: freeRunId,
      kind: "model",
      provider: freeProvider,
      category: "tokens.input",
      quantity: 50,
      status: "pending",
      idempotencyKey: randomUUID(),
    });
    context.mocks.stripe.invoices.create.mockClear();

    // When + Then: 200 + no Stripe call + the
    // autoRechargePendingAt remains null.
    await accept(
      cancelClient().cancel({
        params: { id: freeRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    const [freeOrgRow] = await writeDb
      .select({ pendingAt: orgMetadata.autoRechargePendingAt })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, freeFx.fixture.orgId));
    expect(freeOrgRow?.pendingAt).toBeNull();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, freeProvider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );

    // Given: a fresh running run on a paid team org
    // with autoRechargePendingAt within the 10-min
    // stale window — the atomic claim refuses
    // (already-pending).
    const pendingFx = await fixture();
    const pendingRunId = await seedRun(
      pendingFx.fixture,
      pendingFx.composeId,
      "running",
    );
    const pendingProvider = `test-provider-${randomUUID().slice(0, 8)}`;
    const pendingCustomerId = `cus_${randomUUID().slice(0, 8)}`;
    await writeDb
      .update(orgMetadata)
      .set({
        credits: 400,
        tier: "team",
        stripeCustomerId: pendingCustomerId,
        stripeSubscriptionId: null,
        autoRechargeEnabled: true,
        autoRechargeThreshold: 500,
        autoRechargeAmount: 10_000,
        autoRechargePendingAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, pendingFx.fixture.orgId));
    await writeDb.insert(usagePricing).values({
      kind: "model",
      provider: pendingProvider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    });
    await writeDb.insert(usageEvent).values({
      orgId: pendingFx.fixture.orgId,
      userId: pendingFx.fixture.userId,
      runId: pendingRunId,
      kind: "model",
      provider: pendingProvider,
      category: "tokens.input",
      quantity: 50,
      status: "pending",
      idempotencyKey: randomUUID(),
    });
    context.mocks.stripe.invoices.create.mockClear();

    // When + Then: 200 + no Stripe call (already-pending).
    await accept(
      cancelClient().cancel({
        params: { id: pendingRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    await clearAllDetached();
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, pendingProvider),
          eq(usagePricing.category, "tokens.input"),
        ),
      );
  });
});
