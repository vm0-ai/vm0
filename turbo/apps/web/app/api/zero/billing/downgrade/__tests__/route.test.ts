import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgStripeFields,
  getOrgBillingFields,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../../src/__tests__/stripe-mock";
import { reloadEnv } from "../../../../../../src/env";

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

import { POST } from "../route";

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";

const context = testContext();

function createDowngradeRequest(
  body: Record<string, unknown>,
): ReturnType<typeof createTestRequest> {
  return createTestRequest("http://localhost:3000/api/zero/billing/downgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/zero/billing/downgrade", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: [TEST_PRICE_PRO], team: [TEST_PRICE_TEAM] }),
    );
    reloadEnv();

    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.subscriptionsUpdate.mockReset();
    stripeMocks.subscriptionsCancel.mockReset();
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();

    const request = createDowngradeRequest({ targetTier: "free" });
    const response = await POST(request);

    expect(response.status).toBe(503);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createDowngradeRequest({ targetTier: "free" });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin member", async () => {
    const { userId, orgId } = await context.setupUser({
      prefix: "member-downgrade",
    });
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createDowngradeRequest({ targetTier: "free" });
    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid targetTier", async () => {
    const request = createDowngradeRequest({ targetTier: "team" });
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("returns 409 when org has no subscription", async () => {
    const request = createDowngradeRequest({ targetTier: "free" });
    const response = await POST(request);

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("CONFLICT");
  });

  it("returns 400 when target tier is same or higher", async () => {
    const subId = uniqueId("sub-same");
    await updateOrgStripeFields(user.orgId, {
      stripeSubscriptionId: subId,
      tier: "pro",
      subscriptionStatus: "active",
    });

    const request = createDowngradeRequest({ targetTier: "pro" });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("downgrades team to pro via subscription update", async () => {
    const subId = uniqueId("sub-team-pro");
    await updateOrgStripeFields(user.orgId, {
      stripeSubscriptionId: subId,
      tier: "team",
      subscriptionStatus: "active",
    });

    stripeMocks.subscriptionsRetrieve.mockResolvedValue({
      id: subId,
      items: { data: [{ id: "si_item_1", price: { id: TEST_PRICE_TEAM } }] },
    });
    stripeMocks.subscriptionsUpdate.mockResolvedValue({
      id: subId,
      items: { data: [{ id: "si_item_1", price: { id: TEST_PRICE_PRO } }] },
    });

    const request = createDowngradeRequest({ targetTier: "pro" });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.effectiveDate).toBeNull();

    expect(stripeMocks.subscriptionsUpdate).toHaveBeenCalledWith(subId, {
      items: [{ id: "si_item_1", price: TEST_PRICE_PRO }],
      proration_behavior: "always_invoice",
    });
  });

  it("downgrades pro to free via cancel at period end", async () => {
    const subId = uniqueId("sub-pro-free");
    const periodEnd = new Date(Date.now() + 30 * 86400 * 1000);
    await updateOrgStripeFields(user.orgId, {
      stripeSubscriptionId: subId,
      tier: "pro",
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    stripeMocks.subscriptionsUpdate.mockResolvedValue({ id: subId });

    const request = createDowngradeRequest({ targetTier: "free" });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.effectiveDate).toBe(periodEnd.toISOString());

    expect(stripeMocks.subscriptionsUpdate).toHaveBeenCalledWith(subId, {
      cancel_at_period_end: true,
    });

    // Verify cancelAtPeriodEnd is set in DB
    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.cancelAtPeriodEnd).toBe(true);
  });

  it("downgrades team to free via cancel at period end", async () => {
    const subId = uniqueId("sub-team-free");
    const periodEnd = new Date(Date.now() + 30 * 86400 * 1000);
    await updateOrgStripeFields(user.orgId, {
      stripeSubscriptionId: subId,
      tier: "team",
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    stripeMocks.subscriptionsUpdate.mockResolvedValue({ id: subId });

    const request = createDowngradeRequest({ targetTier: "free" });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.effectiveDate).toBe(periodEnd.toISOString());

    expect(stripeMocks.subscriptionsUpdate).toHaveBeenCalledWith(subId, {
      cancel_at_period_end: true,
    });
  });
});
