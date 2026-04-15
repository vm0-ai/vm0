import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgStripeFields,
  insertCreditExpiresRecord,
  insertOrgCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../../src/__tests__/stripe-mock";

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
    expect(data.credits).toBe(100_000);
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
    expect(data.credits).toBe(100_000);
    expect(data.subscriptionStatus).toBe("active");
    expect(data.currentPeriodEnd).toBe(periodEnd.toISOString());
    expect(data.cancelAtPeriodEnd).toBe(false);
    expect(data.hasSubscription).toBe(true);
  });

  it("returns cancelAtPeriodEnd true when set", async () => {
    const { orgId } = await context.setupUser({ prefix: "cancel-user" });
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-cancel"),
      stripeSubscriptionId: uniqueId("sub-cancel"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
      tier: "pro",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.cancelAtPeriodEnd).toBe(true);
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

  it("includes creditExpiry data for paid org with expires records", async () => {
    const { orgId } = await context.setupUser({ prefix: "expiry-user" });
    const periodEnd = new Date("2026-04-20T00:00:00Z");
    const expiryDate = new Date("2026-05-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-expiry"),
      stripeSubscriptionId: uniqueId("sub-expiry"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertCreditExpiresRecord({
      orgId,
      amount: 20000,
      remaining: 15000,
      expiresAt: expiryDate,
      stripeInvoiceId: uniqueId("inv-expiry"),
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditExpiry.expiringNextCycle).toBe(15000);
    expect(data.creditExpiry.nextExpiryDate).toBe(expiryDate.toISOString());
  });

  it("returns zero creditExpiry for free org", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditExpiry.expiringNextCycle).toBe(0);
    expect(data.creditExpiry.nextExpiryDate).toBeNull();
  });

  it("returns defaults when org row does not exist", async () => {
    const newOrgId = uniqueId("org-norow");
    const newSlug = `billing-norow-${Date.now()}`;
    mockClerk({
      userId: uniqueId("user"),
      orgId: newOrgId,
      orgSlug: newSlug,
      orgRole: "org:admin",
      clerkOrgs: [{ id: newOrgId, slug: newSlug, name: "NoRow" }],
    });

    // Populate org_cache so resolveOrg recognizes this org (no org_metadata row)
    await insertOrgCacheEntry({ orgId: newOrgId, slug: newSlug });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/billing/status`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("free");
    expect(data.credits).toBe(0);
    expect(data.hasSubscription).toBe(false);
  });
});
