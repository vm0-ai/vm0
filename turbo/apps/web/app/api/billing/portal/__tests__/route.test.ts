import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgStripeFields,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../src/env";

// Mock stripe module (external dependency)
const mockBillingPortalSessionsCreate = vi.fn();

vi.mock("stripe", () => {
  function MockStripe() {
    return {
      subscriptions: { retrieve: vi.fn() },
      invoices: { retrieve: vi.fn() },
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: mockBillingPortalSessionsCreate } },
      webhooks: { constructEvent: vi.fn() },
    };
  }
  return { default: MockStripe };
});

import { POST } from "../route";

const context = testContext();

describe("POST /api/billing/portal", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();

    mockBillingPortalSessionsCreate.mockReset();
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: "http://localhost/settings" }),
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
      "http://localhost:3000/api/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: "http://localhost/settings" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 400 when returnUrl is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("returnUrl");
  });

  it("returns portal URL on success", async () => {
    // Set up org with a Stripe customer
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: "cus_portal_test",
    });

    mockBillingPortalSessionsCreate.mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnUrl: "http://localhost/settings/billing",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toBe("https://billing.stripe.com/session/test");
  });
});
