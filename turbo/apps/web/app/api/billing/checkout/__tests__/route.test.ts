import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../src/env";

// Mock stripe module (external dependency)
const mockCheckoutSessionsCreate = vi.fn();
const mockCustomersCreate = vi.fn();

vi.mock("stripe", () => {
  function MockStripe() {
    return {
      subscriptions: { retrieve: vi.fn() },
      invoices: { retrieve: vi.fn() },
      customers: { create: mockCustomersCreate },
      checkout: { sessions: { create: mockCheckoutSessionsCreate } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    };
  }
  return { default: MockStripe };
});

import { POST } from "../route";

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_MAX = "price_test_max";

const context = testContext();

describe("POST /api/billing/checkout", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_PRICE_ID_PRO", TEST_PRICE_PRO);
    vi.stubEnv("STRIPE_PRICE_ID_MAX", TEST_PRICE_MAX);
    reloadEnv();

    mockCheckoutSessionsCreate.mockReset();
    mockCustomersCreate.mockReset();
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "pro" }),
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
        body: JSON.stringify({ tier: "pro" }),
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
        body: JSON.stringify({ tier: "enterprise" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid tier");
  });

  it("returns checkout URL on success", async () => {
    mockCustomersCreate.mockResolvedValue({ id: "cus_test_123" });
    mockCheckoutSessionsCreate.mockResolvedValue({
      url: "https://checkout.stripe.com/session/test",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/billing/checkout",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "pro" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toBe("https://checkout.stripe.com/session/test");
  });
});
