import { randomUUID } from "node:crypto";

import {
  type BillingStatusResponse,
  USAGE_PACKS_USD,
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingUsagePackManagementContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingStatusContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { webhookStripeContract } from "@vm0/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import type StripeSDK from "stripe";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import {
  seedOrgMetadata,
  setOnboardingPaymentPendingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { cronReconcileBillingEntitlementsRoutes } from "../cron-reconcile-billing-entitlements";
import { zeroBillingCheckoutRoutes } from "../zero-billing-checkout";
import { zeroBillingConcurrencyCheckoutRoutes } from "../zero-billing-concurrency-checkout";
import { zeroBillingConcurrencySubscriptionRoutes } from "../zero-billing-concurrency-subscriptions";
import { zeroBillingCreditCheckoutRoutes } from "../zero-billing-credit-checkout";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroOrgMembersRoutes } from "../zero-org-members";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
  type TestUsagePackSubscriptionStateAction,
  type TestUsagePackSubscriptionStateResponse,
} from "../test-usage-pack-subscription-state";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function usagePackStateAction(
  body: TestUsagePackSubscriptionStateAction,
): Promise<TestUsagePackSubscriptionStateResponse> {
  const response = await accept(
    setupApp({
      context,
      routes: testUsagePackSubscriptionStateRoutes,
    })(testUsagePackSubscriptionStateContract).action({ body }),
    [200],
  );
  return response.body;
}

async function readUsagePackState(
  orgId: string,
  usagePackSubscriptionId?: string,
) {
  const response = await usagePackStateAction({
    action: "read",
    orgId,
    usagePackSubscriptionId,
  });
  if (response.action !== "read") {
    throw new Error("Usage pack test state did not return a read response");
  }
  return response.state;
}

const APP_ORIGIN = "http://localhost:3002";
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_USAGE_PACK_PLAN_PRO = "price_test_usage_pack_plan_pro";
const TEST_PRICE_USAGE_PACK_PLAN_TEAM = "price_test_usage_pack_plan_team";
const TEST_PRICE_USAGE_PACK_20 = "price_test_usage_pack_20";
const TEST_PRICE_USAGE_PACK_50 = "price_test_usage_pack_50";
const TEST_PRICE_USAGE_PACK_100 = "price_test_usage_pack_100";
const TEST_PRICE_USAGE_PACK_200 = "price_test_usage_pack_200";
const TEST_PRICE_CUSTOM_CREDIT_UNIT = "price_test_custom_credit_unit";
const TEST_PRICE_CONCURRENCY = "price_test_concurrency";
const TEST_CONCURRENCY_PORTAL_CONFIGURATION = "bpc_test_concurrency";
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
  mockEnv("ZERO_PRICE_CUSTOM_CREDIT_UNIT", TEST_PRICE_CUSTOM_CREDIT_UNIT);
  mockEnv("ZERO_PRICE_CONCURRENCY", TEST_PRICE_CONCURRENCY);
  mockEnv(
    "STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID",
    TEST_CONCURRENCY_PORTAL_CONFIGURATION,
  );
}

function setUsagePackPrices(): void {
  mockEnv("ZERO_PRICE_USAGE_PACK_PLAN_PRO", TEST_PRICE_USAGE_PACK_PLAN_PRO);
  mockEnv("ZERO_PRICE_USAGE_PACK_PLAN_TEAM", TEST_PRICE_USAGE_PACK_PLAN_TEAM);
  mockEnv("ZERO_PRICE_USAGE_PACK_20", TEST_PRICE_USAGE_PACK_20);
  mockEnv("ZERO_PRICE_USAGE_PACK_50", TEST_PRICE_USAGE_PACK_50);
  mockEnv("ZERO_PRICE_USAGE_PACK_100", TEST_PRICE_USAGE_PACK_100);
  mockEnv("ZERO_PRICE_USAGE_PACK_200", TEST_PRICE_USAGE_PACK_200);
}

function usagePackPriceConfiguration(priceId: string): {
  readonly usagePackUsd: 20 | 50 | 100 | 200;
  readonly bonusCredits: number;
} {
  switch (priceId) {
    case TEST_PRICE_USAGE_PACK_20: {
      return { usagePackUsd: 20, bonusCredits: 400 };
    }
    case TEST_PRICE_USAGE_PACK_50: {
      return { usagePackUsd: 50, bonusCredits: 2600 };
    }
    case TEST_PRICE_USAGE_PACK_100: {
      return { usagePackUsd: 100, bonusCredits: 8700 };
    }
    case TEST_PRICE_USAGE_PACK_200: {
      return { usagePackUsd: 200, bonusCredits: 22_200 };
    }
    default: {
      throw new Error(`Unexpected usage pack Price: ${priceId}`);
    }
  }
}

function mockUsagePackCatalog(): void {
  context.mocks.stripe.prices.retrieve.mockImplementation((priceId) => {
    if (typeof priceId !== "string") {
      throw new Error("Expected a Stripe Price ID");
    }
    const configuration = usagePackPriceConfiguration(priceId);
    return Promise.resolve({
      id: priceId,
      active: true,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: configuration.usagePackUsd * 100,
      product: {
        id: `prod_${configuration.usagePackUsd}`,
        metadata: { bonusCredits: String(configuration.bonusCredits) },
      },
    });
  });
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

function createOrgFixture(orgId = `org_${randomUUID()}`): BillingOrgFixture {
  return {
    orgId,
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
    setupApp({ context, routes: zeroBillingStatusRoutes })(
      zeroBillingStatusContract,
    ).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body;
}

async function createOnboardingPaymentPendingOrg(): Promise<BillingOrgFixture> {
  const fixture = createOrgFixture();
  const actor = {
    ...fixture,
    orgRole: "org:admin" as const,
    email: `${fixture.userId}@example.test`,
  };
  const completed = await createBddApi(context).completeOnboarding(actor);
  expect(completed.status).toBe(200);
  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "limited-free-1",
    credits: 0,
  });
  await setOnboardingPaymentPendingFixture({
    orgId: fixture.orgId,
    onboardingPaymentPending: true,
  });
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
    setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    ).create({
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
    setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    ).post({
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
  readonly tier?: Extract<OrgTier, "team" | "custom">;
}): Promise<SubscriptionFixture> {
  const fixture = createOrgFixture();
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const periodEndUnix = Math.floor(args.periodEnd.getTime() / 1000);
  if (args.tier) {
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: args.tier,
      credits: 0,
    });
  }
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
    setupApp({ context, routes: webhooksStripeRoutes })(
      webhookStripeContract,
    ).post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
    }),
    [200],
  );
  context.mocks.stripe.subscriptions.retrieve.mockClear();
  const status = await readBillingStatus(fixture);
  expect(status.concurrencySubscriptions).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: args.subscriptionId,
        quantity: args.slots,
        currentPeriodEnd: args.periodEnd.toISOString(),
        cancelAtPeriodEnd: false,
      }),
    ]),
  );
  return { ...fixture, customerId, subscriptionId: args.subscriptionId };
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

  function trackedSeed(): { orgId: string; userId: string } {
    return createOrgFixture();
  }

  function trackedBillingSeed(values: {
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

  function trackedPendingSeed(): Promise<{
    orgId: string;
    userId: string;
  }> {
    return createOnboardingPaymentPendingOrg();
  }

  async function trackedCustomSeed(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const fixture = createOrgFixture();
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "custom",
      credits: 0,
    });
    return fixture;
  }

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

  it("returns 400 before calling Stripe for an oversized return URL", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );
    const oversizedSuccessUrl = `${APP_ORIGIN}/billing?state=`.padEnd(
      5001,
      "x",
    );
    expect(oversizedSuccessUrl).toHaveLength(5001);
    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: oversizedSuccessUrl,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.status).toBe(400);
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin org member", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

  it("returns 400 for subscription checkout when current tier is custom", async () => {
    const fixture = await trackedCustomSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

    for (const tier of ["pro", "team"] as const) {
      const response = await accept(
        client.create({
          body: {
            tier,
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: `Cannot create ${tier === "pro" ? "Pro" : "Team"} checkout while current tier is Custom; use billing management to change plans`,
          code: "BAD_REQUEST",
        },
      });
    }
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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

  it("accepts successUrl on a first-party www.vm0.ai origin", async () => {
    const fixture = await trackedPendingSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/so-trial",
    });

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: "https://www.vm0.ai/billing?billing=pro",
          cancelUrl: "https://www.vm0.ai/billing?billing=canceled",
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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

describe("POST /api/zero/billing/usage-pack-checkout", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setZeroPrice();
    setUsagePackPrices();
    mockUsagePackCatalog();
  });

  it("keeps the usage pack catalog behind the same feature switch", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackCatalogContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Usage pack checkout is not enabled",
        code: "FORBIDDEN",
      },
    });
    expect(context.mocks.stripe.prices.retrieve).not.toHaveBeenCalled();
  });

  it("returns the server-validated Stripe usage pack catalog", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackCatalogContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          totalCredits: 52_600,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 8700,
          totalCredits: 108_700,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 22_200,
          totalCredits: 222_200,
        },
      ],
    });
  });

  it("keeps usage pack checkout behind its feature switch", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const before = await readUsagePackState(fixture.orgId);

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Usage pack checkout is not enabled",
        code: "FORBIDDEN",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.prices.retrieve).not.toHaveBeenCalled();
    const after = await readUsagePackState(fixture.orgId);
    expect(after.subscriptionCount).toBe(before.subscriptionCount);
  });

  it("checks out the new plan for an enabled organization", async () => {
    const fixture = createOrgFixture();
    const memberIds = Array.from({ length: 101 }, (_, index) => {
      return index === 0 ? fixture.userId : `user_${randomUUID()}`;
    });
    const invitationId = `inv_${randomUUID()}`;
    const customerId = `cus_${randomUUID()}`;
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      (args) => {
        const offset =
          typeof args === "object" &&
          args !== null &&
          "offset" in args &&
          typeof args.offset === "number"
            ? args.offset
            : 0;
        const limit =
          typeof args === "object" &&
          args !== null &&
          "limit" in args &&
          typeof args.limit === "number"
            ? args.limit
            : 100;
        return Promise.resolve({
          data: memberIds.slice(offset, offset + limit).map((userId) => {
            return {
              role: "org:member",
              publicUserData: { userId },
              createdAt: now(),
            };
          }),
        });
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: invitationId,
            emailAddress: "pending@example.com",
            role: "org:member",
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    let snapshotExistedBeforeStripe = false;
    let createdUsagePackSubscriptionId: string | null = null;
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
      async (input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("metadata" in input) ||
          typeof input.metadata !== "object" ||
          input.metadata === null ||
          !("usagePackSubscriptionId" in input.metadata) ||
          typeof input.metadata.usagePackSubscriptionId !== "string"
        ) {
          throw new Error("Expected usage pack subscription metadata");
        }
        createdUsagePackSubscriptionId = input.metadata.usagePackSubscriptionId;
        const state = await readUsagePackState(
          fixture.orgId,
          input.metadata.usagePackSubscriptionId,
        );
        snapshotExistedBeforeStripe = state.subscription !== null;
        return {
          id: checkoutSessionId,
          url: "https://checkout.stripe.com/session/usage-pack",
        };
      },
    );

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "team",
          memberUsagePacks: [
            ...memberIds.map((memberId, index) => {
              return {
                memberId,
                usagePackUsd: USAGE_PACKS_USD[index] ?? 20,
              };
            }),
            { memberId: invitationId, usagePackUsd: 20 },
          ],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/usage-pack",
    });
    expect(snapshotExistedBeforeStripe).toBeTruthy();
    if (!createdUsagePackSubscriptionId) {
      throw new Error("Checkout did not expose its usage pack subscription ID");
    }
    const createdSnapshotId = createdUsagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: createdSnapshotId,
        deleteGrants: false,
        deleteOrgMetadata: false,
      });
    });
    const state = await readUsagePackState(fixture.orgId, createdSnapshotId);
    const snapshot = state.subscription;
    expect(snapshot?.stripeCheckoutSessionId).toBe(checkoutSessionId);
    const allocationRows = state.allocations;
    expect(allocationRows).toHaveLength(102);
    expect(allocationRows).toContainEqual(
      expect.objectContaining({
        userId: memberIds[1],
        invitationId: null,
        usagePackUsd: 50,
        stripePriceId: TEST_PRICE_USAGE_PACK_50,
        status: "pending_payment",
      }),
    );
    expect(allocationRows).toContainEqual(
      expect.objectContaining({
        userId: null,
        invitationId,
        usagePackUsd: 20,
        stripePriceId: TEST_PRICE_USAGE_PACK_20,
        status: "pending_payment",
      }),
    );
    const metadata = {
      orgId: fixture.orgId,
      tier: "team",
      priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: createdSnapshotId,
    };
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: expect.any(String),
      line_items: [
        { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
        { price: TEST_PRICE_USAGE_PACK_20, quantity: 99 },
        { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
        { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
        { price: TEST_PRICE_USAGE_PACK_200, quantity: 1 },
      ],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/billing?billing=success`,
      cancel_url: `${APP_ORIGIN}/billing?billing=canceled`,
      metadata,
      subscription_data: { metadata },
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenNthCalledWith(1, {
      organizationId: fixture.orgId,
      limit: 100,
      offset: 0,
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenNthCalledWith(2, {
      organizationId: fixture.orgId,
      limit: 100,
      offset: 100,
    });
  });

  it("rejects stale member selections before creating checkout", async () => {
    const fixture = createOrgFixture();
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
          {
            role: "org:member",
            publicUserData: { userId: `user_${randomUUID()}` },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization members changed; refresh billing and try again",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });
});

describe("usage pack allocation management", () => {
  interface ManagedUsagePackFixture extends BillingOrgFixture {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly usagePackSubscriptionId: string;
    readonly billingPeriod: { readonly start: number; readonly end: number };
    readonly tier: "pro" | "team";
  }

  function managedUsagePackPlanPriceId(
    tier: ManagedUsagePackFixture["tier"],
  ): string {
    return tier === "pro"
      ? TEST_PRICE_USAGE_PACK_PLAN_PRO
      : TEST_PRICE_USAGE_PACK_PLAN_TEAM;
  }

  function managedUsagePackMetadata(fixture: ManagedUsagePackFixture) {
    return {
      orgId: fixture.orgId,
      tier: fixture.tier,
      priceId: managedUsagePackPlanPriceId(fixture.tier),
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: fixture.usagePackSubscriptionId,
    };
  }

  function managedUsagePackSubscription(
    fixture: ManagedUsagePackFixture,
    quantities: ReadonlyMap<string, number>,
    billingPeriod = fixture.billingPeriod,
    options?: {
      readonly pendingUpdateExpiresAt?: number;
      readonly latestInvoice?: object | string | null;
      readonly scheduleId?: string;
    },
  ) {
    return {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: options?.scheduleId ?? null,
      pending_update: options?.pendingUpdateExpiresAt
        ? { expires_at: options.pendingUpdateExpiresAt }
        : null,
      latest_invoice: options?.latestInvoice ?? null,
      metadata: managedUsagePackMetadata(fixture),
      items: {
        data: [
          {
            id: "si_usage_pack_plan",
            price: {
              id: managedUsagePackPlanPriceId(fixture.tier),
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 1,
            current_period_start: billingPeriod.start,
            current_period_end: billingPeriod.end,
          },
          ...[...quantities].map(([priceId, quantity]) => {
            return {
              id: `si_${priceId}`,
              price: {
                id: priceId,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity,
              current_period_start: billingPeriod.start,
              current_period_end: billingPeriod.end,
            };
          }),
        ],
      },
    };
  }

  function managedUsagePackInvoice(
    fixture: ManagedUsagePackFixture,
    args: {
      readonly invoiceId: string;
      readonly quantities: ReadonlyMap<string, number>;
      readonly billingPeriod?: { readonly start: number; readonly end: number };
    },
  ) {
    const billingPeriod = args.billingPeriod ?? fixture.billingPeriod;
    const metadata = managedUsagePackMetadata(fixture);
    return {
      id: args.invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata,
        },
      },
      lines: {
        data: [...args.quantities].map(([priceId, quantity]) => {
          const configuration = usagePackPriceConfiguration(priceId);
          return {
            id: `il_${randomUUID()}`,
            amount: configuration.usagePackUsd * 100 * quantity,
            subtotal: configuration.usagePackUsd * 100 * quantity,
            quantity,
            price: { id: priceId },
            period: billingPeriod,
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          };
        }),
      },
    };
  }

  function managedUsagePackUpgradeInvoice(
    fixture: ManagedUsagePackFixture,
    args: {
      readonly invoiceId: string;
      readonly sourcePriceId: string;
      readonly targetPriceId: string;
      readonly prorationTimestamp: number;
    },
  ) {
    const metadata = managedUsagePackMetadata(fixture);
    const line = (priceId: string, amount: number) => {
      return {
        id: `il_${randomUUID()}`,
        amount,
        subtotal: amount,
        quantity: 1,
        price: { id: priceId },
        period: {
          start: args.prorationTimestamp,
          end: fixture.billingPeriod.end,
        },
        parent: {
          type: "subscription_item_details" as const,
          subscription_item_details: { proration: true },
        },
      };
    };
    return {
      id: args.invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      hosted_invoice_url: `https://invoice.stripe.test/${args.invoiceId}`,
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata,
        },
      },
      lines: {
        data: [line(args.sourcePriceId, -1000), line(args.targetPriceId, 2500)],
      },
    };
  }

  async function postManagedUsagePackEvent(
    type: string,
    object: object,
  ): Promise<void> {
    const event = {
      id: `evt_${randomUUID()}`,
      type,
      created: Math.floor(now() / 1000),
      data: { object },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=usage-pack-change" },
      }),
      [200],
    );
  }

  async function seedManagedUsagePack(
    allocations: readonly {
      readonly userId: string;
      readonly usagePackUsd: 20 | 50 | 100 | 200;
    }[],
    tier: ManagedUsagePackFixture["tier"] = "pro",
  ): Promise<ManagedUsagePackFixture> {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    const current = Math.floor(now() / 1000);
    const billingPeriod = {
      start: current - 15 * 86_400,
      end: current + 15 * 86_400,
    };
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    const seeded = await usagePackStateAction({
      action: "seed",
      orgId: fixture.orgId,
      tier,
      stripePlanPriceId: managedUsagePackPlanPriceId(tier),
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: checkoutSessionId,
      allocations: allocations.map((allocation) => {
        return {
          userId: allocation.userId,
          invitationId: null,
          usagePackUsd: allocation.usagePackUsd,
          stripePriceId: priceIdForManagedUsagePack(allocation.usagePackUsd),
        };
      }),
    });
    if (seeded.action !== "seeded") {
      throw new Error("Failed to seed managed usage pack");
    }
    const managedFixture: ManagedUsagePackFixture = {
      ...fixture,
      customerId,
      subscriptionId,
      usagePackSubscriptionId: seeded.usagePackSubscriptionId,
      billingPeriod,
      tier,
    };
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: seeded.usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
    authenticateOrg(fixture);
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    const quantities = new Map<string, number>();
    for (const allocation of allocations) {
      const priceId = priceIdForManagedUsagePack(allocation.usagePackUsd);
      quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
    }
    const subscription = managedUsagePackSubscription(
      managedFixture,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(managedFixture, {
        invoiceId: `in_${randomUUID()}`,
        quantities,
      }),
    );
    return managedFixture;
  }

  function priceIdForManagedUsagePack(
    usagePackUsd: 20 | 50 | 100 | 200,
  ): string {
    switch (usagePackUsd) {
      case 20: {
        return TEST_PRICE_USAGE_PACK_20;
      }
      case 50: {
        return TEST_PRICE_USAGE_PACK_50;
      }
      case 100: {
        return TEST_PRICE_USAGE_PACK_100;
      }
      case 200: {
        return TEST_PRICE_USAGE_PACK_200;
      }
    }
  }

  function mockUsagePackChangePreviews(
    immediateAmountCents: number,
    nextRecurringAmountCents: number,
  ): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      if (
        "preview_mode" in input &&
        input.preview_mode === "recurring" &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        ("proration_behavior" in input.subscription_details ||
          "proration_date" in input.subscription_details)
      ) {
        throw new Error("Recurring previews cannot include prorations");
      }
      return Promise.resolve({
        amount_due:
          "preview_mode" in input && input.preview_mode === "next"
            ? immediateAmountCents
            : nextRecurringAmountCents,
        currency: "usd",
      });
    });
  }

  function mockUsagePackSubscriptionChangePreviews(
    immediateAmountCents: number,
    recurringPlanAmountCents: number,
  ): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      const previewMode =
        "preview_mode" in input ? input.preview_mode : undefined;
      if (previewMode !== "next" && previewMode !== "recurring") {
        throw new Error("Expected a Stripe invoice preview mode");
      }
      const subscriptionDetails =
        "subscription_details" in input
          ? input.subscription_details
          : undefined;
      if (
        previewMode === "recurring" &&
        typeof subscriptionDetails === "object" &&
        subscriptionDetails !== null &&
        ("proration_behavior" in subscriptionDetails ||
          "proration_date" in subscriptionDetails)
      ) {
        throw new Error("Recurring previews cannot include prorations");
      }
      const prorationTimestamp =
        typeof subscriptionDetails === "object" &&
        subscriptionDetails !== null &&
        "proration_date" in subscriptionDetails &&
        typeof subscriptionDetails.proration_date === "number"
          ? subscriptionDetails.proration_date
          : undefined;
      if (previewMode === "next" && prorationTimestamp === undefined) {
        throw new Error("Expected a plan proration timestamp");
      }
      const line = (args: {
        readonly id: string;
        readonly amount: number;
        readonly priceId: string;
        readonly proration: boolean;
      }) => {
        return {
          id: args.id,
          amount: args.amount,
          pricing: { price_details: { price: args.priceId } },
          parent: {
            subscription_item_details: { proration: args.proration },
          },
          period: { start: prorationTimestamp ?? 0 },
        };
      };
      const lines =
        previewMode === "next"
          ? [
              line({
                id: "il_plan_credit",
                amount: -recurringPlanAmountCents / 2,
                priceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
                proration: true,
              }),
              line({
                id: "il_plan_charge",
                amount: immediateAmountCents + recurringPlanAmountCents / 2,
                priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                proration: true,
              }),
              line({
                id: "il_existing_package",
                amount: 2000,
                priceId: TEST_PRICE_USAGE_PACK_20,
                proration: false,
              }),
            ]
          : [
              line({
                id: "il_team_plan",
                amount: recurringPlanAmountCents,
                priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                proration: false,
              }),
              line({
                id: "il_existing_package",
                amount: 2000,
                priceId: TEST_PRICE_USAGE_PACK_20,
                proration: false,
              }),
            ];
      return Promise.resolve({
        amount_due:
          previewMode === "next"
            ? immediateAmountCents + 2000
            : recurringPlanAmountCents + 2000,
        currency: "usd",
        lines: { data: lines },
      });
    });
  }

  function mockUsagePackSubscriptionPackagePreviews(args: {
    readonly immediateAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly sourcePriceId: string;
    readonly targetPriceId: string;
    readonly rejectScheduledSubscriptionRecurringPreview?: boolean;
  }): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      const previewMode =
        "preview_mode" in input ? input.preview_mode : undefined;
      const subscriptionDetails =
        "subscription_details" in input
          ? input.subscription_details
          : undefined;
      if (previewMode === "recurring") {
        if (
          args.rejectScheduledSubscriptionRecurringPreview &&
          "subscription" in input
        ) {
          throw new Error(
            "Recurring estimates do not support subscription schedules",
          );
        }
        if (
          typeof subscriptionDetails === "object" &&
          subscriptionDetails !== null &&
          ("proration_behavior" in subscriptionDetails ||
            "proration_date" in subscriptionDetails)
        ) {
          throw new Error("Recurring previews cannot include prorations");
        }
        return Promise.resolve({
          amount_due: args.nextRecurringAmountCents,
          currency: "usd",
          lines: { data: [] },
        });
      }
      if (
        previewMode !== "next" ||
        typeof subscriptionDetails !== "object" ||
        subscriptionDetails === null ||
        !("proration_date" in subscriptionDetails) ||
        typeof subscriptionDetails.proration_date !== "number"
      ) {
        throw new Error("Expected an immediate Stripe preview");
      }
      const line = (priceId: string, amount: number) => {
        return {
          id: `il_${randomUUID()}`,
          amount,
          pricing: { price_details: { price: priceId } },
          parent: { subscription_item_details: { proration: true } },
          period: { start: subscriptionDetails.proration_date },
        };
      };
      return Promise.resolve({
        amount_due: args.immediateAmountCents,
        currency: "usd",
        lines: {
          data: [
            line(args.sourcePriceId, -1000),
            line(args.targetPriceId, args.immediateAmountCents + 1000),
          ],
        },
      });
    });
  }

  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setZeroPrice();
    setUsagePackPrices();
    mockUsagePackCatalog();
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_usage_pack_change");
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  });

  it("previews a Team upgrade by replacing only the base plan item", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const subscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackManagementContract,
      ).previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "pro",
        targetTier: "team",
        immediateAmountCents: 8000,
        nextRecurringAmountCents: 18_000,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    for (const [input] of context.mocks.stripe.invoices.createPreview.mock
      .calls) {
      expect(input).toStrictEqual(
        expect.objectContaining({
          subscription: fixture.subscriptionId,
          subscription_details: expect.objectContaining({
            items: [
              {
                id: "si_usage_pack_plan",
                price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                quantity: 1,
              },
            ],
          }),
        }),
      );
    }
  });

  it("replaces an unconfirmed package change preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const body = {
      targetTier: "pro" as const,
      memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 as const }],
    };

    const first = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );
    const second = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );

    expect(second.body.changeId).not.toBe(first.body.changeId);
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      4,
    );
  });

  it("upgrades the base plan in place without replacing the member package", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const proSubscription = managedUsagePackSubscription(fixture, quantities);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      proSubscription,
    );
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const grantsBefore = (
      await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
    ).grants;
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      targetPriceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      prorationTimestamp: Math.floor(
        new Date(preview.body.prorationDate).getTime() / 1000,
      ),
    });
    const teamSubscription = {
      ...proSubscription,
      latest_invoice: invoice,
      items: {
        data: proSubscription.items.data.map((item) => {
          return item.price.id === TEST_PRICE_USAGE_PACK_PLAN_PRO
            ? {
                ...item,
                price: {
                  ...item.price,
                  id: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                },
              }
            : item;
        }),
      },
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(proSubscription)
      .mockResolvedValue(teamSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      teamSubscription,
    );

    const response = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "processing",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [
          {
            id: "si_usage_pack_plan",
            price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
            quantity: 1,
          },
        ],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: Math.floor(
          new Date(preview.body.prorationDate).getTime() / 1000,
        ),
        expand: ["latest_invoice.payment_intent"],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          "usage-pack-subscription-change:",
        ),
      }),
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    await postManagedUsagePackEvent("invoice.paid", invoice);
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.org?.tier).toBe("team");
    expect(state.allocations).toHaveLength(1);
    expect(state.allocations[0]).toStrictEqual(
      expect.objectContaining({
        usagePackUsd: 20,
        stripePriceId: TEST_PRICE_USAGE_PACK_20,
      }),
    );
    expect(state.grants).toStrictEqual(grantsBefore);
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.tier).toBe("team");
  });

  it("activates a pending plan upgrade from the paid invoice webhook", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const proSubscription = managedUsagePackSubscription(fixture, quantities);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      proSubscription,
    );
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      targetPriceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      prorationTimestamp,
    });
    const pendingSubscription = {
      ...proSubscription,
      pending_update: { expires_at: prorationTimestamp + 60 },
      latest_invoice: { ...paidInvoice, status: "open" },
    };
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      pendingSubscription,
    );
    const grantsBefore = (
      await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
    ).grants;

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: null,
    });
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      pendingSubscription,
    );
    const pendingState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(pendingState.org?.tier).toBe("pro");

    const teamSubscription = {
      ...proSubscription,
      latest_invoice: paidInvoice,
      items: {
        data: proSubscription.items.data.map((item) => {
          return item.price.id === TEST_PRICE_USAGE_PACK_PLAN_PRO
            ? {
                ...item,
                price: {
                  ...item.price,
                  id: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                },
              }
            : item;
        }),
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      teamSubscription,
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const completedState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(completedState.org?.tier).toBe("team");
    expect(completedState.allocations).toHaveLength(1);
    expect(completedState.grants).toStrictEqual(grantsBefore);
  });

  it("updates a member package through the combined subscription change", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "pro",
        targetTier: "pro",
        immediateAmountCents: 1500,
        nextRecurringAmountCents: 5000,
      }),
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoiceId = `in_${randomUUID()}`;
    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    const upgradedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(upgradedSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...oldSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: { ...paidInvoice, status: "open" },
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({
        items: expect.arrayContaining([
          { id: `si_${TEST_PRICE_USAGE_PACK_20}`, deleted: true },
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
        ]),
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:apply`,
      },
    );

    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(state.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          originalAmount: 15_000,
        }),
        expect.objectContaining({
          grantType: "bonus",
          originalAmount: 1100,
        }),
      ]),
    );
    expect(state.grants).toHaveLength(4);
  });

  it("restores a scheduled package downgrade", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const scheduleId = "sub_sched_usage_pack_restore";
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const downgrade = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );
    expect(downgrade.body.status).toBe("scheduled");

    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    context.mocks.stripe.invoices.createPreview.mockClear();
    const restorePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    expect(restorePreview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "pro",
        targetTier: "pro",
        immediateAmountCents: 0,
        nextRecurringAmountCents: 5000,
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      customer: fixture.customerId,
      preview_mode: "recurring",
      subscription_details: {
        items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
        ],
      },
    });

    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });
    const restored = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: restorePreview.body.changeId },
      }),
      [200],
    );
    expect(restored.body).toStrictEqual({
      status: "completed",
      effectiveAt: expect.any(String),
      hostedInvoiceUrl: null,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 50, status: "active" }),
    ]);
    expect(state.changes).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 50,
        targetUsagePackUsd: 20,
      }),
    ]);
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations[0]?.pendingChange).toBeNull();
  });

  it("expires an unpaid pending subscription update", async () => {
    const initialNow = new Date("2035-02-16T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    const invoiceId = `in_${randomUUID()}`;
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const openInvoice = {
      ...managedUsagePackUpgradeInvoice(fixture, {
        invoiceId,
        sourcePriceId: TEST_PRICE_USAGE_PACK_20,
        targetPriceId: TEST_PRICE_USAGE_PACK_50,
        prorationTimestamp,
      }),
      status: "open",
      paid: false,
    };
    const pendingSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      fixture.billingPeriod,
      {
        latestInvoice: openInvoice,
        pendingUpdateExpiresAt: prorationTimestamp + 300,
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      pendingSubscription,
    );

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: null,
    });

    mockNow(new Date(initialNow.getTime() + 25 * 60 * 60 * 1000));
    const expiredSubscription = {
      ...sourceSubscription,
      latest_invoice: openInvoice,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      expiredSubscription,
    );
    mockEnv("CRON_SECRET", "usage-pack-change-cron");
    const cronResponse = await createApp({
      signal: context.signal,
      routes: cronReconcileBillingEntitlementsRoutes,
    }).request("/api/cron/reconcile-billing-entitlements", {
      headers: { authorization: "Bearer usage-pack-change-cron" },
    });
    expect(cronResponse.status).toBe(200);
    expect(context.mocks.stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      invoiceId,
      {},
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:void`,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({ proration_behavior: "none" }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:rollback`,
      },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.org?.tier).toBe("pro");
    expect(state.changes).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 20,
        targetUsagePackUsd: 50,
      }),
    ]);
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 20, status: "active" }),
    ]);
    expect(state.grants).toHaveLength(2);
  });

  it("schedules a Team to Pro subscription change at the billing boundary", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 20 }],
      "team",
    );
    const subscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    mockUsagePackSubscriptionChangePreviews(0, 0);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_team_to_pro",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: "sub_sched_team_to_pro",
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "team",
        targetTier: "pro",
        immediateAmountCents: 0,
        nextRecurringAmountCents: 2000,
        effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      }),
    );

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      status: "scheduled",
      effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      "sub_sched_team_to_pro",
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({
                price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              }),
              expect.objectContaining({ price: TEST_PRICE_USAGE_PACK_20 }),
            ]),
          }),
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:schedule-update`,
      },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.org?.tier).toBe("team");
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 20, status: "active" }),
    ]);
  });

  it("serializes concurrent package previews across an organization", async () => {
    const firstUserId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: firstUserId, usagePackUsd: 20 },
      { userId: secondUserId, usagePackUsd: 20 },
    ]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    mockUsagePackChangePreviews(1500, 7000);
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );

    const responses = await Promise.all(
      [firstUserId, secondUserId].map((memberId) => {
        return client.previewChange({
          headers: { authorization: "Bearer clerk-session" },
          body: { memberId, targetUsagePackUsd: 50 },
        });
      }),
    );
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual(expect.arrayContaining([200, 409]));
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes).toHaveLength(1);
    expect(state.changes[0]?.status).toBe("previewed");
  });

  it("applies a paid upgrade once with the preview proration date while the switch is off", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const sourceUserId =
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .allocations[0]?.userId ?? "";
    const oldQuantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const newQuantities = new Map([[TEST_PRICE_USAGE_PACK_50, 1]]);
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      oldQuantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: sourceUserId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const pendingInvoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...oldSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: {
        id: pendingInvoiceId,
        status: "open",
        hosted_invoice_url: `https://invoice.stripe.test/${pendingInvoiceId}`,
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    const duplicateConfirmation = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(duplicateConfirmation.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      }),
      { idempotencyKey: `usage-pack-change:${preview.body.changeId}:apply` },
    );
    const beforePayment = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      beforePayment.allocations.filter((allocation) => {
        return allocation.status === "active";
      }),
    ).toHaveLength(1);
    expect(beforePayment.allocations[0]?.usagePackUsd).toBe(20);
    expect(beforePayment.grants).toHaveLength(2);

    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: false,
    });
    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: pendingInvoiceId,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, newQuantities),
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const upgraded = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(upgraded.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(upgraded.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          originalAmount: 15_000,
        }),
        expect.objectContaining({
          grantType: "bonus",
          originalAmount: 1100,
        }),
      ]),
    );
    expect(upgraded.grants).toHaveLength(4);
    expect(upgraded.fulfillmentInvoiceIds).toHaveLength(2);
    expect(upgraded.changes).toStrictEqual([
      expect.objectContaining({
        id: preview.body.changeId,
        status: "completed",
        stripeInvoiceId: pendingInvoiceId,
      }),
    ]);

    const disabled = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: sourceUserId, targetUsagePackUsd: 100 },
      }),
      [403],
    );
    expect(disabled.body.error.message).toBe(
      "Usage pack management is not enabled",
    );
  });

  it("completes an immediately paid upgrade during confirmation", async () => {
    mockNow(new Date("2035-01-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    const upgradedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      fixture.billingPeriod,
      { latestInvoice: invoice },
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(upgradedSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      upgradedSubscription,
    );

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("completed");
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes[0]?.status).toBe("completed");
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(state.grants).toHaveLength(4);
  });

  it("expires a failed pending upgrade without changing allocation or credits", async () => {
    const initialNow = new Date("2035-02-16T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const subscription = managedUsagePackSubscription(fixture, quantities);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...subscription,
      pending_update: { expires_at: prorationTimestamp + 60 },
      latest_invoice: `in_${randomUUID()}`,
    });
    await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    mockNow(new Date(initialNow.getTime() + 10 * 60 * 1000));
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, quantities),
    );
    mockEnv("CRON_SECRET", "usage-pack-change-cron");
    const cronResponse = await createApp({
      signal: context.signal,
      routes: cronReconcileBillingEntitlementsRoutes,
    }).request("/api/cron/reconcile-billing-entitlements", {
      headers: { authorization: "Bearer usage-pack-change-cron" },
    });
    expect(cronResponse.status).toBe(200);

    const failed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(failed.changes[0]?.status).toBe("failed");
    expect(failed.allocations).toHaveLength(1);
    expect(failed.allocations[0]).toStrictEqual(
      expect.objectContaining({ usagePackUsd: 20, status: "active" }),
    );
    expect(failed.grants).toHaveLength(2);
  });

  it("keeps a downgrade scheduled until the boundary and renews aggregate quantities", async () => {
    mockNow(new Date("2035-03-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId, usagePackUsd: 50 },
      { userId: secondUserId, usagePackUsd: 20 },
    ]);
    const currentQuantities = new Map([
      [TEST_PRICE_USAGE_PACK_50, 1],
      [TEST_PRICE_USAGE_PACK_20, 1],
    ]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      currentQuantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackChangePreviews(0, 4000);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_usage_pack_downgrade",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: "sub_sched_usage_pack_downgrade",
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      "sub_sched_usage_pack_downgrade",
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 2 },
            ]),
          }),
        ]),
      }),
      {
        idempotencyKey: `usage-pack-change:${preview.body.changeId}:schedule-update`,
      },
    );
    const scheduled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(scheduled.changes[0]?.status).toBe("scheduled");
    expect(
      scheduled.allocations.find((allocation) => {
        return allocation.userId === userId && allocation.status === "active";
      })?.usagePackUsd,
    ).toBe(50);
    expect(scheduled.grants).toHaveLength(4);

    const nextPeriod = {
      start: fixture.billingPeriod.end,
      end: fixture.billingPeriod.end + 30 * 86_400,
    };
    const boundarySubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      nextPeriod,
      { scheduleId: "sub_sched_usage_pack_downgrade" },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      boundarySubscription,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: "sub_sched_usage_pack_downgrade",
      end_behavior: "release",
      current_phase: {
        start_date: nextPeriod.start,
        end_date: nextPeriod.end,
      },
      phases: [],
    });
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      boundarySubscription,
    );
    const completed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(completed.changes[0]?.status).toBe("completed");
    expect(
      completed.allocations.filter((allocation) => {
        return allocation.status === "active";
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId, usagePackUsd: 20 }),
        expect.objectContaining({ userId: secondUserId, usagePackUsd: 20 }),
      ]),
    );
    expect(completed.grants).toHaveLength(4);
  });

  it("retries a deferred change when the Stripe schedule update fails", async () => {
    const initialNow = new Date("2035-04-01T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_50, 1]]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackChangePreviews(0, 2000);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_usage_pack_retry",
    });
    context.mocks.stripe.subscriptionSchedules.update
      .mockRejectedValueOnce(new Error("temporary Stripe failure"))
      .mockResolvedValue({ id: "sub_sched_usage_pack_retry" });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [500],
    );
    const applying = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(applying.changes[0]?.status).toBe("applying");

    mockNow(new Date(initialNow.getTime() + 10 * 60 * 1000));
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, quantities, fixture.billingPeriod, {
        scheduleId: "sub_sched_usage_pack_retry",
      }),
    );
    mockEnv("CRON_SECRET", "usage-pack-change-cron");
    const cronResponse = await createApp({
      signal: context.signal,
      routes: cronReconcileBillingEntitlementsRoutes,
    }).request("/api/cron/reconcile-billing-entitlements", {
      headers: { authorization: "Bearer usage-pack-change-cron" },
    });
    expect(cronResponse.status).toBe(200);

    const scheduled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(scheduled.changes[0]?.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledTimes(2);
  });

  it("makes removed-member credits unusable and schedules its quantity removal", async () => {
    mockNow(new Date("2035-04-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
      { userId: targetUserId, usagePackUsd: 50 },
    ]);
    const adminUserId =
      (
        await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
      ).allocations.find((allocation) => {
        return allocation.userId !== targetUserId;
      })?.userId ?? "";
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.orgId, userId: adminUserId },
      { [FeatureSwitchKey.UsagePackPlans]: false },
    );
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: targetUserId }],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          { publicUserData: { userId: adminUserId } },
          { publicUserData: { userId: targetUserId } },
        ],
      },
    );
    const deletionStarted = createDeferredPromise<void>(context.signal);
    const deletionGate = createDeferredPromise<void>(context.signal);
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockImplementation(
      async () => {
        deletionStarted.resolve(undefined);
        await deletionGate.promise;
        return {};
      },
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_20, 1],
        [TEST_PRICE_USAGE_PACK_50, 1],
      ]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_usage_pack_removal",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: "sub_sched_usage_pack_removal",
    });

    const responsePromise = setupApp({ context, routes: zeroOrgMembersRoutes })(
      zeroOrgMembersContract,
    ).removeMember({
      headers: { authorization: "Bearer clerk-session" },
      body: { email: targetEmail },
    });
    await deletionStarted.promise;
    const reserved = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(reserved.changes).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        kind: "removal",
        status: "previewed",
      }),
    );
    expect(
      reserved.remainingCredits.find((credits) => {
        return credits.userId === targetUserId;
      })?.amount,
    ).toBeGreaterThan(0);
    deletionGate.resolve(undefined);

    const response = await accept(responsePromise, [200]);
    expect(response.body.message).toBe(`Removed ${targetEmail} from org`);
    const removed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(removed.remainingCredits).toContainEqual({
      userId: targetUserId,
      amount: 0,
    });
    expect(removed.changes).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        kind: "removal",
        status: "scheduled",
      }),
    );
    expect(
      removed.allocations.find((allocation) => {
        return allocation.userId === targetUserId;
      })?.status,
    ).toBe("active");
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      "sub_sched_usage_pack_removal",
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("uses normal cancellation when a removed member owns the last package", async () => {
    mockNow(new Date("2035-04-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await seedManagedUsagePack([
      { userId: targetUserId, usagePackUsd: 20 },
    ]);
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: false,
    });
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: targetUserId }],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          { publicUserData: { userId: fixture.userId } },
          { publicUserData: { userId: targetUserId } },
        ],
      },
    );
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.subscriptionSchedules.create.mockClear();

    await accept(
      setupApp({ context, routes: zeroOrgMembersRoutes })(
        zeroOrgMembersContract,
      ).removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: targetEmail },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      { cancel_at_period_end: true },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.remainingCredits).toContainEqual({
      userId: targetUserId,
      amount: 0,
    });
    expect(state.changes[0]).toStrictEqual(
      expect.objectContaining({ kind: "removal", status: "scheduled" }),
    );
    expect(state.subscription?.cancelAtPeriodEnd).toBeTruthy();
    expect(state.org?.cancelAtPeriodEnd).toBeTruthy();
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

  it("finds the plan item in a completed multi-item subscription", async () => {
    setUsagePackPrices();
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
            price: { id: TEST_PRICE_USAGE_PACK_20 },
            current_period_end: 1_800_000_000,
          },
          {
            price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: false });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("limited-free-1");
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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: false });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("limited-free-1");
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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingCheckoutContract,
    );

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

  async function trackedSeed(
    tier: OrgTier = "team",
  ): Promise<{ orgId: string; userId: string }> {
    const fixture = createOrgFixture();
    await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
    return fixture;
  }

  it("creates concurrency subscription checkout with the requested quantity", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/concurrency",
    });

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencyCheckoutRoutes,
    })(zeroBillingConcurrencyCheckoutContract);

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

  it("opens Stripe's hosted confirmation for additional slots", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd,
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      customer: fixture.customerId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
          },
        ],
      },
    });
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValueOnce({
      url: "https://billing.stripe.test/concurrency-update",
    });

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencyCheckoutRoutes,
    })(zeroBillingConcurrencyCheckoutContract);
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const cancelUrl = `${APP_ORIGIN}/billing?concurrency=canceled`;
    const response = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.test/concurrency-update",
    });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: fixture.customerId,
      configuration: TEST_CONCURRENCY_PORTAL_CONFIGURATION,
      return_url: cancelUrl,
      flow_data: {
        type: "subscription_update_confirm",
        after_completion: {
          type: "redirect",
          redirect: { return_url: successUrl },
        },
        subscription_update_confirm: {
          subscription: subscriptionId,
          items: [{ id: subscriptionItemId, quantity: 5 }],
        },
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);
  });

  it("opens Stripe's hosted confirmation for a lower slot quantity", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      customer: fixture.customerId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 5,
          },
        ],
      },
    });
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValueOnce({
      url: "https://billing.stripe.test/concurrency-reduction",
    });

    const statusBefore = await readBillingStatus(fixture);
    expect(statusBefore.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: subscriptionId,
        quantity: 5,
        canReduce: true,
      }),
    ]);

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);
    const successUrl = `${APP_ORIGIN}/?concurrency=reduced`;
    const cancelUrl = `${APP_ORIGIN}/billing?concurrency=canceled`;
    const response = await accept(
      client.reduce({
        params: { subscriptionId },
        body: { quantity: 3, successUrl, cancelUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.test/concurrency-reduction",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: fixture.customerId,
      configuration: TEST_CONCURRENCY_PORTAL_CONFIGURATION,
      return_url: cancelUrl,
      flow_data: {
        type: "subscription_update_confirm",
        after_completion: {
          type: "redirect",
          redirect: { return_url: successUrl },
        },
        subscription_update_confirm: {
          subscription: subscriptionId,
          items: [{ id: subscriptionItemId, quantity: 3 }],
        },
      },
    });
    const statusAfter = await readBillingStatus(fixture);
    expect(statusAfter.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 5 }),
    ]);
  });

  it("rejects a concurrency quantity that is not a reduction", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 3,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencySubscriptionRoutes,
      })(zeroBillingConcurrencySubscriptionContract).reduce({
        params: { subscriptionId },
        body: {
          quantity: 3,
          successUrl: `${APP_ORIGIN}/?concurrency=reduced`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "New concurrency quantity must be lower than the current quantity",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("returns 400 when the concurrency portal configuration is missing", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID", undefined);

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).create({
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
        message: "Concurrency billing portal configuration is not configured",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("reuses a pending prorated invoice instead of creating another update", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      latest_invoice: {
        hosted_invoice_url: "https://invoice.stripe.test/pending-concurrency",
      },
      pending_update: { expires_at: 4_102_444_800 },
      items: { data: [] },
    });

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://invoice.stripe.test/pending-concurrency",
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("requires restoring a canceling concurrency subscription before adding slots", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: subscriptionId,
    });
    await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencySubscriptionRoutes,
      })(zeroBillingConcurrencySubscriptionContract).cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.update.mockClear();

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).create({
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
        message:
          "Restore the existing concurrency subscription before buying more slots",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("uses the live Stripe quantity for proration invoices", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd,
      tier: "team",
    });
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: fixture.customerId,
          metadata: { purpose: "concurrency_subscription" },
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { purpose: "concurrency_subscription" },
            },
          },
          lines: {
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                amount: -20_000,
                quantity: 2,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEndUnix - 15 * 86_400,
                  end: periodEndUnix,
                },
              },
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                amount: 50_000,
                quantity: 5,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEndUnix - 15 * 86_400,
                  end: periodEndUnix,
                },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      status: "active",
      customer: fixture.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          {
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 4,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);

    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 4 }),
    ]);
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

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencyCheckoutRoutes,
    })(zeroBillingConcurrencyCheckoutContract);

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

  it("rejects concurrency checkout for Pro workspaces", async () => {
    const fixture = await trackedSeed("pro");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencyCheckoutRoutes,
    })(zeroBillingConcurrencyCheckoutContract);
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
        message:
          "Additional concurrency is only available for Team or Custom workspaces",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when concurrency price is not configured", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("ZERO_PRICE_CONCURRENCY", undefined);

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencyCheckoutRoutes,
    })(zeroBillingConcurrencyCheckoutContract);

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

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);

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
    expect(status.concurrencySubscriptions).toStrictEqual(
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

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);

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
    expect(status.concurrencySubscriptions).toStrictEqual(
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

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);

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

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);

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
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      discount: null,
    });
  });

  function trackedSeed(): { orgId: string; userId: string } {
    return createOrgFixture();
  }

  it("returns 403 for non-admin org member", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({
      context,
      routes: zeroBillingCreditCheckoutRoutes,
    })(zeroBillingCreditCheckoutContract);

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

    const client = setupApp({
      context,
      routes: zeroBillingCreditCheckoutRoutes,
    })(zeroBillingCreditCheckoutContract);

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

  it("allows promotion codes when the customer has no discount", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/credit",
    });

    const client = setupApp({
      context,
      routes: zeroBillingCreditCheckoutRoutes,
    })(zeroBillingCreditCheckoutContract);

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
        line_items: [{ price: TEST_PRICE_CUSTOM_CREDIT_UNIT, quantity: 20 }],
        allow_promotion_codes: true,
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
  });

  it("automatically applies the customer's coupon", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const { customerId } = fixture;
    const couponId = `coupon_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      discount: {
        source: {
          type: "coupon",
          coupon: couponId,
        },
      },
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/discounted-credit",
    });

    const response = await accept(
      setupApp({ context, routes: zeroBillingCreditCheckoutRoutes })(
        zeroBillingCreditCheckoutContract,
      ).create({
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
      url: "https://checkout.stripe.com/session/discounted-credit",
    });
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledWith(
      customerId,
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: TEST_PRICE_CUSTOM_CREDIT_UNIT, quantity: 20 }],
        discounts: [{ coupon: couponId }],
      }),
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        allow_promotion_codes: true,
      }),
    );
  });

  it("rejects credit checkout when the plan capability is disabled", async () => {
    const fixture = await trackedSeed();
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      setupApp({ context, routes: zeroBillingCreditCheckoutRoutes })(
        zeroBillingCreditCheckoutContract,
      ).create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "Credit purchases are not available for this workspace",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
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
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/zero-credit",
    });
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:write"],
    });

    const client = setupApp({
      context,
      routes: zeroBillingCreditCheckoutRoutes,
    })(zeroBillingCreditCheckoutContract);

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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/custom-credit",
    });

    const client = setupApp({
      context,
      routes: zeroBillingCreditCheckoutRoutes,
    })(zeroBillingCreditCheckoutContract);

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
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: TEST_PRICE_CUSTOM_CREDIT_UNIT, quantity: 150 }],
        allow_promotion_codes: true,
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
    mockEnv("ZERO_PRICE_CUSTOM_CREDIT_UNIT", undefined);

    const client = setupApp({
      context,
      routes: zeroBillingCreditCheckoutRoutes,
    })(zeroBillingCreditCheckoutContract);

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
