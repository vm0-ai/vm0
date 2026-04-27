import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgStripeFields,
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

const context = testContext();
const APP_ORIGIN = "http://app.localhost:3002";

describe("POST /api/zero/billing/portal", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    reloadEnv();

    stripeMocks.billingPortalSessionsCreate.mockReset();
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: `${APP_ORIGIN}/settings` }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(503);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: `${APP_ORIGIN}/settings` }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 400 when returnUrl is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("returns 400 when returnUrl is not a valid URL", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: "not-a-url" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("returns 403 for non-admin member", async () => {
    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:member",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: `${APP_ORIGIN}/settings` }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it("returns portal URL on success", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus-portal"),
    });

    stripeMocks.billingPortalSessionsCreate.mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnUrl: `${APP_ORIGIN}/settings/billing`,
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toBe("https://billing.stripe.com/session/test");
  });

  it("returns 400 when returnUrl origin does not match NEXT_PUBLIC_APP_URL", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/portal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnUrl: "https://evil.example.com/settings/billing",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});
