import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("stripe", () => {
  function MockStripe() {
    return {
      subscriptions: { retrieve: vi.fn() },
      invoices: { retrieve: vi.fn() },
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    };
  }
  return { default: MockStripe };
});

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
