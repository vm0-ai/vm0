import { randomUUID } from "node:crypto";

import StripeSDK from "stripe";
import { zeroBillingRedeemContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteRedeemOrg$,
  findOrgPromoRedemption$,
  seedCreditExpiresRecord$,
  seedOrgPromoRedemption$,
  seedRedeemOrg$,
  type RedeemFixture,
} from "./helpers/zero-billing-redeem";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const CAMPAIGN = "ZERO100";
const PRICE_ID = "price_test_campaign";
const COUPON_ID = "ZERO100";
const APP_ORIGIN = "http://app.localhost:3002";
const SUCCESS_URL = `${APP_ORIGIN}/redeem/${CAMPAIGN}?stripe=success`;
const CANCEL_URL = `${APP_ORIGIN}/redeem/${CAMPAIGN}`;

function setRedeemEnv(): void {
  mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  mockEnv("VM0_WEB_URL", APP_ORIGIN);
  mockEnv(
    "ZERO_ONE_TIME_CAMPAIGN",
    JSON.stringify({ [CAMPAIGN]: { priceId: PRICE_ID, couponId: COUPON_ID } }),
  );
}

describe("POST /api/zero/billing/redeem/:campaign", () => {
  const track = createFixtureTracker<RedeemFixture>((fixture) => {
    return store.set(deleteRedeemOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    setRedeemEnv();
    // Default-safe coupon/price responses; specific tests override.
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: true,
    });
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: PRICE_ID,
      active: true,
    });
    context.mocks.stripe.customers.create.mockResolvedValue({ id: "cus_test" });
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: {},
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns campaign_misconfigured for an unknown campaign", async () => {
    const fixture = await track(store.set(seedRedeemOrg$, {}, context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: "UNKNOWN" },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns campaign_misconfigured when the campaign is missing from env config", async () => {
    mockEnv("ZERO_ONE_TIME_CAMPAIGN", JSON.stringify({}));
    const fixture = await track(store.set(seedRedeemOrg$, {}, context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  // Web returns 400 when the caller has no active org (resolveOrg throws).
  // Api hardens to 401 via authRoute({ missingOrganizationStatus: 401 }) —
  // intentional Wave 6 cutover convention, documented in PR body.
  it("returns 401 when the caller has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("lets unexpected (non-Stripe) errors propagate so Sentry captures the full stack", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new Error("boom: database unreachable"),
    );

    // The service only catches Stripe.errors.StripeError. Plain errors bubble
    // up to the framework's default error handler and become a generic 500.
    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [500],
    );

    expect(response.status).toBe(500);
  });

  it("returns admin_required for non-admin org members", async () => {
    const fixture = await track(store.set(seedRedeemOrg$, {}, context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "admin_required",
    });
  });

  it("creates a Stripe Checkout session on first visit and records the row", async () => {
    const customerId = `cus_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: customerId },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_fresh_1",
      url: "https://stripe.test/checkout/cs_fresh_1",
    });

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_fresh_1",
    });

    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        discounts: [{ coupon: COUPON_ID }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
        metadata: {
          orgId: fixture.orgId,
          campaignKey: CAMPAIGN,
          purpose: "one_time_purchase",
        },
      }),
    );

    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_1");
  });

  it("resumes to the same Stripe URL when the existing session is still open", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_open_1",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_1",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_1",
    });

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_open_1",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("drops the cached session and returns campaign_misconfigured when the coupon was deleted", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_open_stale",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_stale",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_stale",
    });
    context.mocks.stripe.coupons.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such coupon: '${COUPON_ID}'`,
        code: "resource_missing",
      }),
    );

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_stale",
    );
    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("still drops the cached session row when expiring it in Stripe fails", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_open_expire_fails",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_expire_fails",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_expire_fails",
    });
    context.mocks.stripe.coupons.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such coupon: '${COUPON_ID}'`,
        code: "resource_missing",
      }),
    );
    context.mocks.stripe.checkout.sessions.expire.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Session can no longer be expired",
        code: "session_expired",
      }),
    );

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_expire_fails",
    );
    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("drops the cached session and returns campaign_misconfigured when the coupon is no longer valid", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_open_invalid",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_invalid",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_invalid",
    });
    context.mocks.stripe.coupons.retrieve.mockResolvedValue({
      id: COUPON_ID,
      valid: false,
      redeem_by: Math.floor(now() / 1000) - 60,
    });

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_invalid",
    );
    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("drops the cached session and returns campaign_misconfigured when the price was deleted", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_open_price_gone",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_price_gone",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_price_gone",
    });
    context.mocks.stripe.prices.retrieve.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: `No such price: '${PRICE_ID}'`,
        code: "resource_missing",
      }),
    );

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_price_gone",
    );
    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("drops the cached session and returns campaign_misconfigured when the price is archived", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_open_price_archived",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_open_price_archived",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_price_archived",
    });
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: PRICE_ID,
      active: false,
    });

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_price_archived",
    );
    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row).toBeUndefined();
  });

  it("rotates to a new Stripe session when the existing one has expired", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_expired_1",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_expired_1",
      status: "expired",
      url: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_fresh_2",
      url: "https://stripe.test/checkout/cs_fresh_2",
    });

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_fresh_2",
    });

    const row = await store.set(findOrgPromoRedemption$, {
      orgId: fixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_2");
  });

  it("returns already_granted when credits have landed", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_granted_1",
      },
      context.signal,
    );
    await store.set(
      seedCreditExpiresRecord$,
      {
        orgId: fixture.orgId,
        source: "one_time_purchase",
        stripeInvoiceId: "cs_granted_1",
        amount: 100_000,
        expiresAt: new Date(now() + 30 * 24 * 60 * 60 * 1000),
      },
      context.signal,
    );

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "already_granted" });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).not.toHaveBeenCalled();
  });

  it("returns campaign_misconfigured when Stripe rejects the session at create time with a non-invalid-request error", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new StripeSDK.errors.StripeAPIError({
        type: "api_error",
        message: "Coupon ZERO100 is expired and cannot be applied.",
      }),
    );

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns campaign_misconfigured when Stripe coupon is missing at create time", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such coupon: 'ZERO100'",
        code: "resource_missing",
        param: "discounts[0][coupon]",
      }),
    );

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
  });

  it("returns processing when Stripe session is complete but webhook hasn't landed yet", async () => {
    const fixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: fixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_complete_1",
      },
      context.signal,
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_complete_1",
      status: "complete",
      url: null,
    });

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "processing" });
  });

  // ---- Test #19 — validates the pre-auth wrap pattern ----
  // The outer command must short-circuit before authRoute runs, surfacing
  // 200/billing_unavailable to an unauthenticated caller when
  // STRIPE_SECRET_KEY is missing.
  it("returns billing_unavailable before auth when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    // No mocks.clerk.session() — caller is unauthenticated.

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        headers: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "error",
      reason: "billing_unavailable",
    });
  });

  it("rejects successUrl/cancelUrl whose origin does not match VM0_WEB_URL", async () => {
    const fixture = await track(store.set(seedRedeemOrg$, {}, context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingRedeemContract);
    const response = await accept(
      client.create({
        params: { campaign: CAMPAIGN },
        body: {
          successUrl: "https://evil.example.com/redeem/callback?stripe=success",
          cancelUrl: CANCEL_URL,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "successUrl and cancelUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});
