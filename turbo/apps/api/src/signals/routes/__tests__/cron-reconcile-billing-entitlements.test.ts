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

describe("GET /api/cron/reconcile-billing-entitlements", () => {
  const track = createFixtureTracker<BillingFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: [TEST_PRICE_PRO], team: [TEST_PRICE_TEAM] }),
    );
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with missing cron authorization", async () => {
    const response = await accept(
      apiClient().reconcile({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("downgrades stale payment-failed subscriptions without paid-through", async () => {
    const fixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: null }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (...args: unknown[]) => {
        const subscriptionId = stripeRetrieveSubscriptionId(args);
        if (subscriptionId === fixture.subscriptionId) {
          return Promise.resolve(
            stripeSubscription(fixture.subscriptionId, {
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

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "past_due",
      stripeSubscriptionId: fixture.subscriptionId,
    });
  });

  it("repairs recovered Stripe subscriptions instead of downgrading", async () => {
    const fixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: null }),
    );
    const paidThrough = new Date(
      Math.floor((nowDate().getTime() + 30 * 24 * 60 * 60 * 1000) / 1000) *
        1000,
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (...args: unknown[]) => {
        const subscriptionId = stripeRetrieveSubscriptionId(args);
        if (subscriptionId === fixture.subscriptionId) {
          return Promise.resolve(
            stripeSubscription(fixture.subscriptionId, {
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

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "team",
      subscriptionStatus: "active",
      currentPeriodEnd: paidThrough,
    });
  });

  it("repairs missing local paid-through from Stripe instead of downgrading", async () => {
    const fixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: null }),
    );
    const paidThrough = stripePeriodDaysFromNow(7);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture.subscriptionId, {
        status: "past_due",
        periodEnd: paidThrough,
      }),
    );

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      fixture.subscriptionId,
    );
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
      currentPeriodEnd: paidThrough,
    });
  });

  it("downgrades canceled Stripe subscriptions as missed deleted hooks", async () => {
    const fixture = await track(
      seedBillingOrg({ status: "past_due", currentPeriodEnd: hoursAgo(48) }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture.subscriptionId, {
        status: "canceled",
        periodEnd: daysFromNow(7),
      }),
    );

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });
  });

  it("downgrades stale unpaid subscriptions after paid-through expires", async () => {
    const fixture = await track(
      seedBillingOrg({
        status: "unpaid",
        currentPeriodEnd: hoursAgo(48),
        tier: "team",
      }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture.subscriptionId, {
        status: "unpaid",
        periodEnd: hoursAgo(48),
      }),
    );

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "unpaid",
      stripeSubscriptionId: fixture.subscriptionId,
    });
  });

  it("downgrades expired paid-through even if org metadata was recently updated", async () => {
    const fixture = await track(
      seedBillingOrg({
        status: "past_due",
        currentPeriodEnd: hoursAgo(48),
        updatedAt: hoursAgo(1),
      }),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture.subscriptionId, {
        status: "past_due",
        periodEnd: hoursAgo(48),
      }),
    );

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro-suspend",
      subscriptionStatus: "past_due",
    });
  });

  it("keeps stale payment-failed subscriptions with future paid-through", async () => {
    const paidThrough = daysFromNow(7);
    const fixture = await track(
      seedBillingOrg({
        status: "past_due",
        currentPeriodEnd: paidThrough,
        updatedAt: hoursAgo(48),
      }),
    );

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
      currentPeriodEnd: paidThrough,
    });
  });

  it("keeps fresh payment-failed subscriptions in the grace window", async () => {
    const fixture = await track(
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

    const response = await accept(
      apiClient().reconcile({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    expect(
      context.mocks.stripe.subscriptions.retrieve,
    ).not.toHaveBeenCalledWith(fixture.subscriptionId);
    await expect(billingFields(fixture.orgId)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
    });
  });
});
