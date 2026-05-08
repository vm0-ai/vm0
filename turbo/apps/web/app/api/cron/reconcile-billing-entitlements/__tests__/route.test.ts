import { describe, it, expect, beforeEach, vi } from "vitest";
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
import type { StripeMockFns } from "../../../../../src/__tests__/stripe-mock";
import { GET } from "../route";

const stripeMocks = vi.hoisted<StripeMockFns>(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    subscriptionsUpdate: vi.fn(),
    subscriptionsCancel: vi.fn(),
    invoicesRetrieve: vi.fn(),
    invoicesList: vi.fn(),
    customersCreate: vi.fn(),
    checkoutSessionsCreate: vi.fn(),
    billingPortalSessionsCreate: vi.fn(),
    constructEvent: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: {
          retrieve: stripeMocks.subscriptionsRetrieve,
          update: stripeMocks.subscriptionsUpdate,
          cancel: stripeMocks.subscriptionsCancel,
        },
        invoices: {
          retrieve: stripeMocks.invoicesRetrieve,
          list: stripeMocks.invoicesList,
        },
        customers: { create: stripeMocks.customersCreate },
        checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
        billingPortal: {
          sessions: { create: stripeMocks.billingPortalSessionsCreate },
        },
        webhooks: { constructEvent: stripeMocks.constructEvent },
      };
    },
  };
});

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_ZERO_PRICE = JSON.stringify({
  pro: [TEST_PRICE_PRO],
  team: [TEST_PRICE_TEAM],
});

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

function stripeSubscription(
  subscriptionId: string,
  options: {
    status: string;
    periodEnd?: Date | null;
    priceId?: string;
    cancelAtPeriodEnd?: boolean;
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

describe("GET /api/cron/reconcile-billing-entitlements", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("ZERO_PRICE", TEST_ZERO_PRICE);
    reloadEnv();
    user = await context.setupUser();

    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.subscriptionsRetrieve.mockImplementation(
      async (subscriptionId: string) => {
        return stripeSubscription(subscriptionId, {
          status: "past_due",
          periodEnd: hoursAgo(48),
        });
      },
    );
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

  it("downgrades payment-failed subscriptions when Stripe has no paid-through", async () => {
    const subId = uniqueId("sub-no-stripe-paid-through");

    stripeMocks.subscriptionsRetrieve.mockImplementation(
      async (subscriptionId: string) => {
        if (subscriptionId === subId) {
          return stripeSubscription(subscriptionId, {
            status: "past_due",
            periodEnd: null,
          });
        }
        return stripeSubscription(subscriptionId, {
          status: "past_due",
          periodEnd: hoursAgo(48),
        });
      },
    );

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-no-stripe-paid-through"),
      stripeSubscriptionId: subId,
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
      tier: "pro",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("free");
    expect(billing?.subscriptionStatus).toBe("past_due");
  });

  it("repairs missing local paid-through from Stripe instead of downgrading", async () => {
    const subId = uniqueId("sub-repair-paid-through");
    const stripePaidThroughUnix =
      Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const stripePaidThrough = new Date(stripePaidThroughUnix * 1000);

    stripeMocks.subscriptionsRetrieve.mockImplementation(
      async (subscriptionId: string) => {
        if (subscriptionId === subId) {
          return stripeSubscription(subscriptionId, {
            status: "past_due",
            periodEnd: stripePaidThrough,
          });
        }
        return stripeSubscription(subscriptionId, {
          status: "past_due",
          periodEnd: hoursAgo(48),
        });
      },
    );

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-repair-paid-through"),
      stripeSubscriptionId: subId,
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
      tier: "pro",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledWith(subId);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("pro");
    expect(billing?.subscriptionStatus).toBe("past_due");
    expect(billing?.currentPeriodEnd).toEqual(stripePaidThrough);
  });

  it("repairs recovered Stripe subscriptions instead of downgrading", async () => {
    const subId = uniqueId("sub-recovered");
    const stripePaidThroughUnix =
      Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const stripePaidThrough = new Date(stripePaidThroughUnix * 1000);

    stripeMocks.subscriptionsRetrieve.mockImplementation(
      async (subscriptionId: string) => {
        if (subscriptionId === subId) {
          return stripeSubscription(subscriptionId, {
            status: "active",
            periodEnd: stripePaidThrough,
            priceId: TEST_PRICE_TEAM,
          });
        }
        return stripeSubscription(subscriptionId, {
          status: "past_due",
          periodEnd: hoursAgo(48),
        });
      },
    );

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-recovered"),
      stripeSubscriptionId: subId,
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
      tier: "pro",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("team");
    expect(billing?.subscriptionStatus).toBe("active");
    expect(billing?.currentPeriodEnd).toEqual(stripePaidThrough);
  });

  it("downgrades canceled Stripe subscriptions as missed deleted hooks", async () => {
    const subId = uniqueId("sub-canceled");

    stripeMocks.subscriptionsRetrieve.mockImplementation(
      async (subscriptionId: string) => {
        if (subscriptionId === subId) {
          return stripeSubscription(subscriptionId, {
            status: "canceled",
            periodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });
        }
        return stripeSubscription(subscriptionId, {
          status: "past_due",
          periodEnd: hoursAgo(48),
        });
      },
    );

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-canceled"),
      stripeSubscriptionId: subId,
      subscriptionStatus: "past_due",
      currentPeriodEnd: null,
      tier: "pro",
      updatedAt: hoursAgo(48),
    });

    const response = await GET(cronRequest("test-cron-secret"));

    expect(response.status).toBe(200);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.tier).toBe("free");
    expect(billing?.subscriptionStatus).toBe("canceled");
    expect(billing?.stripeSubscriptionId).toBeNull();
  });

  it("downgrades stale unpaid subscriptions after paid-through expires", async () => {
    const subId = uniqueId("sub-stale-unpaid");
    stripeMocks.subscriptionsRetrieve.mockImplementation(
      async (subscriptionId: string) => {
        if (subscriptionId === subId) {
          return stripeSubscription(subscriptionId, {
            status: "unpaid",
            periodEnd: hoursAgo(48),
          });
        }
        return stripeSubscription(subscriptionId, {
          status: "past_due",
          periodEnd: hoursAgo(48),
        });
      },
    );

    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-stale-unpaid"),
      stripeSubscriptionId: subId,
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
