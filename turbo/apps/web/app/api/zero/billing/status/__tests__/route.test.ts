import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgStripeFields,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../../src/__tests__/stripe-mock";

const stripeMocks = vi.hoisted<StripeMockFns>(() => ({
  subscriptionsRetrieve: vi.fn(),
  subscriptionsUpdate: vi.fn(),
  subscriptionsCancel: vi.fn(),
  invoicesRetrieve: vi.fn(),
  invoicesList: vi.fn(),
  customersCreate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  billingPortalSessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
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
}));

import { GET } from "../route";

const context = testContext();

describe("GET /api/zero/billing/status", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns billing status for authenticated user", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("free");
    expect(data.credits).toBe(10_000);
    expect(data.hasSubscription).toBe(false);
    expect(data.subscriptionStatus).toBeNull();
    expect(data.currentPeriodEnd).toBeNull();
  });

  it("returns correct data for subscribed org", async () => {
    const { orgId } = await context.setupUser({ prefix: "sub-user" });
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-status"),
      stripeSubscriptionId: uniqueId("sub-status"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("pro");
    expect(data.credits).toBe(10_000);
    expect(data.subscriptionStatus).toBe("active");
    expect(data.currentPeriodEnd).toBe(periodEnd.toISOString());
    expect(data.hasSubscription).toBe(true);
  });

  it("returns 200 for non-admin member", async () => {
    const { userId, orgId } = await context.setupUser({
      prefix: "member-status",
    });
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("returns defaults when org row does not exist", async () => {
    const newOrgId = uniqueId("org-nonexistent");
    mockClerk({
      userId: uniqueId("user"),
      orgId: newOrgId,
      orgSlug: "nonexistent-org",
      orgRole: "org:admin",
      clerkOrgs: [
        { id: newOrgId, slug: "nonexistent-org", name: "Nonexistent" },
      ],
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status?org=nonexistent-org",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("free");
    expect(data.credits).toBe(0);
    expect(data.hasSubscription).toBe(false);
  });
});
