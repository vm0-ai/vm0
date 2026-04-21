import { describe, it, expect, beforeEach, vi } from "vitest";
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
    productsRetrieve: vi.fn(),
    pricesList: vi.fn(),
    checkoutSessionsCreate: vi.fn(),
    checkoutSessionsRetrieve: vi.fn(),
    customersCreate: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        products: { retrieve: stripeMocks.productsRetrieve },
        prices: { list: stripeMocks.pricesList },
        checkout: {
          sessions: {
            create: stripeMocks.checkoutSessionsCreate,
            retrieve: stripeMocks.checkoutSessionsRetrieve,
          },
        },
        customers: { create: stripeMocks.customersCreate },
        subscriptions: { retrieve: vi.fn() },
        invoices: { list: vi.fn() },
        billingPortal: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
      };
    },
  };
});

import { GET } from "../route";

const context = testContext();

const PRODUCT_ID = "prod_UNJnvXagfI3NS4";
const PROMO = "ZERO100";
const BUY_URL = `http://localhost:3000/buy/${PRODUCT_ID}?promo=${PROMO}`;

function params(productId: string) {
  return Promise.resolve({ productId });
}

describe("GET /buy/[productId]", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    reloadEnv();

    stripeMocks.productsRetrieve.mockReset();
    stripeMocks.pricesList.mockReset();
    stripeMocks.checkoutSessionsCreate.mockReset();
    stripeMocks.checkoutSessionsRetrieve.mockReset();
    stripeMocks.customersCreate.mockReset();

    // Default: product has a default_price that's an object.
    stripeMocks.productsRetrieve.mockResolvedValue({
      id: PRODUCT_ID,
      default_price: { id: "price_default" },
    });
    // If tests seed a Stripe customer on the org, customers.create shouldn't be
    // called; but default the fallback to a known id just in case.
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_test" });
  });

  it("redirects unauthenticated users to /sign-in with round-trip redirect_url", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/sign-in");
    expect(location).toContain(
      encodeURIComponent(`/buy/${PRODUCT_ID}?promo=${PROMO}`),
    );
  });

  it("returns 404 for an unknown productId", async () => {
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/buy/prod_UNKNOWN?promo=${PROMO}`,
      ),
      { params: params("prod_UNKNOWN") },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the promo code is not allowed for the product", async () => {
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/buy/${PRODUCT_ID}?promo=UNAUTHORIZED`,
      ),
      { params: params(PRODUCT_ID) },
    );
    expect(response.status).toBe(404);
  });

  it("redirects non-admin org members home with admin_required error", async () => {
    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:member",
    });

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("error=admin_required");
  });

  it("creates a Stripe Checkout session on first visit and records the row", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_fresh_1",
      url: "https://stripe.test/checkout/cs_fresh_1",
    });

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://stripe.test/checkout/cs_fresh_1",
    );

    expect(stripeMocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        line_items: [{ price: "price_default", quantity: 1 }],
        discounts: [{ coupon: PROMO }],
        metadata: {
          orgId: user.orgId,
          productId: PRODUCT_ID,
          promoCode: PROMO,
          purpose: "one_time_purchase",
        },
      }),
    );

    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      productId: PRODUCT_ID,
      promoCode: PROMO,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_1");
  });

  it("resumes to the same Stripe URL when the existing session is still open", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });

    await insertOrgPromoRedemption({
      orgId: user.orgId,
      productId: PRODUCT_ID,
      promoCode: PROMO,
      stripeSessionId: "cs_open_1",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_open_1",
      status: "open",
      url: "https://stripe.test/checkout/cs_open_1",
    });

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
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
      productId: PRODUCT_ID,
      promoCode: PROMO,
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

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://stripe.test/checkout/cs_fresh_2",
    );

    const row = await findOrgPromoRedemption({
      orgId: user.orgId,
      productId: PRODUCT_ID,
      promoCode: PROMO,
    });
    expect(row?.stripeSessionId).toBe("cs_fresh_2");
  });

  it("redirects home with already_redeemed when credits have landed", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      productId: PRODUCT_ID,
      promoCode: PROMO,
      stripeSessionId: "cs_granted_1",
    });
    await insertCreditExpiresRecord({
      orgId: user.orgId,
      source: "one_time_purchase",
      stripeInvoiceId: "cs_granted_1",
      amount: 100_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "promo=already_redeemed",
    );
    expect(stripeMocks.checkoutSessionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.checkoutSessionsRetrieve).not.toHaveBeenCalled();
  });

  it("redirects home with processing when Stripe session is complete but webhook hasn't landed yet", async () => {
    await updateOrgStripeFields(user.orgId, {
      stripeCustomerId: uniqueId("cus"),
    });
    await insertOrgPromoRedemption({
      orgId: user.orgId,
      productId: PRODUCT_ID,
      promoCode: PROMO,
      stripeSessionId: "cs_complete_1",
    });
    stripeMocks.checkoutSessionsRetrieve.mockResolvedValue({
      id: "cs_complete_1",
      status: "complete",
      url: null,
    });

    const response = await GET(createTestRequest(BUY_URL), {
      params: params(PRODUCT_ID),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("promo=processing");
  });
});
