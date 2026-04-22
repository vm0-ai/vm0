import { describe, it, expect, beforeEach, vi } from "vitest";
import Stripe from "stripe";
import {
  createTestRequest,
  findOrgPromoRedemption,
  insertCreditExpiresRecord,
  insertOrgPromoRedemption,
  updateOrgStripeFields,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../../src/env";

const stripeMocks = vi.hoisted(() => {
  return {
    checkoutSessionsCreate: vi.fn(),
    checkoutSessionsRetrieve: vi.fn(),
    checkoutSessionsExpire: vi.fn(),
    customersCreate: vi.fn(),
    couponsRetrieve: vi.fn(),
    pricesRetrieve: vi.fn(),
  };
});

vi.mock("stripe", async (importOriginal) => {
  // Keep the real `Stripe.errors.*` classes so route-level `instanceof` checks
  // work; only the constructor is stubbed.
  const actual = await importOriginal<typeof import("stripe")>();
  const MockStripe = Object.assign(
    function MockStripe() {
      return {
        products: { retrieve: vi.fn() },
        prices: { list: vi.fn(), retrieve: stripeMocks.pricesRetrieve },
        checkout: {
          sessions: {
            create: stripeMocks.checkoutSessionsCreate,
            retrieve: stripeMocks.checkoutSessionsRetrieve,
            expire: stripeMocks.checkoutSessionsExpire,
          },
        },
        customers: { create: stripeMocks.customersCreate },
        coupons: { retrieve: stripeMocks.couponsRetrieve },
        subscriptions: { retrieve: vi.fn() },
        invoices: { list: vi.fn() },
        billingPortal: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
      };
    },
    { errors: actual.default.errors },
  );
  return { default: MockStripe };
});

// `import` must follow `vi.mock("stripe", ...)` so the stripe constructor is
// stubbed before the route module evaluates `getStripe`. This file is listed
// in `.oxlintrc.json` under the `import/first` override to allow that order.
import { POST } from "../route";

const context = testContext();

const CAMPAIGN = "ZERO100";
const PRICE_ID = "price_test_campaign";
const COUPON_ID = "ZERO100";
const APP_ORIGIN = "http://app.localhost:3002";
const API_URL = `http://localhost:3000/api/zero/billing/redeem/${CAMPAIGN}`;
const SUCCESS_URL = `${APP_ORIGIN}/redeem/${CAMPAIGN}?stripe=success`;
const CANCEL_URL = `${APP_ORIGIN}/redeem/${CAMPAIGN}`;
const CAMPAIGN_ENV = JSON.stringify({
  [CAMPAIGN]: { priceId: PRICE_ID, couponId: COUPON_ID },
});

function makeRequest(
  overrides?: Partial<{
    url: string;
    successUrl: string;
    cancelUrl: string;
  }>,
) {
  return createTestRequest(overrides?.url ?? API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      successUrl: overrides?.successUrl ?? SUCCESS_URL,
      cancelUrl: overrides?.cancelUrl ?? CANCEL_URL,
    }),
  });
}

describe("POST /api/zero/billing/redeem/:campaign", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    vi.stubEnv("ZERO_ONE_TIME_CAMPAIGN", CAMPAIGN_ENV);
    reloadEnv();

    stripeMocks.checkoutSessionsCreate.mockReset();
    stripeMocks.checkoutSessionsRetrieve.mockReset();
    stripeMocks.checkoutSessionsExpire.mockReset();
    stripeMocks.customersCreate.mockReset();
    stripeMocks.couponsRetrieve.mockReset();
    stripeMocks.pricesRetrieve.mockReset();

    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_test" });
    stripeMocks.couponsRetrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: true,
    });
    stripeMocks.pricesRetrieve.mockResolvedValue({
      id: PRICE_ID,
      active: true,
    });
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
  });

  it("returns campaign_misconfigured for an unknown campaign", async () => {
    const response = await POST(
      makeRequest({
        url: "http://localhost:3000/api/zero/billing/redeem/UNKNOWN",
      }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns campaign_misconfigured when the campaign is missing from env config", async () => {
    vi.stubEnv("ZERO_ONE_TIME_CAMPAIGN", JSON.stringify({}));
    reloadEnv();

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns 400 when the caller has no active org", async () => {
    mockClerk({
      userId: user.userId,
      orgId: null,
      orgRole: null,
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("lets unexpected (non-Stripe) errors propagate so Sentry captures the full stack", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockRejectedValue(
      new Error("boom: database unreachable"),
    );

    // The route only catches Stripe.errors.StripeError. Plain errors bubble
    // up to ts-rest-handler's default error handler and become a generic
    // 500 — matches the old web route's behaviour where non-Stripe errors
    // reached Next's error boundary.
    const response = await POST(makeRequest());
    expect(response.status).toBe(500);
  });

  it("returns admin_required for non-admin org members", async () => {
    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:member",
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "admin_required",
    });
  });

  it("creates a Stripe Checkout session on first visit and records the row", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_fresh_1",
      url: "https://stripe.test/checkout/cs_fresh_1",
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_fresh_1",
    });

    expect(stripeMocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        discounts: [{ coupon: COUPON_ID }],
        // Client-supplied URLs are threaded straight through to Stripe so the
        // same API can serve different platform origins (prod / staging / dev).
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
        metadata: {
          orgId: user.orgId,
          campaignKey: CAMPAIGN,
          purpose: "one_time_purchase",
        },
      }),
    );

    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_1");
  });

  it("resumes to the same Stripe URL when the existing session is still open", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_open_1",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_open_1",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_1",
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_open_1",
    });
    expect(stripeMocks.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("drops the cached session and returns campaign_misconfigured when the coupon was deleted", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_open_stale",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_open_stale",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_stale",
    });
    stripeMocks.couponsRetrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such coupon: '${COUPON_ID}'`,
        code: "resource_missing",
      }),
    );

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(stripeMocks.checkoutSessionsExpire).toHaveBeenCalledWith(
      "cs_open_stale",
    );
    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("drops the cached session and returns campaign_misconfigured when the coupon is no longer valid", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_open_invalid",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_open_invalid",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_invalid",
    });
    stripeMocks.couponsRetrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: false,
      redeem_by: Math.floor(Date.now() / 1000) - 60,
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(stripeMocks.checkoutSessionsExpire).toHaveBeenCalledWith(
      "cs_open_invalid",
    );
    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("drops the cached session and returns campaign_misconfigured when the price was deleted", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_open_price_gone",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_open_price_gone",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_price_gone",
    });
    stripeMocks.pricesRetrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such price: '${PRICE_ID}'`,
        code: "resource_missing",
      }),
    );

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(stripeMocks.checkoutSessionsExpire).toHaveBeenCalledWith(
      "cs_open_price_gone",
    );
    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("drops the cached session and returns campaign_misconfigured when the price is archived", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_open_price_archived",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_open_price_archived",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_price_archived",
    });
    stripeMocks.pricesRetrieve.mockResolvedValue({
      id: PRICE_ID,
      active: false,
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(stripeMocks.checkoutSessionsExpire).toHaveBeenCalledWith(
      "cs_open_price_archived",
    );
    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("rotates to a new Stripe session when the existing one has expired", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_expired_1",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_expired_1",
      status: "expired",
      url: null,
    });
    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_fresh_2",
      url: "https://stripe.test/checkout/cs_fresh_2",
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_fresh_2",
    });

    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_2");
  });

  it("returns already_granted when credits have landed", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_granted_1",
    });
    await insertCreditExpiresRecord({
      orgId: user.orgId,
      source: "one_time_purchase",
      stripeInvoiceId: "cs_granted_1",
      amount: 100_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ status: "already_granted" });
    expect(stripeMocks.checkoutSessionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.checkoutSessionsRetrieve).not.toHaveBeenCalled();
  });

  it("returns campaign_misconfigured when Stripe rejects the session at create time with a non-invalid-request error", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockRejectedValue(
      new Stripe.errors.StripeAPIError({
        type: "api_error",
        message: "Coupon ZERO100 is expired and cannot be applied.",
      }),
    );

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns campaign_misconfigured when Stripe coupon is missing at create time", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such coupon: 'ZERO100'",
        code: "resource_missing",
        param: "discounts[0][coupon]",
      }),
    );

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns processing when Stripe session is complete but webhook hasn't landed yet", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
      stripeSessionId: "cs_complete_1",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_complete_1",
      status: "complete",
      url: null,
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ status: "processing" });
  });

  it("returns billing_unavailable before auth when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    reloadEnv();
    // Even without a session the billing_unavailable branch fires.
    mockClerk({ userId: null });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      status: "error",
      reason: "billing_unavailable",
    });
  });

  it("rejects successUrl/cancelUrl whose origin does not match NEXT_PUBLIC_APP_URL", async () => {
    const response = await POST(
      makeRequest({
        successUrl: "https://evil.example.com/redeem/callback?stripe=success",
      }),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});
