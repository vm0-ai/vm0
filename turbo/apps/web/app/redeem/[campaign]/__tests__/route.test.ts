import { describe, it, expect, beforeEach, vi } from "vitest";
import Stripe from "stripe";
import {
  createTestRequest,
  findOrgPromoRedemption,
  insertCreditExpiresRecord,
  insertOrgPromoRedemption,
  updateOrgStripeFields,
} from "../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../src/env";

const stripeMocks = vi.hoisted(() => {
  return {
    checkoutSessionsCreate: vi.fn(),
    checkoutSessionsRetrieve: vi.fn(),
    checkoutSessionsExpire: vi.fn(),
    customersCreate: vi.fn(),
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
        prices: { list: vi.fn() },
        checkout: {
          sessions: {
            create: stripeMocks.checkoutSessionsCreate,
            retrieve: stripeMocks.checkoutSessionsRetrieve,
            expire: stripeMocks.checkoutSessionsExpire,
          },
        },
        customers: { create: stripeMocks.customersCreate },
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

import { GET } from "../route";

const context = testContext();

const CAMPAIGN = "ZERO100";
const PRICE_ID = "price_test_campaign";
const COUPON_ID = "ZERO100";
const REDEEM_URL = `http://localhost:3000/redeem/${CAMPAIGN}`;
const CAMPAIGN_ENV = JSON.stringify({
  [CAMPAIGN]: { priceId: PRICE_ID, couponId: COUPON_ID },
});

function params(campaign: string) {
  return Promise.resolve({ campaign });
}

describe("GET /redeem/[campaign]", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    // Distinct host from the request origin (localhost:3000) so assertions
    // can verify error redirects cross over to the platform app domain.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://app.localhost:3002");
    vi.stubEnv("ZERO_ONE_TIME_CAMPAIGN", CAMPAIGN_ENV);
    reloadEnv();

    stripeMocks.checkoutSessionsCreate.mockReset();
    stripeMocks.checkoutSessionsRetrieve.mockReset();
    stripeMocks.checkoutSessionsExpire.mockReset();
    stripeMocks.customersCreate.mockReset();

    // If tests seed a Stripe customer on the org, customers.create shouldn't be
    // called; but default the fallback to a known id just in case.
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_test" });
  });

  it("redirects unauthenticated users to /sign-in with round-trip redirect_url", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
    expect(location).toContain(encodeURIComponent(`/redeem/${CAMPAIGN}`));
  });

  it("returns 404 for an unknown campaign", async () => {
    const response = await GET(
      createTestRequest("http://localhost:3000/redeem/UNKNOWN"),
      { params: params("UNKNOWN") },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the campaign is missing from env config", async () => {
    vi.stubEnv("ZERO_ONE_TIME_CAMPAIGN", JSON.stringify({}));
    reloadEnv();

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });
    expect(response.status).toBe(404);
  });

  it("redirects logged-in users without an active org to choose-organization", async () => {
    mockClerk({
      userId: user.userId,
      orgId: null,
      orgRole: null,
    });

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in/tasks/choose-organization");
    expect(location).toContain(encodeURIComponent(`/redeem/${CAMPAIGN}`));
  });

  it("redirects to the error page with an unknown reason when an unexpected error is thrown", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockRejectedValue(
      new Error("boom: database unreachable"),
    );

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "http://app.localhost:3002/redeem/error?reason=unknown",
    );
  });

  it("redirects non-admin org members home with admin_required error", async () => {
    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:member",
    });

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "http://app.localhost:3002/redeem/error?reason=admin_required",
    );
  });

  it("creates a Stripe Checkout session on first visit and records the row", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_fresh_1",
      url: "https://stripe.test/checkout/cs_fresh_1",
    });

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://stripe.test/checkout/cs_fresh_1",
    );

    expect(stripeMocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        discounts: [{ coupon: COUPON_ID }],
        // Stripe returns to the platform app (NEXT_PUBLIC_APP_URL), never
        // back to the web origin — so localhost dev entry still lands on
        // the real dashboard after payment. Success lands on the status
        // page so the user sees a branded confirmation; cancel goes home.
        success_url:
          "http://app.localhost:3002/redeem/status?state=already_redeemed",
        cancel_url: "http://app.localhost:3002/",
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

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://stripe.test/checkout/cs_open_1",
    );
    expect(stripeMocks.checkoutSessionsCreate).not.toHaveBeenCalled();
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

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://stripe.test/checkout/cs_fresh_2",
    );

    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_2");
  });

  it("redirects home with already_redeemed when credits have landed", async () => {
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

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "http://app.localhost:3002/redeem/status?state=already_redeemed",
    );
    expect(stripeMocks.checkoutSessionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.checkoutSessionsRetrieve).not.toHaveBeenCalled();
  });

  it("redirects home with campaign_misconfigured when Stripe coupon is missing", async () => {
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

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "http://app.localhost:3002/redeem/error?reason=campaign_misconfigured",
    );
  });

  it("redirects home with processing when Stripe session is complete but webhook hasn't landed yet", async () => {
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

    const response = await GET(createTestRequest(REDEEM_URL), {
      params: params(CAMPAIGN),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "http://app.localhost:3002/redeem/status?state=processing",
    );
  });
});
