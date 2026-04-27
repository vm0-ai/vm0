import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
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

import { POST } from "../route";

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const APP_ORIGIN = "http://app.localhost:3002";

const TEST_ZERO_PRICE = JSON.stringify({
  pro: [TEST_PRICE_PRO],
  team: [TEST_PRICE_TEAM],
});

const context = testContext();

describe("POST /api/zero/billing/checkout", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    vi.stubEnv("ZERO_PRICE", TEST_ZERO_PRICE);
    reloadEnv();

    stripeMocks.checkoutSessionsCreate.mockReset();
    stripeMocks.customersCreate.mockReset();
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(503);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid tier", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "enterprise",
          successUrl: `${APP_ORIGIN}/?billing=success`,
          cancelUrl: `${APP_ORIGIN}/?billing=canceled`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("returns 403 for non-admin member", async () => {
    const { userId, orgId } = await context.setupUser({
      prefix: "member-checkout",
    });
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it("returns checkout URL on success", async () => {
    stripeMocks.customersCreate.mockResolvedValue({
      id: uniqueId("cus-checkout"),
    });
    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      url: "https://checkout.stripe.com/session/test",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toBe("https://checkout.stripe.com/session/test");
  });

  it("returns 400 when successUrl or cancelUrl origin does not match NEXT_PUBLIC_APP_URL", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: "https://evil.example.com/billing?billing=success",
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});
