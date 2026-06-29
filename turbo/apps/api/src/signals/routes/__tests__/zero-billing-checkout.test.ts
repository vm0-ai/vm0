import { randomUUID } from "node:crypto";

import {
  type BillingStatusResponse,
  zeroBillingCheckoutContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingStatusContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { onboardingSetupContract } from "@vm0/api-contracts/contracts/onboarding";
import { webhookStripeContract } from "@vm0/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const APP_ORIGIN = "http://localhost:3002";
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_CUSTOM_CREDITS = "price_test_custom_credits";
const TEST_PRICE_CONCURRENCY = "price_test_concurrency";
const STRIPE_WEBHOOK_SECRET = "whsec_checkout_test";

interface BillingOrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SubscriptionFixture extends BillingOrgFixture {
  readonly customerId: string;
  readonly subscriptionId: string;
}

function setZeroPrice(): void {
  mockEnv("ZERO_PRICE_PRO", TEST_PRICE_PRO);
  mockEnv("ZERO_PRICE_TEAM", TEST_PRICE_TEAM);
  mockEnv("ZERO_PRICE_CUSTOM_CREDITS", TEST_PRICE_CUSTOM_CREDITS);
  mockEnv("ZERO_PRICE_CONCURRENCY", TEST_PRICE_CONCURRENCY);
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

function createOrgFixture(): BillingOrgFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authenticateOrg(
  fixture: BillingOrgFixture,
  role: "org:admin" | "org:member" = "org:admin",
): void {
  mocks.clerk.session(fixture.userId, fixture.orgId, role);
}

function mockClerkOrganization(fixture: BillingOrgFixture): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: fixture.orgId,
    slug: `billing-${fixture.orgId.slice(-8)}`,
    name: "Billing Checkout Test Org",
    createdBy: fixture.userId,
  });
}

async function readBillingStatus(
  fixture: BillingOrgFixture,
): Promise<BillingStatusResponse> {
  authenticateOrg(fixture);
  const response = await accept(
    setupApp({ context })(zeroBillingStatusContract).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body;
}

async function createOnboardingPaymentPendingOrg(): Promise<BillingOrgFixture> {
  const fixture = createOrgFixture();
  authenticateOrg(fixture);
  await accept(
    setupApp({ context })(onboardingSetupContract).setup({
      headers: { authorization: "Bearer clerk-session" },
      body: { displayName: "Billing Checkout Test Agent" },
    }),
    [200, 409],
  );
  return fixture;
}

async function createStripeCustomerOrgForFixture(
  fixture: BillingOrgFixture,
  customerId: string,
): Promise<void> {
  authenticateOrg(fixture);
  context.mocks.stripe.customers.create.mockResolvedValueOnce({
    id: customerId,
  });
  context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
    url: "https://checkout.stripe.com/session/setup-customer",
  });

  await accept(
    setupApp({ context })(zeroBillingCheckoutContract).create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tier: "pro",
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      },
    }),
    [200],
  );
}

async function createSubscriptionOrg(args: {
  readonly tier: "pro" | "team";
  readonly customerId?: string;
  readonly subscriptionId?: string;
  readonly subscriptionStatus?: string;
  readonly periodEndUnix?: number;
  readonly cancelAtPeriodEnd?: boolean;
}): Promise<SubscriptionFixture> {
  const fixture = createOrgFixture();
  const customerId = args.customerId ?? `cus_${randomUUID().slice(0, 8)}`;
  const subscriptionId =
    args.subscriptionId ?? `sub_${randomUUID().slice(0, 8)}`;
  const periodEndUnix =
    args.periodEndUnix ?? Math.floor(now() / 1000) + 30 * 86_400;
  const priceId = args.tier === "team" ? TEST_PRICE_TEAM : TEST_PRICE_PRO;
  mockClerkOrganization(fixture);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
    id: customerId,
    metadata: { orgId: fixture.orgId },
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: subscriptionId,
    status: args.subscriptionStatus ?? "active",
    customer: customerId,
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      data: [
        {
          price: { id: priceId },
          current_period_end: periodEndUnix,
        },
      ],
    },
  });

  const event = {
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${randomUUID().slice(0, 8)}`,
        customer: customerId,
        metadata: {},
        parent: {
          subscription_details: {
            subscription: subscriptionId,
            metadata: {},
          },
        },
        lines: {
          data: [
            {
              price: { id: priceId },
              parent: { type: "subscription_item_details" },
              period: {
                start: periodEndUnix - 30 * 86_400,
                end: periodEndUnix,
              },
            },
          ],
        },
      },
    },
  };
  context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
  await accept(
    setupApp({ context })(webhookStripeContract).post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
    }),
    [200],
  );
  const status = await readBillingStatus(fixture);
  expect(status.tier).toBe(args.tier);
  expect(status.subscriptionStatus).toBe(args.subscriptionStatus ?? "active");
  expect(status.hasSubscription).toBeTruthy();
  return { ...fixture, customerId, subscriptionId };
}

async function createConcurrencySubscriptionOrg(args: {
  readonly subscriptionId: string;
  readonly slots: number;
  readonly periodEnd: Date;
}): Promise<BillingOrgFixture> {
  const fixture = createOrgFixture();
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const periodEndUnix = Math.floor(args.periodEnd.getTime() / 1000);
  mockClerkOrganization(fixture);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
    id: customerId,
    metadata: { orgId: fixture.orgId },
  });

  const event = {
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${randomUUID().slice(0, 8)}`,
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        parent: {
          subscription_details: {
            subscription: args.subscriptionId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          data: [
            {
              id: `il_${randomUUID().slice(0, 8)}`,
              quantity: args.slots,
              price: { id: TEST_PRICE_CONCURRENCY },
              parent: { type: "subscription_item_details" },
              period: {
                start: periodEndUnix - 30 * 86_400,
                end: periodEndUnix,
              },
            },
          ],
        },
      },
    },
  };
  context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
  await accept(
    setupApp({ context })(webhookStripeContract).post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
    }),
    [200],
  );
  const status = await readBillingStatus(fixture);
  expect(status.concurrencySubscriptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: args.subscriptionId,
        quantity: args.slots,
        currentPeriodEnd: args.periodEnd.toISOString(),
        cancelAtPeriodEnd: false,
      }),
    ]),
  );
  return fixture;
}

async function seedMemberRole(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
}): Promise<void> {
  await store.set(seedOrgMembership$, args, context.signal);
}

describe("POST /api/zero/billing/checkout", () => {
  beforeEach(() => {
    setZeroPrice();
  });

  async function trackedSeed(): Promise<{ orgId: string; userId: string }> {
    return createOrgFixture();
  }

  async function trackedBillingSeed(values: {
    readonly stripeCustomerId: string;
    readonly stripeSubscriptionId: string;
    readonly subscriptionStatus: string;
    readonly tier: "pro" | "team";
  }): Promise<{ orgId: string; userId: string }> {
    return createSubscriptionOrg({
      customerId: values.stripeCustomerId,
      subscriptionId: values.stripeSubscriptionId,
      subscriptionStatus: values.subscriptionStatus,
      tier: values.tier,
    });
  }

  async function trackedPendingSeed(): Promise<{
    orgId: string;
    userId: string;
  }> {
    return createOnboardingPaymentPendingOrg();
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
        // typed contract z.enum(["pro","team"]) rejects this at parse time
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
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
        },
      },
    });
  });

  it("tags preview Stripe checkout objects with the current job ref", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-123");
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/preview",
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
      url: "https://checkout.stripe.com/session/preview",
    });
    const expectedPreviewMetadata = {
      vm0_environment: "preview",
      job_ref: "pr-123",
    };
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: {
        orgId: fixture.orgId,
        ...expectedPreviewMetadata,
      },
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
          ...expectedPreviewMetadata,
        },
        subscription_data: expect.objectContaining({
          metadata: {
            orgId: fixture.orgId,
            tier: "pro",
            priceId: TEST_PRICE_PRO,
            ...expectedPreviewMetadata,
          },
        }),
      }),
    );
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
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
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

  it("accepts successUrl on the configured onboarding origin", async () => {
    mockEnv("ONBOARDING_URL", "https://www.vm7.ai:8443");

    const fixture = await trackedPendingSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/so-vm7-trial",
    });

    const client = setupApp({ context })(zeroBillingCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: "https://www.vm7.ai:8443/onboarding?billing=pro",
          cancelUrl: "https://www.vm7.ai:8443/onboarding?billing=canceled",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/so-vm7-trial",
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

  it("returns 400 when the tier price is unset", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // Override the beforeEach setZeroPrice() so activePriceId(tier) returns
    // undefined and the route falls into the "Price not configured" branch.
    mockEnv("ZERO_PRICE_PRO", undefined);

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
  beforeEach(() => {
    setZeroPrice();
  });

  async function trackedSeed(values?: {
    readonly onboardingPaymentPending?: boolean;
    readonly stripeCustomerId?: string;
    readonly stripeSubscriptionId?: string;
    readonly subscriptionStatus?: string;
    readonly tier?: "pro" | "team";
  }): Promise<{ orgId: string; userId: string }> {
    if (values?.stripeSubscriptionId && values.tier) {
      return createSubscriptionOrg({
        customerId: values.stripeCustomerId,
        subscriptionId: values.stripeSubscriptionId,
        subscriptionStatus: values.subscriptionStatus,
        tier: values.tier,
      });
    }
    if (values?.stripeCustomerId) {
      const fixture = values.onboardingPaymentPending
        ? await createOnboardingPaymentPendingOrg()
        : createOrgFixture();
      if (!values.onboardingPaymentPending) {
        authenticateOrg(fixture);
      }
      await createStripeCustomerOrgForFixture(fixture, values.stripeCustomerId);
      return fixture;
    }
    if (values?.onboardingPaymentPending) {
      return createOnboardingPaymentPendingOrg();
    }
    return createOrgFixture();
  }

  it("records a completed subscription checkout while waiting for invoice payment", async () => {
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

    expect(response.body).toStrictEqual({ completed: false });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("pro-suspend");
    expect(status.hasSubscription).toBeTruthy();
    expect(status.subscriptionStatus).toBe("trialing");
    expect(status.onboardingPaymentPending).toBeTruthy();
    expect(status.currentPeriodEnd).toBeNull();
  });

  it("keeps checkout pending when the subscription is incomplete", async () => {
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
      status: "incomplete",
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

    expect(response.body).toStrictEqual({ completed: false });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("pro-suspend");
    expect(status.hasSubscription).toBeTruthy();
    expect(status.subscriptionStatus).toBe("incomplete");
    expect(status.onboardingPaymentPending).toBeTruthy();
    expect(status.currentPeriodEnd).toBeNull();
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

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("team");
    expect(status.hasSubscription).toBeTruthy();
    expect(status.subscriptionStatus).toBe("active");
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

describe("POST /api/zero/billing/concurrency-checkout", () => {
  beforeEach(() => {
    setZeroPrice();
  });

  async function trackedSeed(): Promise<{ orgId: string; userId: string }> {
    return createOrgFixture();
  }

  it("creates concurrency subscription checkout with the requested quantity", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/concurrency",
    });

    const client = setupApp({ context })(
      zeroBillingConcurrencyCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/concurrency",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/billing?concurrency=success`,
      cancel_url: `${APP_ORIGIN}/billing?concurrency=canceled`,
      metadata: {
        purpose: "concurrency_subscription",
        orgId: fixture.orgId,
        priceId: TEST_PRICE_CONCURRENCY,
        quantity: "3",
      },
      subscription_data: {
        metadata: {
          purpose: "concurrency_subscription",
          orgId: fixture.orgId,
          priceId: TEST_PRICE_CONCURRENCY,
          quantity: "3",
        },
      },
    });
  });

  it("creates concurrency checkout for zero tokens with billing write capability", async () => {
    const fixture = await trackedSeed();
    await seedMemberRole({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
    });

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/zero-concurrency",
    });
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:write"],
    });

    const client = setupApp({ context })(
      zeroBillingConcurrencyCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          quantity: 2,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/zero-concurrency",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
      }),
    );
  });

  it("returns 400 when concurrency price is not configured", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("ZERO_PRICE_CONCURRENCY", undefined);

    const client = setupApp({ context })(
      zeroBillingConcurrencyCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Concurrency price not configured",
        code: "BAD_REQUEST",
      },
    });
  });

  it("cancels an active concurrency subscription at period end", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const client = setupApp({ context })(
      zeroBillingConcurrencySubscriptionContract,
    );

    const response = await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      currentPeriodEnd: periodEnd.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      { cancel_at_period_end: true },
    );
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          cancelAtPeriodEnd: true,
        }),
      ]),
    );
  });

  it("restores an active concurrency subscription renewal", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const client = setupApp({ context })(
      zeroBillingConcurrencySubscriptionContract,
    );

    await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.update.mockClear();

    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const response = await accept(
      client.restore({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      { cancel_at_period_end: false },
    );
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          cancelAtPeriodEnd: false,
        }),
      ]),
    );
  });

  it("returns 404 when restoring a concurrency subscription outside the org", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(
      zeroBillingConcurrencySubscriptionContract,
    );

    const response = await accept(
      client.restore({
        params: { subscriptionId: `sub_${randomUUID()}` },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("returns 404 when cancelling a concurrency subscription outside the org", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(
      zeroBillingConcurrencySubscriptionContract,
    );

    const response = await accept(
      client.cancel({
        params: { subscriptionId: `sub_${randomUUID()}` },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/zero/billing/credit-checkout", () => {
  beforeEach(() => {
    setZeroPrice();
  });

  async function trackedSeed(): Promise<{ orgId: string; userId: string }> {
    return createOrgFixture();
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
        invoice_creation: {
          enabled: true,
          invoice_data: {
            metadata: {
              type: "credit_purchase",
              purpose: "credit_purchase",
              orgId: fixture.orgId,
              creditsAmountMode: "amount_subtotal",
              requestedCreditsAmount: "20000",
            },
          },
        },
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
        invoice_creation: {
          enabled: true,
          invoice_data: {
            metadata: {
              type: "credit_purchase",
              purpose: "credit_purchase",
              orgId: fixture.orgId,
              creditsAmountMode: "amount_subtotal",
              requestedCreditsAmount: "150000",
            },
          },
        },
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
    mockEnv("ZERO_PRICE_CUSTOM_CREDITS", undefined);

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
