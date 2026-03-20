import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../src/__tests__/stripe-mock";
import { reloadEnv } from "../../../../../src/env";

// Mock stripe module (external dependency)
const stripeMocks = vi.hoisted<StripeMockFns>(() => ({
  subscriptionsRetrieve: vi.fn(),
  invoicesRetrieve: vi.fn(),
  customersCreate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  billingPortalSessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: function MockStripe() {
    return {
      subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
      invoices: { retrieve: stripeMocks.invoicesRetrieve },
      customers: { create: stripeMocks.customersCreate },
      checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
      billingPortal: {
        sessions: { create: stripeMocks.billingPortalSessionsCreate },
      },
      webhooks: { constructEvent: stripeMocks.constructEvent },
    };
  },
}));

import { POST } from "../route";

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_MAX = "price_test_max";

const context = testContext();

describe("POST /api/billing/checkout", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("ZERO_PRO_PLAN_PRICE_ID", TEST_PRICE_PRO);
    vi.stubEnv("ZERO_MAX_PLAN_PRICE_ID", TEST_PRICE_MAX);
    reloadEnv();

    stripeMocks.checkoutSessionsCreate.mockReset();
    stripeMocks.customersCreate.mockReset();
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: "https://app.vm7.ai/billing?billing=success",
          cancelUrl: "https://app.vm7.ai/billing?billing=canceled",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toContain("Billing not configured");
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: "https://app.vm7.ai/billing?billing=success",
          cancelUrl: "https://app.vm7.ai/billing?billing=canceled",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid tier", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "enterprise",
          successUrl: "https://app.vm7.ai/?billing=success",
          cancelUrl: "https://app.vm7.ai/?billing=canceled",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid body");
  });

  it("returns checkout URL on success", async () => {
    stripeMocks.customersCreate.mockResolvedValue({
      id: uniqueId("cus-checkout"),
    });
    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      url: "https://checkout.stripe.com/session/test",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: "pro",
          successUrl: "https://app.vm7.ai/billing?billing=success",
          cancelUrl: "https://app.vm7.ai/billing?billing=canceled",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toBe("https://checkout.stripe.com/session/test");
  });
});
