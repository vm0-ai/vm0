import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  getOrgBillingFields,
  updateOrgStripeFields,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request(
    "http://localhost:3000/api/cron/reconcile-billing-entitlements",
    {
      method: "GET",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    },
  );
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

describe("GET /api/cron/reconcile-billing-entitlements", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
    user = await context.setupUser();
  });

  it("rejects requests without the cron secret", async () => {
    const response = await GET(cronRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("downgrades stale past_due paid subscriptions without paid-through", async () => {
    const subId = uniqueId("sub-stale-past-due");

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-stale-past-due"),
      stripeSubscriptionId: subId,
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
      tier: "pro",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.downgraded).toBeGreaterThanOrEqual(1);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("free");
    expect(billing?.subscriptionStatus).toBe("past_due");
    expect(billing?.stripeSubscriptionId).toBe(subId);
  });

  it("downgrades stale unpaid subscriptions after paid-through expires", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-stale-unpaid"),
      stripeSubscriptionId: uniqueId("sub-stale-unpaid"),
      subscriptionStatus: "unpaid",
      currentPeriodEnd: hoursAgo(48),
      tier: "team",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("free");
    expect(billing?.subscriptionStatus).toBe("unpaid");
  });

  it("downgrades expired paid-through even if org metadata was recently updated", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-expired-recent-update"),
      stripeSubscriptionId: uniqueId("sub-expired-recent-update"),
      subscriptionStatus: "past_due",
      currentPeriodEnd: hoursAgo(48),
      tier: "pro",
      updatedAt: hoursAgo(1),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("free");
  });

  it("keeps stale past_due subscriptions with future paid-through", async () => {
    const paidThrough = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-future-past-due"),
      stripeSubscriptionId: uniqueId("sub-future-past-due"),
      subscriptionStatus: "past_due",
      currentPeriodEnd: paidThrough,
      tier: "pro",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("pro");
    expect(billing?.currentPeriodEnd).toEqual(paidThrough);
  });

  it("keeps fresh past_due subscriptions within the grace window", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-fresh-past-due"),
      stripeSubscriptionId: uniqueId("sub-fresh-past-due"),
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
      tier: "pro",
      updatedAt: hoursAgo(1),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("pro");
  });
});
