import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
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

// Import route handler AFTER mocks are set up
import { POST } from "../route";

const TEST_WEBHOOK_SECRET = "whsec_test_secret";
const TEST_PRICE_PRO = "price_test_pro";

const context = testContext();

/** Create a Stripe webhook request */
function createStripeWebhookRequest(
  body: string,
  options?: { missingSignature?: boolean },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (!options?.missingSignature) {
    headers["stripe-signature"] = "t=123,v1=abc";
  }

  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    context.setupMocks();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    vi.stubEnv("STRIPE_PRICE_ID_PRO", TEST_PRICE_PRO);
    reloadEnv();

    stripeMocks.constructEvent.mockReset();
    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.invoicesRetrieve.mockReset();
  });

  it("returns 503 when STRIPE_WEBHOOK_SECRET is not configured", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    reloadEnv();

    const request = createStripeWebhookRequest("{}");
    const response = await POST(request);

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toContain("not configured");
  });

  it("returns 401 when stripe-signature header is missing", async () => {
    const request = createStripeWebhookRequest("{}", {
      missingSignature: true,
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("stripe-signature");
  });

  it("returns 401 when signature verification fails", async () => {
    stripeMocks.constructEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const request = createStripeWebhookRequest(
      JSON.stringify({ type: "checkout.session.completed" }),
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Invalid webhook signature");
  });

  it("returns 200 and processes checkout.session.completed event", async () => {
    const cusId = uniqueId("cus");
    const subId = uniqueId("sub");

    stripeMocks.constructEvent.mockReturnValue({
      id: uniqueId("evt"),
      type: "checkout.session.completed",
      data: {
        object: {
          id: uniqueId("cs"),
          subscription: subId,
          customer: cusId,
        },
      },
    });

    stripeMocks.subscriptionsRetrieve.mockResolvedValue({
      id: subId,
      status: "active",
      items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      latest_invoice: uniqueId("inv"),
    });

    stripeMocks.invoicesRetrieve.mockResolvedValue({
      id: uniqueId("inv"),
      period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    });

    const request = createStripeWebhookRequest(
      JSON.stringify({ type: "checkout.session.completed" }),
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("returns 200 for unhandled event types without processing", async () => {
    stripeMocks.constructEvent.mockReturnValue({
      id: uniqueId("evt"),
      type: "payment_intent.created",
      data: { object: {} },
    });

    const request = createStripeWebhookRequest(
      JSON.stringify({ type: "payment_intent.created" }),
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("passes correct arguments to constructEvent", async () => {
    const body = JSON.stringify({ type: "checkout.session.completed" });

    stripeMocks.constructEvent.mockReturnValue({
      id: uniqueId("evt"),
      type: "checkout.session.completed",
      data: {
        object: {
          id: uniqueId("cs"),
          subscription: null,
          customer: uniqueId("cus"),
        },
      },
    });

    const request = createStripeWebhookRequest(body);
    await POST(request);

    expect(stripeMocks.constructEvent).toHaveBeenCalledWith(
      body,
      "t=123,v1=abc",
      TEST_WEBHOOK_SECRET,
    );
  });
});
