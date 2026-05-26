import { randomUUID } from "node:crypto";

import {
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const APP_ORIGIN = "http://localhost:3002";
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_CUSTOM_CREDITS = "price_test_custom_credits";

function setZeroPrice(): void {
  mockEnv(
    "ZERO_PRICE",
    JSON.stringify({
      pro: [TEST_PRICE_PRO],
      team: [TEST_PRICE_TEAM],
      customCredits: [TEST_PRICE_CUSTOM_CREDITS],
    }),
  );
}

async function seedOrgRow(): Promise<{
  readonly orgId: string;
  readonly userId: string;
}> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMetadata).values({ orgId });
  return { orgId, userId };
}

async function deleteOrgRow(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
}

describe("POST /api/zero/billing/checkout", () => {
  const createdOrgIds: string[] = [];

  beforeEach(() => {
    setZeroPrice();
  });

  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const orgId = createdOrgIds.pop();
      if (orgId) {
        await deleteOrgRow(orgId);
      }
    }
  });

  async function trackedSeed(): Promise<{ orgId: string; userId: string }> {
    const fixture = await seedOrgRow();
    createdOrgIds.push(fixture.orgId);
    return fixture;
  }

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: {},
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: {},
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid tier", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await client.create({
      body: {
        // ts-rest contract z.enum(["pro","team"]) rejects this at parse time
        tier: "enterprise" as "pro",
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
  });

  it("returns 403 for non-admin org member", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns checkout URL on success", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/test",
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/test",
    });

    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: { orgId: fixture.orgId },
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/billing?billing=success`,
      cancel_url: `${APP_ORIGIN}/billing?billing=canceled`,
      subscription_data: { metadata: { orgId: fixture.orgId } },
    });
  });

  it("returns 400 when successUrl origin does not match APP_URL", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: "https://evil.example.com/billing?billing=success",
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
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

  it("returns 401 when caller has no org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when ZERO_PRICE is unset for the tier", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // Override the beforeEach setZeroPrice() with an empty mapping so
    // activePriceId(tier) returns undefined and the route falls into the
    // "Price not configured" branch.
    mockEnv("ZERO_PRICE", JSON.stringify({}));

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Price not configured for pro tier",
        code: "BAD_REQUEST",
      },
    });
  });
});

describe("POST /api/zero/billing/credit-checkout", () => {
  const createdOrgIds: string[] = [];

  beforeEach(() => {
    setZeroPrice();
  });

  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const orgId = createdOrgIds.pop();
      if (orgId) {
        await deleteOrgRow(orgId);
      }
    }
  });

  async function trackedSeed(): Promise<{ orgId: string; userId: string }> {
    const fixture = await seedOrgRow();
    createdOrgIds.push(fixture.orgId);
    return fixture;
  }

  it("returns 403 for non-admin org member", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroBillingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can buy credits",
        code: "FORBIDDEN",
      },
    });
  });

  it("creates one-time credit checkout for free-tier admins", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/credit",
    });

    const client = setupApp({ context })(zeroBillingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/credit",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: 2000,
              product_data: { name: "20,000 Zero credits" },
            },
            quantity: 1,
          },
        ],
        metadata: {
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          creditsAmount: "20000",
        },
      }),
    );
  });

  it("creates custom amount credit checkout with the configured Stripe price", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const checkoutPriceId = "price_test_custom_checkout";
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: TEST_PRICE_CUSTOM_CREDITS,
      currency: "usd",
      product: "prod_test_custom_credits",
      custom_unit_amount: { minimum: 100, maximum: 1_000_000, preset: 10_000 },
    });
    context.mocks.stripe.prices.create.mockResolvedValue({
      id: checkoutPriceId,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/custom-credit",
    });

    const client = setupApp({ context })(zeroBillingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 150_000,
          customAmount: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/custom-credit",
    });
    expect(context.mocks.stripe.prices.retrieve).toHaveBeenCalledWith(
      TEST_PRICE_CUSTOM_CREDITS,
    );
    expect(context.mocks.stripe.prices.create).toHaveBeenCalledWith({
      currency: "usd",
      product: "prod_test_custom_credits",
      custom_unit_amount: {
        enabled: true,
        minimum: 100,
        maximum: 1_000_000,
        preset: 15_000,
      },
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: checkoutPriceId, quantity: 1 }],
        metadata: {
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          creditsAmountMode: "amount_total",
          requestedCreditsAmount: "150000",
        },
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: {
            type: "credit_purchase",
            purpose: "credit_purchase",
            orgId: fixture.orgId,
            creditsAmountMode: "amount_total",
            requestedCreditsAmount: "150000",
          },
        },
      }),
    );
  });

  it("returns 400 when custom credit price is not configured", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({
        pro: [TEST_PRICE_PRO],
        team: [TEST_PRICE_TEAM],
      }),
    );

    const client = setupApp({ context })(zeroBillingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 100_000,
          customAmount: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Custom credit price not configured",
        code: "BAD_REQUEST",
      },
    });
  });
});
