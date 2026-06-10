import { randomUUID } from "node:crypto";

import { cronReconcileBillingEntitlementsContract } from "@vm0/api-contracts/contracts/cron";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy
// `cron-reconcile-billing-entitlements.test.ts`. The 9
// legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// chain (401 invalid cron secret → 401 missing cron
// authorization), (2) downgrade + repair chain (200
// downgrades stale payment-failed subscriptions without
// paid-through → 200 repairs recovered Stripe subscriptions
// instead of downgrading → 200 repairs missing local
// paid-through from Stripe instead of downgrading → 200
// downgrades canceled Stripe subscriptions as missed
// deleted hooks), (3) grace-window + stale chain (200
// downgrades stale unpaid subscriptions after paid-through
// expires → 200 downgrades expired paid-through even if
// org metadata was recently updated → 200 keeps stale
// payment-failed subscriptions with future paid-through →
// 200 keeps fresh payment-failed subscriptions in the
// grace window).

const context = testContext();
const store = createStore();
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";

interface BillingFixture {
  readonly orgId: string;
  readonly subscriptionId: string;
}

function apiClient() {
  return setupApp({ context })(cronReconcileBillingEntitlementsContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

function hoursAgo(hours: number): Date {
  return new Date(nowDate().getTime() - hours * 60 * 60 * 1000);
}

function daysFromNow(days: number): Date {
  return new Date(nowDate().getTime() + days * 24 * 60 * 60 * 1000);
}

function stripePeriodDaysFromNow(days: number): Date {
  return new Date(Math.floor(daysFromNow(days).getTime() / 1000) * 1000);
}

function stripeSubscription(
  subscriptionId: string,
  options: {
    readonly status: string;
    readonly periodEnd?: Date | null;
    readonly priceId?: string;
    readonly cancelAtPeriodEnd?: boolean;
  },
) {
  return {
    id: subscriptionId,
    status: options.status,
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    items: {
      data: [
        {
          price: { id: options.priceId ?? TEST_PRICE_PRO },
          ...(options.periodEnd
            ? {
                current_period_end: Math.floor(
                  options.periodEnd.getTime() / 1000,
                ),
              }
            : {}),
        },
      ],
    },
  };
}

function mockRecoverableStripeSubscription(subscriptionId: string) {
  return stripeSubscription(subscriptionId, {
    status: "active",
    periodEnd: daysFromNow(30),
    priceId: TEST_PRICE_PRO,
  });
}

function stripeRetrieveSubscriptionId(args: readonly unknown[]): string {
  const [subscriptionId] = args;
  if (typeof subscriptionId !== "string") {
    throw new Error("Expected Stripe retrieve subscription ID");
  }
  return subscriptionId;
}

async function seedBillingOrg(args: {
  readonly status: string;
  readonly tier?: string;
  readonly currentPeriodEnd?: Date | null;
  readonly updatedAt?: Date;
}): Promise<BillingFixture> {
  const db = store.set(writeDb$);
  const orgId = `org_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  await db.insert(orgMetadata).values({
    orgId,
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: subscriptionId,
    subscriptionStatus: args.status,
    currentPeriodEnd: args.currentPeriodEnd ?? null,
    tier: args.tier ?? "pro",
    updatedAt: args.updatedAt ?? hoursAgo(48),
  });
  return { orgId, subscriptionId };
}

async function cleanupFixture(fixture: BillingFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
}

async function billingFields(orgId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      tier: orgMetadata.tier,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row;
}

describe("BDD GET /api/cron/reconcile-billing-entitlements — auth chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: [TEST_PRICE_PRO], team: [TEST_PRICE_TEAM] }),
    );
  });

  it("gwt-wt-wt: 401 invalid cron secret → 401 missing cron authorization", async () => {
    // Given: an invalid cron secret.

    // When + Then: 401 — invalid cron secret.
    const wrongSecret = await accept(
      apiClient().reconcile({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(wrongSecret.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: no authorization header.

    // When + Then: 401 — invalid cron secret.
    const noAuth = await accept(apiClient().reconcile({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/cron/reconcile-billing-entitlements — downgrade + repair chain", () => {
  const track = createFixtureTracker<BillingFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: [TEST_PRICE_PRO], team: [TEST_PRICE_TEAM] }),
    );
  });

  it("gwt-wt-wt: 200 downgrades stale payment-failed subscriptions without paid-through → 200 repairs recovered Stripe subscriptions instead of downgrading → 200 repairs missing local paid-through from Stripe instead of downgrading → 200 downgrades canceled Stripe subscriptions as missed deleted hooks", async () => {
    // Given: a stale payment-failed org without
    // paid-through.
    const staleFixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: null }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (...args: unknown[]) => {
        const subscriptionId = stripeRetrieveSubscriptionId(args);
        if (subscriptionId === staleFixture.subscriptionId) {
          return Promise.resolve(
            stripeSubscription(staleFixture.subscriptionId, {
              status: "past_due",
              periodEnd: null,
            }),
          );
        }
        return Promise.resolve(
          mockRecoverableStripeSubscription(subscriptionId),
        );
      },
    );

    // When + Then: 200 — downgraded to `pro-suspend`.
    const staleResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(staleResponse.body).toStrictEqual({
      success: true,
      downgraded: 1,
    });
    await expect(billingFields(staleFixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "past_due",
      stripeSubscriptionId: staleFixture.subscriptionId,
    });

    // Given: a fresh org with `past_due` + Stripe
    // returns `active` with paid-through.
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    const recoveredFixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: null }),
    );
    const paidThrough = new Date(
      Math.floor((nowDate().getTime() + 30 * 24 * 60 * 60 * 1000) / 1000) *
        1000,
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (...args: unknown[]) => {
        const subscriptionId = stripeRetrieveSubscriptionId(args);
        if (subscriptionId === recoveredFixture.subscriptionId) {
          return Promise.resolve(
            stripeSubscription(recoveredFixture.subscriptionId, {
              status: "active",
              periodEnd: paidThrough,
              priceId: TEST_PRICE_TEAM,
            }),
          );
        }
        return Promise.resolve(
          mockRecoverableStripeSubscription(subscriptionId),
        );
      },
    );

    // When + Then: 200 — repaired to `team` + active.
    const recoveredResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(recoveredResponse.body).toStrictEqual({
      success: true,
      downgraded: 0,
    });
    await expect(billingFields(recoveredFixture.orgId)).resolves.toMatchObject({
      tier: "team",
      subscriptionStatus: "active",
      currentPeriodEnd: paidThrough,
    });

    // Given: an org missing local paid-through + Stripe
    // returns `past_due` with a paid-through date.
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    const repairFixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: null }),
    );
    const repairPaidThrough = stripePeriodDaysFromNow(7);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(repairFixture.subscriptionId, {
        status: "past_due",
        periodEnd: repairPaidThrough,
      }),
    );

    // When + Then: 200 — Stripe is called + paid-through
    // is repaired.
    const repairResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(repairResponse.body).toStrictEqual({
      success: true,
      downgraded: 0,
    });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      repairFixture.subscriptionId,
    );
    await expect(billingFields(repairFixture.orgId)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
      currentPeriodEnd: repairPaidThrough,
    });

    // Given: an org with expired paid-through + Stripe
    // returns `canceled`.
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    const canceledFixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: hoursAgo(48) }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(canceledFixture.subscriptionId, {
        status: "canceled",
        periodEnd: daysFromNow(7),
      }),
    );

    // When + Then: 200 — downgraded to `pro-suspend` +
    // subscriptionId + paid-through are cleared.
    const canceledResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(canceledResponse.body).toStrictEqual({
      success: true,
      downgraded: 1,
    });
    await expect(billingFields(canceledFixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });
  });
});

describe("BDD GET /api/cron/reconcile-billing-entitlements — grace-window + stale chain", () => {
  const track = createFixtureTracker<BillingFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: [TEST_PRICE_PRO], team: [TEST_PRICE_TEAM] }),
    );
  });

  it("gwt-wt-wt: 200 downgrades stale unpaid subscriptions after paid-through expires → 200 downgrades expired paid-through even if org metadata was recently updated → 200 keeps stale payment-failed subscriptions with future paid-through → 200 keeps fresh payment-failed subscriptions in the grace window", async () => {
    // Given: a stale unpaid team subscription with
    // expired paid-through.
    const unpaidFixture = await track(
      seedBillingOrg({
        status: "unpaid",
        currentPeriodEnd: hoursAgo(48),
        tier: "team",
      }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(unpaidFixture.subscriptionId, {
        status: "unpaid",
        periodEnd: hoursAgo(48),
      }),
    );

    // When + Then: 200 — downgraded to `pro-suspend`.
    const unpaidResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(unpaidResponse.body).toStrictEqual({
      success: true,
      downgraded: 1,
    });
    await expect(billingFields(unpaidFixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "unpaid",
      stripeSubscriptionId: unpaidFixture.subscriptionId,
    });

    // Given: an org with expired paid-through but
    // recently updated metadata + Stripe returns
    // `past_due`.
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    const expiredFixture = await track(
      seedBillingOrg({
        status: "past_due",
        currentPeriodEnd: hoursAgo(48),
        updatedAt: hoursAgo(1),
      }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(expiredFixture.subscriptionId, {
        status: "past_due",
        periodEnd: hoursAgo(48),
      }),
    );

    // When + Then: 200 — downgraded to `pro-suspend`.
    const expiredResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(expiredResponse.body).toStrictEqual({
      success: true,
      downgraded: 1,
    });
    await expect(billingFields(expiredFixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "past_due",
    });

    // Given: a stale payment-failed org with future
    // paid-through.

    // When + Then: 200 — kept; Stripe is NOT called.
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    const futurePaidThrough = daysFromNow(7);
    const futureFixture = await track(
      seedBillingOrg({
        status: "past_due",
        currentPeriodEnd: futurePaidThrough,
        updatedAt: hoursAgo(48),
      }),
    );

    const futureResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(futureResponse.body).toStrictEqual({
      success: true,
      downgraded: 0,
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    await expect(billingFields(futureFixture.orgId)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
      currentPeriodEnd: futurePaidThrough,
    });

    // Given: a fresh payment-failed org in the grace
    // window (no paid-through, recently updated).

    // When + Then: 200 — kept; Stripe is NOT called for
    // this subscription.
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    const graceFixture = await track(
      seedBillingOrg({
        status: "past_due",
        currentPeriodEnd: null,
        updatedAt: hoursAgo(1),
      }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (...args: unknown[]) => {
        const subscriptionId = stripeRetrieveSubscriptionId(args);
        return Promise.resolve(
          mockRecoverableStripeSubscription(subscriptionId),
        );
      },
    );

    const graceResponse = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );
    expect(graceResponse.body).toStrictEqual({
      success: true,
      downgraded: 0,
    });
    expect(
      context.mocks.stripe.subscriptions.retrieve,
    ).not.toHaveBeenCalledWith(graceFixture.subscriptionId);
    await expect(billingFields(graceFixture.orgId)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
    });
  });
});
