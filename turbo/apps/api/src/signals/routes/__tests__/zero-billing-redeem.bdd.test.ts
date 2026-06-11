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

// BDD migration of the legacy `zero-billing-redeem.test.ts`.
// The 21 legacy `it()`s collapse into 5 BDD `it()`s: (1)
// auth + misconfig + propagation chain (401 unauthenticated
// → 200 unknown campaign → 200 campaign missing from env →
// 401 no org → 500 non-Stripe error propagates → 200
// admin_required for non-admin), (2) first checkout +
// idempotent + already-granted chain (200 creates checkout
// session + records row → 200 resumes same session when
// open → 200 rotates to a new session when expired → 200
// already_granted when credits have landed), (3)
// cached-session coupon/price validation chain (200
// campaign_misconfigured when coupon deleted + expire
// succeeds → 200 still drops the cached row when expire
// fails → 200 campaign_misconfigured when coupon invalid
// → 200 campaign_misconfigured when price deleted → 200
// campaign_misconfigured when price archived), (4) Stripe
// errors at create + processing + URL validation chain
// (200 campaign_misconfigured when Stripe API error at
// create → 200 campaign_misconfigured when Stripe coupon
// missing at create → 200 processing when Stripe session
// is complete but credits haven't landed → 400 rejects
// successUrl whose origin does not match APP_URL), (5)
// pre-auth wrap chain (200 billing_unavailable before
// auth when STRIPE_SECRET_KEY is not configured).

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
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv(
    "ZERO_ONE_TIME_CAMPAIGN",
    JSON.stringify({
      [CAMPAIGN]: { priceId: PRICE_ID, couponId: COUPON_ID },
    }),
  );
}

function resetStripeDefaults(): void {
  context.mocks.stripe.coupons.retrieve.mockResolvedValue({
    id: COUPON_ID,
    valid: true,
  });
  context.mocks.stripe.prices.retrieve.mockResolvedValue({
    id: PRICE_ID,
    active: true,
  });
  context.mocks.stripe.customers.create.mockResolvedValue({ id: "cus_test" });
}

const track = createFixtureTracker<RedeemFixture>((fixture) => {
  return store.set(deleteRedeemOrg$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(zeroBillingRedeemContract);
}

function redeemBody() {
  return { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL };
}

function headersForSession() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD POST /api/zero/billing/redeem/:campaign — auth + misconfig + propagation + admin chain", () => {
  beforeEach(() => {
    setRedeemEnv();
    resetStripeDefaults();
  });

  it("gwt-wt-wt: 401 unauthenticated → 200 unknown campaign → 200 campaign missing from env → 401 no org → 500 non-Stripe error propagates → 200 admin_required for non-admin", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: {},
      }),
      [401],
    );
    expect(noAuth.status).toBe(401);

    // Given: a fixture + a known org session + an
    // UNKNOWN campaign.

    // When + Then: 200 — campaign_misconfigured.
    const unknownFixture = await track(
      store.set(seedRedeemOrg$, {}, context.signal),
    );
    mocks.clerk.session(
      unknownFixture.userId,
      unknownFixture.orgId,
      "org:admin",
    );
    const unknownResponse = await accept(
      apiClient().create({
        params: { campaign: "UNKNOWN" },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(unknownResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });

    // Given: a fixture + an empty campaign env.

    // When + Then: 200 — campaign_misconfigured.
    mockEnv("ZERO_ONE_TIME_CAMPAIGN", JSON.stringify({}));
    const missingEnvFixture = await track(
      store.set(seedRedeemOrg$, {}, context.signal),
    );
    mocks.clerk.session(
      missingEnvFixture.userId,
      missingEnvFixture.orgId,
      "org:admin",
    );
    const missingEnvResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(missingEnvResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });

    // Given: a session with no organization.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [401],
    );
    expect(noOrgResponse.status).toBe(401);

    // Given: a fixture + Stripe checkout throws a plain
    // Error (not a StripeError).

    // When + Then: 500 — non-Stripe errors bubble up to
    // the framework default handler.
    setRedeemEnv();
    resetStripeDefaults();
    const propagationFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      propagationFixture.userId,
      propagationFixture.orgId,
      "org:admin",
    );
    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new Error("boom: database unreachable"),
    );
    const propagationResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [500],
    );
    expect(propagationResponse.status).toBe(500);

    // Given: a fixture + a non-admin session.

    // When + Then: 200 — admin_required.
    setRedeemEnv();
    resetStripeDefaults();
    const nonAdminFixture = await track(
      store.set(seedRedeemOrg$, {}, context.signal),
    );
    mocks.clerk.session(
      nonAdminFixture.userId,
      nonAdminFixture.orgId,
      "org:member",
    );
    const nonAdminResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(nonAdminResponse.body).toStrictEqual({
      status: "error",
      reason: "admin_required",
    });
  });
});

describe("BDD POST /api/zero/billing/redeem/:campaign — first checkout + resume + rotate + already-granted chain", () => {
  beforeEach(() => {
    setRedeemEnv();
    resetStripeDefaults();
  });

  it("gwt-wt-wt: 200 creates a Stripe checkout session + records the row → 200 resumes same session when open → 200 rotates to a new session when expired → 200 already_granted when credits have landed", async () => {
    // Given: a fixture with a stripe customer id + a
    // Stripe checkout session that resolves to
    // cs_fresh_1.

    // When + Then: 200 — checkout URL is returned +
    // Stripe is called with the expected params + the
    // redemption row is recorded.
    const createFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(createFixture.userId, createFixture.orgId, "org:admin");
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_fresh_1",
      url: "https://stripe.test/checkout/cs_fresh_1",
    });
    const createResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(createResponse.body).toStrictEqual({
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
          orgId: createFixture.orgId,
          campaignKey: CAMPAIGN,
          purpose: "one_time_purchase",
        },
      }),
    );
    const createdRow = await store.set(findOrgPromoRedemption$, {
      orgId: createFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(createdRow?.stripeSessionId).toBe("cs_fresh_1");

    // Given: a fixture + a cached redemption row for
    // cs_open_1 + Stripe retrieve returns status=open.

    // When + Then: 200 — same Stripe URL is resumed +
    // no new session is created.
    context.mocks.stripe.checkout.sessions.create.mockClear();
    context.mocks.stripe.checkout.sessions.retrieve.mockClear();
    const resumeFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(resumeFixture.userId, resumeFixture.orgId, "org:admin");
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: resumeFixture.orgId,
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
    const resumeResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(resumeResponse.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_open_1",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();

    // Given: a fixture + a cached redemption row for
    // cs_expired_1 + Stripe retrieve returns
    // status=expired + Stripe create returns cs_fresh_2.

    // When + Then: 200 — rotated to the new session +
    // the redemption row is updated to cs_fresh_2.
    const rotateFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(rotateFixture.userId, rotateFixture.orgId, "org:admin");
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: rotateFixture.orgId,
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
    const rotateResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(rotateResponse.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://stripe.test/checkout/cs_fresh_2",
    });
    const rotatedRow = await store.set(findOrgPromoRedemption$, {
      orgId: rotateFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(rotatedRow?.stripeSessionId).toBe("cs_fresh_2");

    // Given: a fixture + a cached redemption row for
    // cs_granted_1 + a credit_expires record for the
    // same session id.

    // When + Then: 200 — already_granted + Stripe
    // retrieve + create are not called.
    context.mocks.stripe.checkout.sessions.create.mockClear();
    context.mocks.stripe.checkout.sessions.retrieve.mockClear();
    const grantedFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      grantedFixture.userId,
      grantedFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: grantedFixture.orgId,
        campaignKey: CAMPAIGN,
        stripeSessionId: "cs_granted_1",
      },
      context.signal,
    );
    await store.set(
      seedCreditExpiresRecord$,
      {
        orgId: grantedFixture.orgId,
        source: "one_time_purchase",
        stripeInvoiceId: "cs_granted_1",
        amount: 100_000,
        expiresAt: new Date(now() + 30 * 24 * 60 * 60 * 1000),
      },
      context.signal,
    );
    const grantedResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(grantedResponse.body).toStrictEqual({ status: "already_granted" });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).not.toHaveBeenCalled();
  });
});

describe("BDD POST /api/zero/billing/redeem/:campaign — cached-session coupon/price validation chain", () => {
  beforeEach(() => {
    setRedeemEnv();
    resetStripeDefaults();
  });

  it("gwt-wt-wt: 200 campaign_misconfigured when coupon deleted + expire succeeds → 200 still drops the cached row when expire fails → 200 campaign_misconfigured when coupon invalid → 200 campaign_misconfigured when price deleted → 200 campaign_misconfigured when price archived", async () => {
    // Given: a fixture + a cached redemption row for
    // cs_open_stale + Stripe retrieve returns
    // status=open + Stripe coupon retrieve throws
    // StripeInvalidRequestError.

    // When + Then: 200 — campaign_misconfigured +
    // Stripe expire is called with cs_open_stale + the
    // cached row is dropped.
    const deletedCouponFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      deletedCouponFixture.userId,
      deletedCouponFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: deletedCouponFixture.orgId,
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
    const deletedCouponResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(deletedCouponResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_stale",
    );
    const deletedCouponRow = await store.set(findOrgPromoRedemption$, {
      orgId: deletedCouponFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(deletedCouponRow).toBeUndefined();

    // Given: a fixture + a cached redemption row +
    // Stripe coupon retrieve throws + Stripe expire
    // throws StripeInvalidRequestError.

    // When + Then: 200 — campaign_misconfigured +
    // Stripe expire is still called + the cached row is
    // still dropped.
    setRedeemEnv();
    resetStripeDefaults();
    context.mocks.stripe.checkout.sessions.expire.mockClear();
    const expireFailsFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      expireFailsFixture.userId,
      expireFailsFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: expireFailsFixture.orgId,
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
    const expireFailsResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(expireFailsResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_expire_fails",
    );
    const expireFailsRow = await store.set(findOrgPromoRedemption$, {
      orgId: expireFailsFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(expireFailsRow).toBeUndefined();

    // Given: a fixture + a cached redemption row +
    // Stripe coupon retrieve returns valid=false.

    // When + Then: 200 — campaign_misconfigured +
    // Stripe expire is called + the cached row is
    // dropped.
    setRedeemEnv();
    resetStripeDefaults();
    context.mocks.stripe.checkout.sessions.expire.mockClear();
    const invalidCouponFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      invalidCouponFixture.userId,
      invalidCouponFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: invalidCouponFixture.orgId,
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
    const invalidCouponResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(invalidCouponResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_invalid",
    );
    const invalidCouponRow = await store.set(findOrgPromoRedemption$, {
      orgId: invalidCouponFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(invalidCouponRow).toBeUndefined();

    // Given: a fixture + a cached redemption row +
    // Stripe price retrieve throws
    // StripeInvalidRequestError.

    // When + Then: 200 — campaign_misconfigured +
    // Stripe expire is called + the cached row is
    // dropped.
    setRedeemEnv();
    resetStripeDefaults();
    context.mocks.stripe.checkout.sessions.expire.mockClear();
    const deletedPriceFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      deletedPriceFixture.userId,
      deletedPriceFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: deletedPriceFixture.orgId,
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
    const deletedPriceResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(deletedPriceResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_price_gone",
    );
    const deletedPriceRow = await store.set(findOrgPromoRedemption$, {
      orgId: deletedPriceFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(deletedPriceRow).toBeUndefined();

    // Given: a fixture + a cached redemption row +
    // Stripe price retrieve returns active=false.

    // When + Then: 200 — campaign_misconfigured +
    // Stripe expire is called + the cached row is
    // dropped.
    setRedeemEnv();
    resetStripeDefaults();
    context.mocks.stripe.checkout.sessions.expire.mockClear();
    const archivedPriceFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      archivedPriceFixture.userId,
      archivedPriceFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: archivedPriceFixture.orgId,
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
    const archivedPriceResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(archivedPriceResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_open_price_archived",
    );
    const archivedPriceRow = await store.set(findOrgPromoRedemption$, {
      orgId: archivedPriceFixture.orgId,
      campaignKey: CAMPAIGN,
    });
    expect(archivedPriceRow).toBeUndefined();
  });
});

describe("BDD POST /api/zero/billing/redeem/:campaign — Stripe errors at create + processing + URL validation chain", () => {
  beforeEach(() => {
    setRedeemEnv();
    resetStripeDefaults();
  });

  it("gwt-wt-wt: 200 campaign_misconfigured when Stripe API error at create → 200 campaign_misconfigured when Stripe coupon missing at create → 200 processing when Stripe session is complete but credits haven't landed → 400 rejects successUrl whose origin does not match APP_URL", async () => {
    // Given: a fixture + Stripe checkout create throws
    // StripeAPIError.

    // When + Then: 200 — campaign_misconfigured.
    const apiErrorFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      apiErrorFixture.userId,
      apiErrorFixture.orgId,
      "org:admin",
    );
    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new StripeSDK.errors.StripeAPIError({
        type: "api_error",
        message: "Coupon ZERO100 is expired and cannot be applied.",
      }),
    );
    const apiErrorResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(apiErrorResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });

    // Given: a fixture + Stripe checkout create throws
    // StripeInvalidRequestError for the coupon param.

    // When + Then: 200 — campaign_misconfigured.
    setRedeemEnv();
    resetStripeDefaults();
    const missingCouponFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      missingCouponFixture.userId,
      missingCouponFixture.orgId,
      "org:admin",
    );
    context.mocks.stripe.checkout.sessions.create.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such coupon: 'ZERO100'",
        code: "resource_missing",
        param: "discounts[0][coupon]",
      }),
    );
    const missingCouponResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(missingCouponResponse.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });

    // Given: a fixture + a cached redemption row for
    // cs_complete_1 + Stripe retrieve returns
    // status=complete + no credit_expires record.

    // When + Then: 200 — processing.
    setRedeemEnv();
    resetStripeDefaults();
    const processingFixture = await track(
      store.set(
        seedRedeemOrg$,
        { stripeCustomerId: `cus_${randomUUID()}` },
        context.signal,
      ),
    );
    mocks.clerk.session(
      processingFixture.userId,
      processingFixture.orgId,
      "org:admin",
    );
    await store.set(
      seedOrgPromoRedemption$,
      {
        orgId: processingFixture.orgId,
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
    const processingResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: headersForSession(),
      }),
      [200],
    );
    expect(processingResponse.body).toStrictEqual({ status: "processing" });

    // Given: a fixture + a successUrl with a foreign
    // origin.

    // When + Then: 400 — origin does not match APP_URL.
    const badUrlFixture = await track(
      store.set(seedRedeemOrg$, {}, context.signal),
    );
    mocks.clerk.session(badUrlFixture.userId, badUrlFixture.orgId, "org:admin");
    const badUrlResponse = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: {
          successUrl: "https://evil.example.com/redeem/callback?stripe=success",
          cancelUrl: CANCEL_URL,
        },
        headers: headersForSession(),
      }),
      [400],
    );
    expect(badUrlResponse.body).toStrictEqual({
      error: {
        message: "successUrl and cancelUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});

describe("BDD POST /api/zero/billing/redeem/:campaign — pre-auth wrap chain", () => {
  it("gwt-wt-wt: 200 billing_unavailable before auth when STRIPE_SECRET_KEY is not configured", async () => {
    // Given: STRIPE_SECRET_KEY is unset + no auth.

    // When + Then: 200 — the outer command short-circuits
    // before auth runs.
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    // No mocks.clerk.session() — caller is unauthenticated.
    const response = await accept(
      apiClient().create({
        params: { campaign: CAMPAIGN },
        body: redeemBody(),
        headers: {},
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      status: "error",
      reason: "billing_unavailable",
    });
  });
});
