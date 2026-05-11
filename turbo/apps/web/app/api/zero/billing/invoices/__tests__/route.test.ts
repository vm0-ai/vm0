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

import { GET } from "../route";

const context = testContext();

describe("GET /api/zero/billing/invoices", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();

    stripeMocks.invoicesList.mockReset();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/invoices",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the user has no active org", async () => {
    mockClerk({ userId: uniqueId("no-org-user"), orgId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/invoices",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 403 for non-admin member", async () => {
    const { userId, orgId } = await context.setupUser({
      prefix: "member-invoices",
    });
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/invoices",
    );
    const response = await GET(request);

    expect(response.status).toBe(403);
  });

  it("returns invoices for org with active subscription", async () => {
    const { orgId } = await context.setupUser({ prefix: "inv-user" });
    const customerId = uniqueId("cus-inv");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: uniqueId("sub-inv"),
      subscriptionStatus: "active",
      tier: "pro",
    });

    stripeMocks.invoicesList.mockResolvedValue({
      data: [
        {
          id: "inv_001",
          number: "INV-2026-001",
          created: 1740000000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_001",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          created: 1737400000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_002",
        },
      ],
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/invoices",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.invoices).toHaveLength(2);
    expect(data.invoices[0]).toEqual({
      id: "inv_001",
      number: "INV-2026-001",
      date: 1740000000,
      amount: 4000,
      status: "paid",
      hostedInvoiceUrl: "https://stripe.com/invoice/inv_001",
    });
    expect(data.invoices[1]).toEqual({
      id: "inv_002",
      number: "INV-2026-002",
      date: 1737400000,
      amount: 4000,
      status: "paid",
      hostedInvoiceUrl: "https://stripe.com/invoice/inv_002",
    });
  });

  it("returns empty array for org without Stripe customer", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/invoices",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.invoices).toEqual([]);
  });

  it("returns empty array when Stripe returns no invoices", async () => {
    const { orgId } = await context.setupUser({ prefix: "empty-inv" });
    const customerId = uniqueId("cus-empty");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: uniqueId("sub-empty"),
      subscriptionStatus: "active",
      tier: "pro",
    });

    stripeMocks.invoicesList.mockResolvedValue({ data: [] });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/invoices",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.invoices).toEqual([]);
  });
});
