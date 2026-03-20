import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../src/__tests__/stripe-mock";

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

import { GET } from "../route";

const context = testContext();

describe("GET /api/billing/status", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns billing status for authenticated user", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("tier");
    expect(data).toHaveProperty("credits");
    expect(data).toHaveProperty("hasSubscription");
    expect(data.hasSubscription).toBe(false);
  });
});
