import { randomUUID } from "node:crypto";

import {
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 600,
  });
}

async function seedOrgRow(values?: {
  readonly onboardingPaymentPending?: boolean;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly subscriptionStatus?: string;
  readonly tier?: string;
}): Promise<{
  readonly orgId: string;
  readonly userId: string;
}> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMetadata).values({
    orgId,
    onboardingPaymentPending: values?.onboardingPaymentPending ?? false,
    stripeCustomerId: values?.stripeCustomerId,
    stripeSubscriptionId: values?.stripeSubscriptionId,
    subscriptionStatus: values?.subscriptionStatus,
    tier: values?.tier,
  });
  return { orgId, userId };
}

async function deleteOrgRow(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
}

async function seedMemberRole(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMembersCache).values(args);
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

  async function trackedBillingSeed(values: {
    readonly stripeCustomerId: string;
    readonly stripeSubscriptionId: string;
    readonly subscriptionStatus: string;
    readonly tier: string;
  }): Promise<{ orgId: string; userId: string }> {
    const fixture = await seedOrgRow(values);
    createdOrgIds.push(fixture.orgId);
    return fixture;
  }

  async function trackedPendingSeed(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const fixture = await seedOrgRow({ onboardingPaymentPending: true });
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
      metadata: {
        orgId: fixture.orgId,
        tier: "pro",
        priceId: TEST_PRICE_PRO,
        flow: "standard",
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
          flow: "standard",
        },
      },
    });
  });

  it("returns 400 when checkout would downgrade the current tier", async () => {
    const fixture = await trackedBillingSeed({
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
      stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      subscriptionStatus: "active",
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

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
        message:
          "Cannot create Pro checkout while current tier is Team; use billing management to change plans",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when checkout would duplicate the current tier", async () => {
    const fixture = await trackedBillingSeed({
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
      stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      subscriptionStatus: "active",
      tier: "pro",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

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
        message:
          "Cannot create Pro checkout while current tier is Pro; use billing management to change plans",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("attaches ad attribution to Stripe checkout and subscription metadata", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/attributed",
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          adAttribution: {
            vm0_source: "presentation",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "presentation_search_en",
            utm_content: "hero",
            gclid: "test-gclid",
            gclid_present: "true",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/attributed",
    });
    const expectedAttribution = {
      vm0_source: "presentation",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "presentation_search_en",
      utm_content: "hero",
      gclid: "test-gclid",
      gclid_present: "true",
    };
    const expectedMetadata = {
      orgId: fixture.orgId,
      tier: "pro",
      priceId: TEST_PRICE_PRO,
      flow: "standard",
      ...expectedAttribution,
    };
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: {
        orgId: fixture.orgId,
        ...expectedAttribution,
      },
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expectedMetadata,
        subscription_data: expect.objectContaining({
          metadata: expectedMetadata,
        }),
      }),
    );
  });

  it("returns Pro trial checkout URL during onboarding payment", async () => {
    const fixture = await trackedPendingSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/trial",
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: `${APP_ORIGIN}/onboarding?billing=pro`,
          cancelUrl: `${APP_ORIGIN}/onboarding?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/trial",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/onboarding?billing=pro`,
      cancel_url: `${APP_ORIGIN}/onboarding?billing=canceled`,
      metadata: {
        orgId: fixture.orgId,
        tier: "pro",
        priceId: TEST_PRICE_PRO,
        flow: "trial",
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
          flow: "trial",
        },
        trial_period_days: 7,
      },
    });
  });

  it("rejects Pro trial checkout outside onboarding payment", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Pro trial checkout is only available during onboarding",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects trial checkout for non-Pro tiers", async () => {
    const fixture = await trackedPendingSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "team",
          trialDays: 7,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Trial checkout is only available for Pro tier",
        code: "BAD_REQUEST",
      },
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

  it("accepts successUrl on a first-party so.vm0.ai origin", async () => {
    const fixture = await trackedPendingSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/so-trial",
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: "https://so.vm0.ai/onboarding?billing=pro",
          cancelUrl: "https://so.vm0.ai/onboarding?billing=canceled",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/so-trial",
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

describe("POST /api/zero/billing/checkout/complete", () => {
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

  async function trackedSeed(values?: {
    readonly onboardingPaymentPending?: boolean;
    readonly stripeCustomerId?: string;
    readonly stripeSubscriptionId?: string;
    readonly subscriptionStatus?: string;
    readonly tier?: string;
  }): Promise<{ orgId: string; userId: string }> {
    const fixture = await seedOrgRow(values);
    createdOrgIds.push(fixture.orgId);
    return fixture;
  }

  it("reconciles a completed subscription checkout for the current org", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      onboardingPaymentPending: true,
      stripeCustomerId: customerId,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_completed",
      mode: "subscription",
      status: "complete",
      customer: customerId,
      subscription: subscriptionId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      status: "trialing",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: true });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        subscriptionStatus: orgMetadata.subscriptionStatus,
        onboardingPaymentPending: orgMetadata.onboardingPaymentPending,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);

    expect(row).toMatchObject({
      tier: "pro",
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: "trialing",
      onboardingPaymentPending: false,
      currentPeriodEnd: new Date(1_800_000_000 * 1000),
    });
  });

  it("allows completion when the same subscription is already stored", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: "active",
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_completed",
      mode: "subscription",
      status: "complete",
      customer: customerId,
      subscription: subscriptionId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      status: "active",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_TEAM },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: true });
  });

  it("returns 400 when completed checkout would downgrade the current tier", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const existingSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const checkoutSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      stripeCustomerId: customerId,
      stripeSubscriptionId: existingSubscriptionId,
      subscriptionStatus: "active",
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_completed",
      mode: "subscription",
      status: "complete",
      customer: customerId,
      subscription: checkoutSubscriptionId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: checkoutSubscriptionId,
      status: "active",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Cannot create Pro checkout while current tier is Team; use billing management to change plans",
        code: "BAD_REQUEST",
      },
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        subscriptionStatus: orgMetadata.subscriptionStatus,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);

    expect(row).toStrictEqual({
      tier: "team",
      stripeSubscriptionId: existingSubscriptionId,
      subscriptionStatus: "active",
    });
  });

  it("returns completed false while Stripe has not completed the session", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      onboardingPaymentPending: true,
      stripeCustomerId: customerId,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_open",
      mode: "subscription",
      status: "open",
      customer: customerId,
      subscription: null,
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_open" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: false });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("rejects checkout sessions from another customer", async () => {
    const fixture = await trackedSeed({
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_other_customer",
      mode: "subscription",
      status: "complete",
      customer: `cus_${randomUUID().slice(0, 8)}`,
      subscription: `sub_${randomUUID().slice(0, 8)}`,
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_other_customer" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Checkout session does not belong to current organization",
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

  function mockCustomCreditCheckoutPrice(checkoutPriceId: string): void {
    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: TEST_PRICE_CUSTOM_CREDITS,
      currency: "usd",
      product: "prod_test_custom_credits",
      custom_unit_amount: {
        minimum: 100,
        maximum: 1_000_000,
        preset: 10_000,
      },
    });
    context.mocks.stripe.prices.create.mockResolvedValue({
      id: checkoutPriceId,
    });
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

  it("returns 403 for zero tokens without billing write capability", async () => {
    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["billing:read"],
    });

    const client = setupApp({ context })(zeroBillingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Missing required capability: billing:write",
      code: "FORBIDDEN",
    });
  });

  it("creates one-time credit checkout for free-tier admins", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const checkoutPriceId = "price_test_credit_checkout";
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    mockCustomCreditCheckoutPrice(checkoutPriceId);
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
        preset: 2000,
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
          creditsAmountMode: "amount_subtotal",
          requestedCreditsAmount: "20000",
        },
      }),
    );
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.not.objectContaining({
        allow_promotion_codes: true,
      }),
    );
  });

  it("creates credit checkout for zero tokens with billing write capability", async () => {
    const fixture = await trackedSeed();
    await seedMemberRole({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
    });

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    mockCustomCreditCheckoutPrice("price_test_zero_credit_checkout");
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/zero-credit",
    });
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:write"],
    });

    const client = setupApp({ context })(zeroBillingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/zero-credit",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
      }),
    );
  });

  it("creates custom amount credit checkout with the configured Stripe price", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const checkoutPriceId = "price_test_custom_checkout";
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    mockCustomCreditCheckoutPrice(checkoutPriceId);
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
          creditsAmountMode: "amount_subtotal",
          requestedCreditsAmount: "150000",
        },
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: {
            type: "credit_purchase",
            purpose: "credit_purchase",
            orgId: fixture.orgId,
            creditsAmountMode: "amount_subtotal",
            requestedCreditsAmount: "150000",
          },
        },
      }),
    );
  });

  it("returns 400 when credit price is not configured", async () => {
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
