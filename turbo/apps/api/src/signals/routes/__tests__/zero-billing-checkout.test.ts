import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { testBillingReconciliationStateContract } from "@vm0/api-contracts/contracts/test-billing-reconciliation-state";
import {
  type BillingStatusResponse,
  USAGE_PACKS_USD,
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingUsagePackCreditsContract,
  zeroBillingUsagePackManagementContract,
  zeroBillingUsagePackMigrationContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingStatusContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isStaffOrg } from "@vm0/core/staff-org";
import {
  webhookClerkContract,
  webhookStripeContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import type StripeSDK from "stripe";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  seedOrgMetadata,
  setOnboardingPaymentPendingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { readOrgAcquisitionAttributionFixture } from "../../../test-fixtures/org-metadata";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { testBillingReconciliationStateRoutes } from "../test-billing-reconciliation-state";
import { zeroBillingCheckoutRoutes } from "../zero-billing-checkout";
import { zeroBillingConcurrencyCheckoutRoutes } from "../zero-billing-concurrency-checkout";
import { zeroBillingConcurrencySubscriptionRoutes } from "../zero-billing-concurrency-subscriptions";
import { zeroBillingCreditCheckoutRoutes } from "../zero-billing-credit-checkout";
import { zeroBillingUsagePackCreditsRoutes } from "../zero-billing-usage-pack-credits";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroOrgMembersRoutes } from "../zero-org-members";
import { zeroOrgInviteRoutes } from "../zero-org-invite";
import { zeroOrgReadRoutes } from "../zero-org-read";
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

async function reconcileBillingOrganization(orgId: string): Promise<void> {
  await accept(
    setupApp({
      context,
      routes: testBillingReconciliationStateRoutes,
    })(testBillingReconciliationStateContract).reconcile({
      body: { orgIds: [orgId] },
    }),
    [200],
  );
}

const APP_ORIGIN = "http://localhost:3002";
// This unshared test tenant collides with the staff-org identity hash so the
// route exercises the real authorization gate without mutating shared staff
// billing state used by other integration files.
const TEST_STAFF_ORG_ID = "org_usage_pack_checkout_test_lgD7Q3";
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
    createdAt: now(),
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
          has_more: false,
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
          has_more: false,
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

async function createMergedConcurrencySubscriptionOrg(args: {
  readonly slots: number;
  readonly periodEnd: Date;
}): Promise<
  SubscriptionFixture & {
    readonly concurrencyItemId: string;
    readonly planCredits: number;
  }
> {
  context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
    data: [],
    has_more: false,
  });
  const fixture = await createSubscriptionOrg({
    tier: "team",
    periodEndUnix: Math.floor(args.periodEnd.getTime() / 1000),
  });
  const planCredits = (await readBillingStatus(fixture)).credits;
  const concurrencyItemId = `si_${randomUUID()}`;
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: fixture.subscriptionId,
    status: "active",
    customer: fixture.customerId,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      data: [
        {
          id: `si_${TEST_PRICE_TEAM}`,
          price: { id: TEST_PRICE_TEAM },
          quantity: 1,
          current_period_end: Math.floor(args.periodEnd.getTime() / 1000),
        },
        {
          id: concurrencyItemId,
          price: { id: TEST_PRICE_CONCURRENCY },
          quantity: args.slots,
          current_period_end: Math.floor(args.periodEnd.getTime() / 1000),
        },
      ],
    },
  });
  const event = {
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${randomUUID()}`,
        customer: fixture.customerId,
        metadata: {},
        parent: {
          subscription_details: {
            subscription: fixture.subscriptionId,
            metadata: {},
          },
        },
        lines: {
          data: [
            {
              id: `il_${randomUUID()}`,
              quantity: args.slots,
              price: { id: TEST_PRICE_CONCURRENCY },
              parent: { type: "subscription_item_details" },
              period: {
                start: currentSecond(),
                end: Math.floor(args.periodEnd.getTime() / 1000),
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
  return { ...fixture, concurrencyItemId, planCredits };
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
    const okouPricePro = "price_okou_pro";
    mockEnv("OKOU_PRICE_PRO", okouPricePro);
    mockEnv("ZERO_PRICE_PRO", "price_ignored_zero_pro");
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
      line_items: [{ price: okouPricePro, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/billing?billing=success`,
      cancel_url: `${APP_ORIGIN}/billing?billing=canceled`,
      metadata: {
        orgId: fixture.orgId,
        tier: "pro",
        priceId: okouPricePro,
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: okouPricePro,
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
            source_type: "paid",
            vm0_source: "presentation",
            vm0_campaign_id: "1234567890",
            vm0_ad_group_id: "9876543210",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "presentation_search_en",
            utm_content: "hero",
            utm_term: "ai",
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
      source_type: "paid",
      vm0_source: "presentation",
      vm0_campaign_id: "1234567890",
      vm0_ad_group_id: "9876543210",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "presentation_search_en",
      utm_content: "hero",
      utm_term: "ai",
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

    await expect(
      readOrgAcquisitionAttributionFixture(fixture.orgId),
    ).resolves.toMatchObject({
      acquisitionSourceType: "paid",
      acquisitionVm0Source: "presentation",
      acquisitionCampaignId: "1234567890",
      acquisitionAdGroupId: "9876543210",
      acquisitionCampaign: "presentation_search_en",
      acquisitionUtmSource: "google",
      acquisitionUtmMedium: "cpc",
      acquisitionUtmContent: "hero",
      acquisitionUtmTerm: "ai",
      acquisitionGclid: "test-gclid",
      acquisitionRecordedAt: expect.any(Date),
    });
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

describe("legacy subscription usage pack migration", () => {
  interface LegacyMigrationFixture extends SubscriptionFixture {
    readonly tier: "pro" | "team";
    readonly legacyPriceId: string;
    readonly legacyItemId: string;
    readonly period: { readonly start: number; readonly end: number };
    readonly legacyCreditInvoiceId: string;
    readonly invitation?: {
      readonly id: string;
      readonly email: string;
      readonly role: "org:admin" | "org:member";
    };
  }

  interface MigrationStripeController {
    readonly invoice: () => object;
    readonly cancelSubscription: () => MigrationSubscriptionMock;
    readonly cancelSchedule: () => void;
    readonly startScheduledPhase: () => void;
  }

  interface MigrationSubscriptionMock {
    readonly id: string;
    readonly customer: string;
    readonly status: string;
    readonly cancel_at: number | null;
    readonly cancel_at_period_end: boolean;
    readonly schedule: string | null;
    readonly pending_update: null;
    readonly latest_invoice: string | null;
    readonly metadata: Readonly<Record<string, string>>;
    readonly items: {
      readonly data: readonly {
        readonly id: string;
        readonly price: {
          readonly id: string;
          readonly recurring: {
            readonly interval: "month";
            readonly interval_count: 1;
          };
        };
        readonly quantity: number;
        readonly current_period_start: number;
        readonly current_period_end: number;
      }[];
    };
  }

  function isStringRecord(
    value: unknown,
  ): value is Readonly<Record<string, string>> {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every((entry) => {
        return typeof entry === "string";
      })
    );
  }

  function stringMetadata(
    value: unknown,
  ): Readonly<Record<string, string>> | null {
    if (typeof value !== "object" || value === null || !("metadata" in value)) {
      return null;
    }
    return isStringRecord(value.metadata) ? value.metadata : null;
  }

  function migrationPreviewItems(value: unknown): readonly unknown[] {
    if (
      typeof value !== "object" ||
      value === null ||
      !("subscription_details" in value)
    ) {
      throw new Error("Expected migration subscription preview details");
    }
    const details = value.subscription_details;
    if (
      typeof details !== "object" ||
      details === null ||
      !("items" in details) ||
      !Array.isArray(details.items)
    ) {
      throw new Error("Expected migration subscription preview items");
    }
    const items: readonly unknown[] = details.items;
    return items;
  }

  function migrationPreviewPriceIds(value: unknown): readonly string[] {
    return migrationPreviewItems(value).flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("price" in item) ||
        typeof item.price !== "string"
      ) {
        return [];
      }
      return [item.price];
    });
  }

  function paidMigrationTimestamp(): number | null {
    return currentSecond();
  }

  async function clearMigrationFixture(
    orgId = TEST_STAFF_ORG_ID,
  ): Promise<void> {
    await usagePackStateAction({
      action: "cleanup-migration",
      orgId,
    });
  }

  async function seedLegacyMigrationFixture(args: {
    readonly tier: "pro" | "team";
    readonly invitation?: boolean;
    readonly orgId?: string;
  }): Promise<LegacyMigrationFixture> {
    const orgId = args.orgId ?? TEST_STAFF_ORG_ID;
    await clearMigrationFixture(orgId);
    const fixture = createOrgFixture(orgId);
    const customerId = `cus_migration_${randomUUID()}`;
    const subscriptionId = `sub_migration_${randomUUID()}`;
    const legacyPriceId =
      args.tier === "team" ? TEST_PRICE_TEAM : TEST_PRICE_PRO;
    const legacyItemId = `si_legacy_${randomUUID()}`;
    const period = {
      start: currentSecond() - 15 * 86_400,
      end: currentSecond() + 15 * 86_400,
    };
    const legacyCreditInvoiceId = `in_legacy_${randomUUID()}`;
    const invitation = args.invitation
      ? {
          id: `inv_migration_${randomUUID()}`,
          email: `pending-${randomUUID()}@example.test`,
          role: "org:member" as const,
        }
      : undefined;
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: args.tier,
      credits: 12_345,
    });
    await usagePackStateAction({
      action: "seed-legacy-migration",
      orgId: fixture.orgId,
      tier: args.tier,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEnd: new Date(period.end * 1000).toISOString(),
      legacyCreditInvoiceId,
      credits: 12_345,
    });
    authenticateOrg(fixture);
    mockClerkOrganization(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: invitation
          ? [
              {
                id: invitation.id,
                emailAddress: invitation.email,
                role: invitation.role,
                createdAt: now(),
              },
            ]
          : [],
      },
    );
    onTestFinished(() => {
      return clearMigrationFixture(orgId);
    });
    return {
      ...fixture,
      customerId,
      subscriptionId,
      tier: args.tier,
      legacyPriceId,
      legacyItemId,
      period,
      legacyCreditInvoiceId,
      ...(invitation ? { invitation } : {}),
    };
  }

  function legacyMigrationSubscription(
    fixture: LegacyMigrationFixture,
  ): MigrationSubscriptionMock {
    return {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      pending_update: null,
      latest_invoice: null,
      metadata: { orgId: fixture.orgId },
      items: {
        data: [
          {
            id: fixture.legacyItemId,
            price: {
              id: fixture.legacyPriceId,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 1,
            current_period_start: fixture.period.start,
            current_period_end: fixture.period.end,
          },
        ],
      },
    };
  }

  function mockMigrationStripe(args: {
    readonly fixture: LegacyMigrationFixture;
    readonly targetTier?: "pro" | "team";
    readonly packageQuantity: number;
    readonly currentRecurringAmountCents: number;
    readonly amountDueCents: number;
    readonly amountPaidCents: number;
  }): MigrationStripeController {
    const targetTier = args.targetTier ?? args.fixture.tier;
    const planPriceId =
      targetTier === "team"
        ? TEST_PRICE_USAGE_PACK_PLAN_TEAM
        : TEST_PRICE_USAGE_PACK_PLAN_PRO;
    const invoiceId = `in_migration_${randomUUID()}`;
    const paymentIntentId = `pi_migration_${randomUUID()}`;
    const scheduleId = `sub_sched_migration_${randomUUID()}`;
    const packageLineAmount = 2000 * args.packageQuantity;
    const renewedPeriod = {
      start: args.fixture.period.end,
      end: args.fixture.period.end + 30 * 86_400,
    };
    const paidInvoice = () => {
      return {
        id: invoiceId,
        customer: args.fixture.customerId,
        metadata: { orgId: args.fixture.orgId },
        status: "paid",
        paid: true,
        amount_due: args.amountDueCents,
        amount_paid: args.amountPaidCents,
        currency: "usd",
        hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
        status_transitions: { paid_at: paidMigrationTimestamp() },
        payments: {
          data:
            args.amountPaidCents > 0
              ? [
                  {
                    status: "paid",
                    amount_paid: args.amountPaidCents,
                    payment: {
                      type: "payment_intent",
                      payment_intent: paymentIntentId,
                    },
                  },
                ]
              : [],
        },
        parent: {
          subscription_details: {
            subscription: args.fixture.subscriptionId,
            metadata: { orgId: args.fixture.orgId },
          },
        },
        lines: {
          data: [
            {
              id: `il_migration_plan_${randomUUID()}`,
              amount: Math.max(args.amountDueCents - packageLineAmount, 0),
              subtotal: Math.max(args.amountDueCents - packageLineAmount, 0),
              quantity: 1,
              price: { id: planPriceId },
              pricing: { price_details: { price: planPriceId } },
              proration: false,
              period: renewedPeriod,
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
            {
              id: `il_migration_${randomUUID()}`,
              amount: packageLineAmount,
              subtotal: packageLineAmount,
              quantity: args.packageQuantity,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              pricing: {
                price_details: { price: TEST_PRICE_USAGE_PACK_20 },
              },
              proration: false,
              period: renewedPeriod,
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      };
    };
    const openInvoice = () => {
      return {
        ...paidInvoice(),
        status: "open",
        paid: false,
        amount_paid: 0,
        status_transitions: { paid_at: null },
        payments: { data: [] },
      };
    };
    const appliedSubscription = (): MigrationSubscriptionMock => {
      return {
        ...legacyMigrationSubscription(args.fixture),
        schedule: scheduleId,
        latest_invoice: invoiceId,
        items: {
          data: [
            {
              id: `si_plan_${targetTier}`,
              price: {
                id: planPriceId,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 1,
              current_period_start: renewedPeriod.start,
              current_period_end: renewedPeriod.end,
            },
            {
              id: "si_pack_20",
              price: {
                id: TEST_PRICE_USAGE_PACK_20,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: args.packageQuantity,
              current_period_start: renewedPeriod.start,
              current_period_end: renewedPeriod.end,
            },
          ],
        },
      };
    };
    let invoice = paidInvoice();
    let subscription: MigrationSubscriptionMock = legacyMigrationSubscription(
      args.fixture,
    );
    const syncRetrievalMocks = () => {
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(invoice);
    };
    syncRetrievalMocks();
    context.mocks.stripe.invoices.createPreview.mockImplementation((params) => {
      const targetPreview = migrationPreviewItems(params).some((item) => {
        return (
          typeof item === "object" &&
          item !== null &&
          "price" in item &&
          item.price === planPriceId
        );
      });
      return Promise.resolve({
        amount_due: targetPreview
          ? args.amountDueCents
          : args.currentRecurringAmountCents,
        currency: "usd",
      });
    });
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      subscription = { ...subscription, schedule: scheduleId };
      syncRetrievalMocks();
      return Promise.resolve({ id: scheduleId, phases: [] });
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
      phases: [],
    });
    context.mocks.stripe.subscriptions.update.mockImplementation(
      (_subscriptionId, params) => {
        const metadata = stringMetadata(params);
        if (metadata) {
          subscription = {
            ...subscription,
            metadata: {
              ...subscription.metadata,
              ...metadata,
            },
          };
          syncRetrievalMocks();
          return Promise.resolve(subscription);
        }
        throw new Error(
          "Migration must not replace subscription items directly",
        );
      },
    );
    return {
      invoice: () => {
        return invoice;
      },
      cancelSubscription: () => {
        subscription = {
          ...subscription,
          cancel_at: args.fixture.period.end,
          cancel_at_period_end: true,
        };
        syncRetrievalMocks();
        return subscription;
      },
      startScheduledPhase: () => {
        invoice = paidInvoice();
        subscription = appliedSubscription();
        syncRetrievalMocks();
      },
      cancelSchedule: () => {
        invoice = { ...openInvoice(), status: "void" };
        subscription = legacyMigrationSubscription(args.fixture);
        syncRetrievalMocks();
      },
    };
  }

  function migrationClient() {
    return setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackMigrationContract,
    );
  }

  async function enableMigration(fixture: BillingOrgFixture): Promise<void> {
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
  }

  async function postMigrationInvoice(invoice: object): Promise<void> {
    const event = {
      id: `evt_migration_${randomUUID()}`,
      type: "invoice.paid",
      created: currentSecond(),
      data: { object: invoice },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=migration-test" },
      }),
      [200],
    );
  }

  async function postMigrationSubscription(
    subscription: object,
  ): Promise<void> {
    const event = {
      id: `evt_migration_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: currentSecond(),
      data: { object: subscription },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=migration-test" },
      }),
      [200],
    );
  }

  async function postMigrationInvitationAccepted(args: {
    readonly fixture: LegacyMigrationFixture;
    readonly purchaseId: string;
    readonly userId: string;
  }): Promise<void> {
    if (!args.fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    const event = {
      type: "organizationInvitation.accepted",
      data: {
        object: "organization_invitation",
        id: args.fixture.invitation.id,
        email_address: args.fixture.invitation.email,
        organization_id: args.fixture.orgId,
        role: args.fixture.invitation.role,
        role_name: "Member",
        status: "accepted",
        user_id: args.userId,
        public_metadata: {},
        private_metadata: {
          usagePackInvitationPurchaseId: args.purchaseId,
        },
        url: null,
        created_at: now() - 1000,
        updated_at: now(),
        expires_at: args.fixture.period.end * 1000,
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function previewMigration(
    fixture: LegacyMigrationFixture,
    targetTier: "pro" | "team" = fixture.tier,
  ): Promise<{ readonly migrationId: string }> {
    const memberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 20 as const },
      ...(fixture.invitation
        ? [{ memberId: fixture.invitation.id, usagePackUsd: 20 as const }]
        : []),
    ];
    const response = await accept(
      migrationClient().preview({
        headers: { authorization: "Bearer clerk-session" },
        body: { targetTier, memberUsagePacks },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      tier: fixture.tier,
      targetTier,
      currency: "usd",
      purchasedCredits: 20_000 * memberUsagePacks.length,
      bonusCredits: 400 * memberUsagePacks.length,
      totalCredits: 20_400 * memberUsagePacks.length,
    });
    return { migrationId: response.body.migrationId };
  }

  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setZeroPrice();
    setUsagePackPrices();
    mockUsagePackCatalog();
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  });

  it("hides legacy migration while UsagePackPlans is disabled", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      legacyMigrationSubscription(fixture),
    );

    const response = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Usage pack management is not enabled",
    );
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("rejects a Stripe subscription scheduled for cancellation", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    await enableMigration(fixture);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...legacyMigrationSubscription(fixture),
      cancel_at_period_end: true,
    });

    const response = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "Legacy subscription migration is not available",
    );
  });

  it("prevents an active legacy subscription from bypassing migration", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    await enableMigration(fixture);

    const response = await accept(
      setupApp({ context, routes: zeroBillingCheckoutRoutes })(
        zeroBillingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "team",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Existing subscriptions must migrate before starting usage pack checkout",
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("keeps legacy state when the legacy item changes after preview", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    await enableMigration(fixture);
    mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 2000,
      amountPaidCents: 2000,
    });
    const preview = await previewMigration(fixture);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...legacyMigrationSubscription(fixture),
      items: {
        data: [
          {
            ...legacyMigrationSubscription(fixture).items.data[0],
            quantity: 2,
          },
        ],
      },
    });

    const response = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body.error.message).toBe(
      "Usage pack migration is no longer available",
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const persisted = await readUsagePackState(fixture.orgId);
    expect(persisted.migrations).toStrictEqual([
      expect.objectContaining({
        id: preview.migrationId,
        status: "failed",
        failureReason: "subscription_changed",
      }),
    ]);
    expect(persisted.subscriptionCount).toBe(0);
  });

  it("schedules a legacy Pro-to-Team conversion at the billing boundary", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    await enableMigration(fixture);
    const stripe = mockMigrationStripe({
      fixture,
      targetTier: "team",
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const state = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(state.body).toMatchObject({ tier: "pro", status: "eligible" });
    const preview = await previewMigration(fixture, "team");

    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toMatchObject({
      status: "scheduled",
      effectiveAt: new Date(fixture.period.end * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith(
      { from_subscription: fixture.subscriptionId },
      {
        idempotencyKey: `usage-pack-migration:${preview.migrationId}:schedule-create`,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          expect.objectContaining({
            start_date: fixture.period.start,
            end_date: fixture.period.end,
            items: [{ price: fixture.legacyPriceId, quantity: 1 }],
          }),
          expect.objectContaining({
            start_date: fixture.period.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: `usage-pack-migration:${preview.migrationId}:schedule-update`,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const scheduledState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(scheduledState.migrations).toStrictEqual([
      expect.objectContaining({ status: "scheduled" }),
    ]);
    expect(scheduledState.subscriptionCount).toBe(0);
    expect(scheduledState.allocations).toStrictEqual([]);
    expect(scheduledState.grants).toStrictEqual([]);
    expect(scheduledState.legacyCredits).toStrictEqual([
      expect.objectContaining({
        stripeInvoiceId: fixture.legacyCreditInvoiceId,
        amount: 12_345,
        remaining: 12_345,
      }),
    ]);

    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());
    const usageState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(usageState.allocations).toStrictEqual([
      expect.objectContaining({
        userId: fixture.userId,
        status: "active",
        usagePackUsd: 20,
      }),
    ]);
    expect(usageState.org?.tier).toBe("team");
    expect(usageState.grants).toHaveLength(2);
    expect(usageState.legacyCredits).toStrictEqual([
      expect.objectContaining({
        stripeInvoiceId: fixture.legacyCreditInvoiceId,
        amount: 12_345,
        remaining: 12_345,
      }),
    ]);

    await postMigrationInvoice(stripe.invoice());
    const duplicateState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(duplicateState.grants).toHaveLength(2);

    await postMigrationSubscription(legacyMigrationSubscription(fixture));
    const delayedState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(delayedState.subscription?.subscriptionStatus).toBe("active");
    expect(delayedState.grants).toHaveLength(2);
  });

  it("revises a scheduled migration and exposes its current configuration", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    await enableMigration(fixture);
    mockMigrationStripe({
      fixture,
      targetTier: "team",
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preview = await previewMigration(fixture, "team");
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const scheduled = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(scheduled.body).toMatchObject({
      status: "scheduled",
      configuration: {
        tier: "team",
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
        recurringAmountCents: 18_000,
        currency: "usd",
      },
    });

    context.mocks.stripe.invoices.createPreview.mockImplementation((params) => {
      const priceIds = migrationPreviewPriceIds(params);
      return Promise.resolve({
        amount_due: priceIds.includes(TEST_PRICE_USAGE_PACK_50) ? 7000 : 18_000,
        currency: "usd",
      });
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    const memberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 50 as const },
    ];
    const revisionPreview = await accept(
      migrationClient().previewRevision({
        params: { migrationId: preview.migrationId },
        body: { targetTier: "pro", memberUsagePacks },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(revisionPreview.body).toMatchObject({
      migrationId: preview.migrationId,
      tier: "team",
      targetTier: "pro",
      currentRecurringAmountCents: 18_000,
      nextRecurringAmountCents: 7000,
      recurringDifferenceCents: -11_000,
      purchasedCredits: 50_000,
      bonusCredits: 2600,
      totalCredits: 52_600,
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscription: fixture.subscriptionId }),
    );

    const confirmation = await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "pro",
          memberUsagePacks,
          previewToken: revisionPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body).toMatchObject({ status: "scheduled" });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: [
          expect.any(Object),
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: expect.stringMatching(
          new RegExp(
            `^usage-pack-migration:${preview.migrationId}:schedule-revision:[a-f0-9]{64}$`,
          ),
        ),
      },
    );
    const scheduleUpdateCount =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.length;
    await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "pro",
          memberUsagePacks,
          previewToken: revisionPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update.mock.calls,
    ).toHaveLength(scheduleUpdateCount);

    const revised = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(revised.body).toMatchObject({
      status: "scheduled",
      targetTier: "pro",
      configuration: {
        tier: "pro",
        memberUsagePacks,
        recurringAmountCents: 7000,
        currency: "usd",
      },
    });
  });

  it("rejects tampered and stale migration revision previews", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    await enableMigration(fixture);
    mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 4000,
      amountPaidCents: 4000,
    });
    const preview = await previewMigration(fixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.invoices.createPreview.mockImplementation((params) => {
      const priceIds = migrationPreviewPriceIds(params);
      const amountDue = priceIds.includes(TEST_PRICE_USAGE_PACK_100)
        ? 28_000
        : 7000;
      return Promise.resolve({ amount_due: amountDue, currency: "usd" });
    });
    const firstMemberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 50 as const },
    ];
    const secondMemberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 100 as const },
    ];
    const firstPreview = await accept(
      migrationClient().previewRevision({
        params: { migrationId: preview.migrationId },
        body: { targetTier: "pro", memberUsagePacks: firstMemberUsagePacks },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondPreview = await accept(
      migrationClient().previewRevision({
        params: { migrationId: preview.migrationId },
        body: { targetTier: "team", memberUsagePacks: secondMemberUsagePacks },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "pro",
          memberUsagePacks: firstMemberUsagePacks,
          previewToken: `${firstPreview.body.previewToken}tampered`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "pro",
          memberUsagePacks: firstMemberUsagePacks,
          previewToken: firstPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const stale = await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "team",
          memberUsagePacks: secondMemberUsagePacks,
          previewToken: secondPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(stale.body.error.message).toBe(
      "Usage pack migration configuration changed",
    );

    const state = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(state.body.configuration).toMatchObject({
      tier: "pro",
      memberUsagePacks: firstMemberUsagePacks,
    });
  });

  it("keeps Team legacy state intact when its migration schedule is canceled", async () => {
    mockNow(new Date("2020-01-01T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const preservedFixture = await seedLegacyMigrationFixture({
      tier: "team",
      orgId: `org_migration_preserved_${randomUUID()}`,
    });
    await enableMigration(preservedFixture);
    mockMigrationStripe({
      fixture: preservedFixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preservedPreview = await previewMigration(preservedFixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preservedPreview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const preservedBefore = await readUsagePackState(preservedFixture.orgId);

    const fixture = await seedLegacyMigrationFixture({ tier: "team" });
    await enableMigration(fixture);
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
    expect((await readUsagePackState(fixture.orgId)).subscriptionCount).toBe(0);

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    const retry = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(retry.body.status).toBe("scheduled");

    stripe.cancelSchedule();
    mockNow(fixture.period.end * 1000 + 10 * 60 * 1000);
    await reconcileBillingOrganization(fixture.orgId);

    const preserved = await readUsagePackState(preservedFixture.orgId);
    expect(preserved).toStrictEqual(preservedBefore);
    expect(preserved.migrations).toStrictEqual([
      expect.objectContaining({
        id: preservedPreview.migrationId,
        status: "scheduled",
      }),
    ]);

    const persisted = await readUsagePackState(fixture.orgId);
    expect(persisted.migrations).toStrictEqual([
      expect.objectContaining({ id: preview.migrationId, status: "failed" }),
    ]);
    expect(persisted.subscriptionCount).toBe(0);
    expect(persisted.org).toMatchObject({
      tier: "team",
      stripeSubscriptionId: fixture.subscriptionId,
      credits: 12_345,
    });
  });

  it("syncs legacy cancellation when a subscription update invalidates migration", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "team" });
    await enableMigration(fixture);
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preview = await previewMigration(fixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await postMigrationSubscription(stripe.cancelSubscription());

    const state = await readUsagePackState(fixture.orgId);
    expect(state.migrations).toStrictEqual([
      expect.objectContaining({
        id: preview.migrationId,
        status: "failed",
        failureReason: "subscription_changed",
      }),
    ]);
    expect(state.org).toMatchObject({
      tier: "team",
      stripeSubscriptionId: fixture.subscriptionId,
      subscriptionStatus: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(fixture.period.end * 1000).toISOString(),
    });
  });

  it("refunds only a pending invitation's share of a migration payment", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "team",
      invitation: true,
    });
    if (!fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    await enableMigration(fixture);
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 2,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 20_000,
      amountPaidCents: 20_000,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());

    const [purchase] = (
      await readUsagePackState(fixture.orgId, preview.migrationId)
    ).invitationPurchases;
    expect(purchase).toMatchObject({
      status: "invitation_pending",
      expectedAmountCents: 2000,
      amountPaidCents: 2000,
    });
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: fixture.invitation.id }] },
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });

    await accept(
      setupApp({ context, routes: zeroOrgInviteRoutes })(
        zeroOrgInviteContract,
      ).revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId: fixture.invitation.id },
      }),
      [200],
    );

    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: purchase?.stripePaymentIntentId,
        amount: 2000,
      }),
      expect.any(Object),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          `usage-pack-projection:invitation:${purchase?.id}:refund:`,
        ),
      }),
    );
  });

  it("activates a migrated invitation without adding a second Stripe seat", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "team",
      invitation: true,
    });
    if (!fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    await enableMigration(fixture);
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 2,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 20_000,
      amountPaidCents: 20_000,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());
    const [purchase] = (
      await readUsagePackState(fixture.orgId, preview.migrationId)
    ).invitationPurchases;
    if (!purchase) {
      throw new Error("Expected a migrated invitation purchase");
    }

    context.mocks.stripe.subscriptions.update.mockClear();
    const acceptedUserId = `user_migration_invited_${randomUUID()}`;
    await postMigrationInvitationAccepted({
      fixture,
      purchaseId: purchase.id,
      userId: acceptedUserId,
    });
    await postMigrationInvitationAccepted({
      fixture,
      purchaseId: purchase.id,
      userId: acceptedUserId,
    });

    const accepted = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(accepted.invitationPurchases).toStrictEqual([
      expect.objectContaining({
        id: purchase.id,
        status: "accepted",
        acceptedUserId,
      }),
    ]);
    expect(
      accepted.allocations.filter((allocation) => {
        return allocation.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        invitationId: null,
        status: "active",
        usagePackUsd: 20,
      }),
    ]);
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        originalAmount: 400,
      }),
      expect.objectContaining({
        grantType: "purchased",
        originalAmount: 20_000,
      }),
    ]);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("finishes a zero-amount Team conversion and invitation lifecycle after switch-off", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "team",
      invitation: true,
    });
    if (!fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    await enableMigration(fixture);
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 2,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 0,
      amountPaidCents: 0,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");

    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: false,
    });
    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());

    const state = await readUsagePackState(fixture.orgId, preview.migrationId);
    const [purchase] = state.invitationPurchases;
    expect(purchase).toMatchObject({
      status: "invitation_pending",
      amountPaidCents: 0,
      stripePaymentIntentId: null,
    });
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invitationId: fixture.invitation.id,
          status: "pending_invitation",
        }),
      ]),
    );

    const revokeResponse = await accept(
      setupApp({ context, routes: zeroOrgInviteRoutes })(
        zeroOrgInviteContract,
      ).revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId: fixture.invitation.id },
      }),
      [200],
    );
    expect(revokeResponse.body.message).toBe(
      "Invitation revoked and refund initiated",
    );
    const [refunded] = (
      await readUsagePackState(fixture.orgId, preview.migrationId)
    ).invitationPurchases;
    expect(refunded?.status).toBe("refunded");
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          `usage-pack-projection:invitation:${purchase?.id}:refund:`,
        ),
      }),
    );
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
        has_more: false,
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

  function managedConcurrencyInvoiceLine(args: {
    readonly quantity: number;
    readonly billingPeriod: { readonly start: number; readonly end: number };
    readonly proration: boolean;
  }) {
    return {
      id: `il_${randomUUID()}`,
      amount: 10_000 * args.quantity,
      subtotal: 10_000 * args.quantity,
      quantity: args.quantity,
      price: { id: TEST_PRICE_CONCURRENCY },
      period: args.billingPeriod,
      parent: {
        type: "subscription_item_details" as const,
        subscription_item_details: { proration: args.proration },
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
        has_more: false,
        data: [line(args.sourcePriceId, -1000), line(args.targetPriceId, 2500)],
      },
    };
  }

  function managedUsagePackAdditionInvoice(
    fixture: ManagedUsagePackFixture,
    args: {
      readonly invoiceId: string;
      readonly targetPriceId: string;
      readonly prorationTimestamp: number;
    },
  ) {
    const metadata = managedUsagePackMetadata(fixture);
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
        has_more: false,
        data: [
          {
            id: `il_${randomUUID()}`,
            amount: 2500,
            subtotal: 2500,
            quantity: 1,
            price: { id: args.targetPriceId },
            period: {
              start: args.prorationTimestamp,
              end: fixture.billingPeriod.end,
            },
            parent: {
              type: "subscription_item_details" as const,
              subscription_item_details: { proration: true },
            },
          },
        ],
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
    fixture: BillingOrgFixture = createOrgFixture(TEST_STAFF_ORG_ID),
  ): Promise<ManagedUsagePackFixture> {
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
        lines: {
          has_more: false,
          data: lines,
        },
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
          lines: {
            has_more: false,
            data: [],
          },
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
          has_more: false,
          data: [
            line(args.sourcePriceId, -1000),
            line(args.targetPriceId, args.immediateAmountCents + 1000),
          ],
        },
      });
    });
  }

  interface InvitationPurchaseFixture {
    readonly fixture: ManagedUsagePackFixture;
    readonly existingMemberUserId: string;
    readonly email: string;
    readonly purchaseId: string;
    readonly paymentIntentId: string;
  }

  async function beginInvitationPurchase(): Promise<InvitationPurchaseFixture> {
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const email = `invitee-${randomUUID()}@example.test`;
    const paymentIntentId = `pi_invite_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    mockUsagePackChangePreviews(1000, 2000);
    const preview = await accept(
      setupApp({ context, routes: zeroOrgInviteRoutes })(
        zeroOrgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { email, role: "member", usagePackUsd: 20 },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 1000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(
        fixture.billingPeriod.end * 1000,
      ).toISOString(),
      expiresAt: expect.any(String),
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
    return {
      fixture,
      existingMemberUserId,
      email,
      purchaseId: preview.body.purchaseId,
      paymentIntentId,
    };
  }

  async function payInvitationPurchase(
    purchase: InvitationPurchaseFixture,
    invitationId: string,
  ): Promise<void> {
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      {
        id: invitationId,
        emailAddress: purchase.email,
        organizationId: purchase.fixture.orgId,
        status: "pending",
        privateMetadata: {
          usagePackInvitationPurchaseId: purchase.purchaseId,
        },
      },
    );
    await postManagedUsagePackEvent("payment_intent.succeeded", {
      id: purchase.paymentIntentId,
      status: "succeeded",
      customer: purchase.fixture.customerId,
      payment_method: null,
      amount_received: 1000,
      currency: "usd",
      created: Math.floor(now() / 1000),
      metadata: {
        purpose: "usage_pack_invitation_purchase",
        usagePackInvitationPurchaseId: purchase.purchaseId,
      },
    });
  }

  async function postClerkInvitationAccepted(args: {
    readonly purchase: InvitationPurchaseFixture;
    readonly invitationId: string;
    readonly userId: string;
  }): Promise<void> {
    const event = {
      type: "organizationInvitation.accepted",
      data: {
        object: "organization_invitation",
        id: args.invitationId,
        email_address: args.purchase.email,
        organization_id: args.purchase.fixture.orgId,
        role: "org:member",
        role_name: "Member",
        status: "accepted",
        user_id: args.userId,
        public_metadata: {},
        private_metadata: {
          usagePackInvitationPurchaseId: args.purchase.purchaseId,
        },
        url: null,
        created_at: now() - 1000,
        updated_at: now(),
        expires_at: args.purchase.fixture.billingPeriod.end * 1000,
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function postClerkMembershipCreated(args: {
    readonly purchase: InvitationPurchaseFixture;
    readonly userId: string;
  }): Promise<void> {
    const event = {
      type: "organizationMembership.created",
      data: {
        object: "organization_membership",
        id: `orgmem_${randomUUID()}`,
        organization: { id: args.purchase.fixture.orgId },
        role: "org:member",
        public_user_data: {
          user_id: args.userId,
          identifier: args.purchase.email,
        },
        private_metadata: {
          usagePackInvitationPurchaseId: args.purchase.purchaseId,
        },
        created_at: now(),
        updated_at: now(),
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function runBillingReconciliation(orgId: string): Promise<void> {
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });
    await reconcileBillingOrganization(orgId);
  }

  function mockUsagePackSubscriptionAdditionPreviews(args: {
    readonly immediateAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly targetPriceId: string;
  }): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      const previewMode =
        "preview_mode" in input ? input.preview_mode : undefined;
      if (previewMode === "recurring") {
        return Promise.resolve({
          amount_due: args.nextRecurringAmountCents,
          currency: "usd",
          lines: {
            has_more: false,
            data: [],
          },
        });
      }
      const subscriptionDetails =
        "subscription_details" in input ? input.subscription_details : null;
      if (
        previewMode !== "next" ||
        typeof subscriptionDetails !== "object" ||
        subscriptionDetails === null ||
        !("proration_date" in subscriptionDetails) ||
        typeof subscriptionDetails.proration_date !== "number"
      ) {
        throw new Error("Expected an immediate Stripe preview");
      }
      return Promise.resolve({
        amount_due: args.immediateAmountCents,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: args.immediateAmountCents,
              pricing: { price_details: { price: args.targetPriceId } },
              parent: { subscription_item_details: { proration: true } },
              period: { start: subscriptionDetails.proration_date },
            },
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

  it("routes a concurrency-only invoice on the Plan subscription", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "team",
      actor,
    );
    const quantity = 10;
    const invoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([
          [TEST_PRICE_USAGE_PACK_20, 1],
          [TEST_PRICE_CONCURRENCY, quantity],
        ]),
      ),
    );
    const metadata = managedUsagePackMetadata(fixture);

    await postManagedUsagePackEvent("invoice.paid", {
      id: invoiceId,
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
        has_more: false,
        data: [
          managedConcurrencyInvoiceLine({
            quantity,
            billingPeriod: fixture.billingPeriod,
            proration: true,
          }),
        ],
      },
    });

    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity,
        currentPeriodEnd: new Date(
          fixture.billingPeriod.end * 1000,
        ).toISOString(),
      }),
    ]);
    const usagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(usagePackState.fulfillmentInvoiceIds).not.toContain(invoiceId);
  });

  it("idempotently processes usage pack and concurrency from one renewal invoice", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "team",
      actor,
    );
    const quantity = 6;
    const renewalPeriod = {
      start: fixture.billingPeriod.end,
      end: fixture.billingPeriod.end + 30 * 86_400,
    };
    mockNow(new Date(renewalPeriod.start * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([
          [TEST_PRICE_USAGE_PACK_20, 1],
          [TEST_PRICE_CONCURRENCY, quantity],
        ]),
        renewalPeriod,
      ),
    );
    const invoiceId = `in_${randomUUID()}`;
    const usagePackInvoice = managedUsagePackInvoice(fixture, {
      invoiceId,
      quantities: new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      billingPeriod: renewalPeriod,
    });
    const invoice = {
      ...usagePackInvoice,
      lines: {
        ...usagePackInvoice.lines,
        data: [
          ...usagePackInvoice.lines.data,
          managedConcurrencyInvoiceLine({
            quantity,
            billingPeriod: renewalPeriod,
            proration: false,
          }),
        ],
      },
    };

    await postManagedUsagePackEvent("invoice.paid", invoice);

    const firstUsagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(firstUsagePackState.fulfillmentInvoiceIds).toContain(invoiceId);
    expect(firstUsagePackState.allocations).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        status: "active",
        currentPeriodStart: new Date(renewalPeriod.start * 1000).toISOString(),
        currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
      }),
    );
    const firstStatus = await readBillingStatus(fixture);
    expect(firstStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity,
        currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
      }),
    ]);

    await postManagedUsagePackEvent("invoice.paid", invoice);

    const replayedUsagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      replayedUsagePackState.fulfillmentInvoiceIds.filter((id) => {
        return id === invoiceId;
      }),
    ).toHaveLength(1);
    expect(replayedUsagePackState.grants).toStrictEqual(
      firstUsagePackState.grants,
    );
    const replayedStatus = await readBillingStatus(fixture);
    expect(replayedStatus.concurrencySubscriptions).toStrictEqual(
      firstStatus.concurrencySubscriptions,
    );
  });

  it("keeps invitation state safe before entitlement migrations", async () => {
    const response = await usagePackStateAction({
      action: "validate-pre-migration-compatibility",
    });
    expect(response).toStrictEqual({
      action: "pre-migration-compatibility",
      memberInviteUsagePackRequired: false,
      preMemberInvitationMigration: {
        memberInviteUsagePackRequired: true,
        memberInvitationAllowed: true,
      },
      bonusPreparedRefunds: 0,
    });
  });

  it("preserves purchased credits until migration 0898 is available", async () => {
    const response = await accept(
      setupApp({
        context,
        routes: testUsagePackSubscriptionStateRoutes,
      })(testUsagePackSubscriptionStateContract).action({
        body: { action: "prepare-pre-migration-purchased-refund" },
      }),
      [500],
    );
    expect(response.body).toStrictEqual({ error: "Internal server error" });
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
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
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
    expect(first.body.immediateCreditGrant).toStrictEqual({
      purchasedCredits: 15_000,
      bonusCredits: 1100,
      totalCredits: 16_100,
      expiresAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
    });
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations[0]?.pendingChange).toBeNull();
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

  it("retries a grouped subscription change after a Stripe failure", async () => {
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
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.update
      .mockRejectedValueOnce(new Error("temporary Stripe failure"))
      .mockResolvedValue({
        ...sourceSubscription,
        pending_update: { expires_at: prorationTimestamp + 300 },
        latest_invoice: { ...invoice, status: "open" },
      });

    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [500],
    );
    const applying = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(applying.changes[0]?.status).toBe("applying");

    const retried = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(retried.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      fixture.subscriptionId,
      expect.objectContaining({
        payment_behavior: "pending_if_incomplete",
        proration_date: prorationTimestamp,
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:apply`,
      },
    );
  });

  it("updates a member package through the combined subscription change", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
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

  it("adds an active member package to the existing subscription", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const orgFixture = createOrgFixture();
    const addedUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId: orgFixture.userId, usagePackUsd: 20 }],
      "pro",
      orgFixture,
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: orgFixture.userId },
            createdAt: now(),
          },
          {
            role: "org:member",
            publicUserData: { userId: addedUserId },
            createdAt: now(),
          },
        ],
      },
    );
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackSubscriptionAdditionPreviews({
      immediateAmountCents: 2500,
      nextRecurringAmountCents: 7000,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.supportsMemberAdditions).toBeTruthy();

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: orgFixture.userId, usagePackUsd: 20 },
            { memberId: addedUserId, usagePackUsd: 50 },
          ],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 2500,
        nextRecurringAmountCents: 7000,
        immediateCreditGrant: {
          purchasedCredits: 25_000,
          bonusCredits: 1300,
          totalCredits: 26_300,
          expiresAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
        },
      }),
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const paidInvoice = managedUsagePackAdditionInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    const updatedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_20, 1],
        [TEST_PRICE_USAGE_PACK_50, 1],
      ]),
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(updatedSubscription);
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
        items: [{ price: TEST_PRICE_USAGE_PACK_50, quantity: 1 }],
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
        expect.objectContaining({
          userId: orgFixture.userId,
          usagePackUsd: 20,
          status: "active",
        }),
        expect.objectContaining({
          userId: addedUserId,
          usagePackUsd: 50,
          status: "active",
        }),
      ]),
    );
    expect(state.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: addedUserId,
          grantType: "purchased",
          originalAmount: 25_000,
        }),
        expect.objectContaining({
          userId: addedUserId,
          grantType: "bonus",
          originalAmount: 1300,
        }),
      ]),
    );
  });

  it("rejects adding a user who is not an active organization member", async () => {
    const orgFixture = createOrgFixture();
    const unknownUserId = `user_${randomUUID()}`;
    await seedManagedUsagePack(
      [{ userId: orgFixture.userId, usagePackUsd: 20 }],
      "pro",
      orgFixture,
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: orgFixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    const client = setupApp({ context, routes: zeroBillingCheckoutRoutes })(
      zeroBillingUsagePackManagementContract,
    );

    const response = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: orgFixture.userId, usagePackUsd: 20 },
            { memberId: unknownUserId, usagePackUsd: 50 },
          ],
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization members changed; refresh billing and try again",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
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

  it("replaces a scheduled package downgrade on the existing schedule", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 200 }]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_200, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_200,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const scheduleId = "sub_sched_usage_pack_replace";
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
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );

    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_200, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 10_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_200,
      targetPriceId: TEST_PRICE_USAGE_PACK_100,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    context.mocks.stripe.invoices.createPreview.mockClear();
    const replacementPreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 100 }],
        },
      }),
      [200],
    );
    expect(replacementPreview.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 0,
        nextRecurringAmountCents: 10_000,
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      customer: fixture.customerId,
      preview_mode: "recurring",
      subscription_details: {
        items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
        ],
      },
    });
    const beforeConfirmation = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      beforeConfirmation.body.allocations[0]?.pendingChange?.targetUsagePackUsd,
    ).toBe(50);

    const replacement = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replacementPreview.body.changeId },
      }),
      [200],
    );
    expect(replacement.body.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
            ]),
          }),
        ]),
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${replacementPreview.body.changeId}:schedule-update`,
      },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          sourceUsagePackUsd: 200,
          targetUsagePackUsd: 50,
        }),
        expect.objectContaining({
          status: "scheduled",
          sourceUsagePackUsd: 200,
          targetUsagePackUsd: 100,
        }),
      ]),
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      management.body.allocations[0]?.pendingChange?.targetUsagePackUsd,
    ).toBe(100);

    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 20_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_200,
      targetPriceId: TEST_PRICE_USAGE_PACK_200,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    const restorePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 200 }],
        },
      }),
      [200],
    );
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: restorePreview.body.changeId },
      }),
      [200],
    );
    const restoredManagement = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(restoredManagement.body.allocations[0]?.pendingChange).toBeNull();
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
    await reconcileBillingOrganization(fixture.orgId);
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
    expect(upgraded.refunds).toContainEqual(
      expect.objectContaining({
        userId: sourceUserId,
        sourceType: "invoice",
        sourceAmountCents: 1500,
        status: "available",
      }),
    );
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
    await reconcileBillingOrganization(fixture.orgId);

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
    await reconcileBillingOrganization(fixture.orgId);

    const scheduled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(scheduled.changes[0]?.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledTimes(2);
  });

  it("refunds a removed member exactly once across admin and Clerk removal ingress", async () => {
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
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: fixture.orgId,
      userId: targetUserId,
      grantType: "purchased",
      remainingAmount: 25_000,
    });
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
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2500,
      refunds: [],
    });
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: "cn_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2500,
      refunds: [
        {
          amount_refunded: 2500,
          refund: "re_usage_pack_removal",
        },
      ],
    });
    context.mocks.stripe.refunds.retrieve.mockResolvedValue({
      id: "re_usage_pack_removal",
      status: "succeeded",
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
    const duplicateEvent = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_removed_${randomUUID()}`,
        organization: { id: fixture.orgId },
        publicUserData: { userId: targetUserId },
        role: "org:member",
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(duplicateEvent);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: JSON.stringify(duplicateEvent) }),
      [200],
    );
    await flushWaitUntilForTest();

    const removed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(removed.remainingCredits).toContainEqual({
      userId: targetUserId,
      amount: 0,
    });
    expect(removed.refunds).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        sourceType: "invoice",
        sourceAmountCents: 5000,
        status: "succeeded",
        refundCredits: 25_000,
        requestedAmountCents: 2500,
        refundedAmountCents: 2500,
        stripeCreditNoteId: "cn_usage_pack_removal",
        stripeRefundId: "re_usage_pack_removal",
      }),
    );
    expect(removed.changes).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        kind: "removal",
        status: "completed",
      }),
    );
    expect(
      removed.allocations.find((allocation) => {
        return allocation.userId === targetUserId;
      })?.status,
    ).toBe("inactive");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: expect.arrayContaining([
          { id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 },
          { id: `si_${TEST_PRICE_USAGE_PACK_50}`, deleted: true },
        ]),
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("member-removal"),
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.stringMatching(/^in_/u),
        lines: [
          expect.objectContaining({
            type: "invoice_line_item",
            invoice_line_item: expect.stringMatching(/^il_/u),
            amount: 2500,
          }),
        ],
        refund_amount: 2500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1$/u,
        ),
      }),
    );

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.orgId, userId: adminUserId },
      { [FeatureSwitchKey.UsagePackPlans]: true },
    );
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
    const billingClient = setupApp({
      context,
      routes: zeroBillingCheckoutRoutes,
    })(zeroBillingUsagePackManagementContract);
    const management = await accept(
      billingClient.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: adminUserId,
        usagePackUsd: 20,
        pendingChange: null,
      }),
    ]);
    await accept(
      billingClient.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: adminUserId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
  });

  it("infers a legacy invoice refund when the removed member owns the last package", async () => {
    mockNow(new Date("2035-04-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await seedManagedUsagePack([
      { userId: targetUserId, usagePackUsd: 20 },
    ]);
    await usagePackStateAction({
      action: "delete-refund-source",
      orgId: fixture.orgId,
      userId: targetUserId,
    });
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
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_last_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2000,
      refunds: [],
    });
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: "cn_last_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2000,
      refunds: [
        {
          amount_refunded: 2000,
          refund: "re_last_usage_pack_removal",
        },
      ],
    });
    context.mocks.stripe.refunds.retrieve.mockResolvedValue({
      id: "re_last_usage_pack_removal",
      status: "succeeded",
    });

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
    expect(state.refunds).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        sourceType: "invoice",
        sourceAmountCents: 2000,
        status: "succeeded",
        requestedAmountCents: 2000,
        refundedAmountCents: 2000,
        stripeCreditNoteId: "cn_last_usage_pack_removal",
        stripeRefundId: "re_last_usage_pack_removal",
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.stringMatching(/^in_/u),
        amount: 2000,
        refund_amount: 2000,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1$/u,
        ),
      }),
    );
    expect(state.changes[0]).toStrictEqual(
      expect.objectContaining({ kind: "removal", status: "scheduled" }),
    );
    expect(state.subscription?.cancelAtPeriodEnd).toBeTruthy();
    expect(state.org?.cancelAtPeriodEnd).toBeTruthy();
  });

  it.each(["pro", "team"] as const)(
    "requires a usage pack for managed %s invitation entitlements",
    async (tier) => {
      const fixture = await seedManagedUsagePack(
        [{ userId: `user_${randomUUID()}`, usagePackUsd: 20 }],
        tier,
      );
      const billing = await readBillingStatus(fixture);
      expect(billing.memberInviteUsagePackRequired).toBeTruthy();

      const client = setupApp({ context, routes: zeroOrgInviteRoutes })(
        zeroOrgInviteContract,
      );
      const blocked = await accept(
        client.invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: "paid@example.test", role: "member" },
        }),
        [409],
      );
      expect(blocked.body.error.code).toBe("CONFLICT");
      expect(
        context.mocks.clerk.organizations.createOrganizationInvitation,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["pro", "team"] as const)(
    "keeps legacy %s invitation entitlements package-free",
    async (tier) => {
      const fixture = await createSubscriptionOrg({ tier });
      const billing = await readBillingStatus(fixture);
      expect(billing.memberInviteUsagePackRequired).toBeFalsy();

      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.UsagePackPlans]: true,
      });
      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
        { id: `inv_${randomUUID()}` },
      );
      const invited = await accept(
        setupApp({ context, routes: zeroOrgInviteRoutes })(
          zeroOrgInviteContract,
        ).invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: `legacy-${tier}@example.test`, role: "member" },
        }),
        [200],
      );
      expect(invited.body.message).toContain(`legacy-${tier}@example.test`);
    },
  );

  it("keeps package-free invites available when usage pack enrollment is disabled", async () => {
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const client = setupApp({ context, routes: zeroOrgInviteRoutes })(
      zeroOrgInviteContract,
    );
    const blocked = await accept(
      client.invite({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "paid@example.test", role: "member" },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CONFLICT");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
    expect(
      (await readBillingStatus(fixture)).memberInviteUsagePackRequired,
    ).toBeTruthy();

    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: false,
    });
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      { id: `inv_${randomUUID()}` },
    );
    const legacy = await accept(
      client.invite({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "legacy@example.test", role: "member" },
      }),
      [200],
    );
    expect(legacy.body.message).toContain("legacy@example.test");
  });

  it("blocks free plans only while usage pack plans are enabled", async () => {
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const client = setupApp({ context, routes: zeroOrgInviteRoutes })(
      zeroOrgInviteContract,
    );

    for (const tier of ["free", "limited-free-1", "pro-suspend"] as const) {
      await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
      const blocked = await accept(
        client.invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: `${tier}@example.test`, role: "member" },
        }),
        [403],
      );
      expect(blocked.body.error).toStrictEqual({
        message: "Upgrade to Pro to invite members",
        code: "FORBIDDEN",
      });
    }
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();

    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: false,
    });
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      { id: `inv_${randomUUID()}` },
    );
    const legacy = await accept(
      client.invite({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "suspended@example.test", role: "member" },
      }),
      [200],
    );
    expect(legacy.body.message).toContain("suspended@example.test");
  });

  it("honors the invitation feature switch for a non-staff org", async () => {
    const fixture = createOrgFixture();
    expect(isStaffOrg(fixture.orgId)).toBeFalsy();
    authenticateOrg(fixture);
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });

    const response = await accept(
      setupApp({ context, routes: zeroOrgInviteRoutes })(
        zeroOrgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email: "non-staff@example.test",
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("previews and confirms an invitation with the saved payment method", async () => {
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const email = `direct-invite-${randomUUID()}@example.test`;
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    const invoiceId = `in_invite_${randomUUID()}`;
    const paymentIntentId = `pi_invite_${randomUUID()}`;
    const invitationId = `inv_direct_${randomUUID()}`;
    const subscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      {
        id: invitationId,
        emailAddress: email,
        organizationId: fixture.orgId,
        status: "pending",
      },
    );
    mockUsagePackChangePreviews(1000, 2000);
    context.mocks.stripe.checkout.sessions.create.mockClear();

    const client = setupApp({ context, routes: zeroOrgInviteRoutes })(
      zeroOrgInviteContract,
    );
    const previewBody = {
      email,
      role: "member" as const,
      usagePackUsd: 20 as const,
    };
    const preview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: previewBody,
      }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 1000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(
        fixture.billingPeriod.end * 1000,
      ).toISOString(),
      expiresAt: expect.any(String),
    });
    const previewCallCount =
      context.mocks.stripe.invoices.createPreview.mock.calls.length;
    const repeatedPreview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: previewBody,
      }),
      [200],
    );
    expect(repeatedPreview.body.purchaseId).toBe(preview.body.purchaseId);
    expect(context.mocks.stripe.invoices.createPreview.mock.calls).toHaveLength(
      previewCallCount,
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const replacedPreview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { ...previewBody, role: "admin" },
      }),
      [200],
    );
    expect(replacedPreview.body.purchaseId).not.toBe(preview.body.purchaseId);
    const activePurchaseId = replacedPreview.body.purchaseId;
    const supersededConfirmation = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [409],
    );
    expect(supersededConfirmation.body.error.code).toBe("CONFLICT");
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: activePurchaseId,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      metadata,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_invite_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: invoiceId,
      status: "paid",
    });
    const paidInvoice = {
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      paid: true,
      currency: "usd",
      status_transitions: { paid_at: Math.floor(now() / 1000) },
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 1000,
            payment: {
              type: "payment_intent",
              payment_intent: paymentIntentId,
            },
          },
        ],
      },
    };
    context.mocks.stripe.invoices.retrieve
      .mockResolvedValueOnce({
        ...paidInvoice,
        status: "draft",
        paid: false,
        payments: { data: [] },
      })
      .mockResolvedValue(paidInvoice);

    const confirmed = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: activePurchaseId },
        body: {},
      }),
      [200],
    );

    expect(confirmed.body.message).toBe("Invitation purchased and sent");
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      {
        customer: fixture.customerId,
        auto_advance: false,
        default_payment_method: paymentMethodId,
        metadata,
      },
      {
        idempotencyKey: `usage-pack-invitation:${activePurchaseId}:invoice`,
      },
    );
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      {
        invoice: invoiceId,
        customer: fixture.customerId,
        amount: 1000,
        currency: "usd",
        description: `Member usage pack for ${email}`,
      },
      {
        idempotencyKey: `usage-pack-invitation:${activePurchaseId}:invoice-item`,
      },
    );
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      invoiceId,
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(invoiceId);
    await postManagedUsagePackEvent("invoice.paid", {
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
    });
    await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: activePurchaseId },
        body: {},
      }),
      [200],
    );
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: fixture.orgId,
        emailAddress: email,
        inviterUserId: fixture.userId,
        role: "org:admin",
        privateMetadata: {
          usagePackInvitationPurchaseId: activePurchaseId,
        },
      }),
    );
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);

    mockClerkOrganization(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: invitationId,
            emailAddress: email,
            organizationId: fixture.orgId,
            role: "org:admin",
            status: "pending",
            createdAt: now(),
          },
        ],
      },
    );
    server.use(
      http.get(
        "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
        () => {
          return HttpResponse.json({ data: [] });
        },
      ),
    );
    const members = await accept(
      setupApp({ context, routes: zeroOrgReadRoutes })(
        zeroOrgMembersContract,
      ).members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(members.body.pendingInvitations).toStrictEqual([
      expect.objectContaining({
        id: invitationId,
        email,
        usagePackUsd: 20,
      }),
    ]);
  });

  it("ignores invitation PaymentIntents from another preview job", async () => {
    const purchase = await beginInvitationPurchase();
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-current");

    await postManagedUsagePackEvent("payment_intent.succeeded", {
      id: purchase.paymentIntentId,
      status: "succeeded",
      customer: purchase.fixture.customerId,
      payment_method: null,
      amount_received: 1000,
      currency: "usd",
      created: Math.floor(now() / 1000),
      metadata: {
        purpose: "usage_pack_invitation_purchase",
        usagePackInvitationPurchaseId: purchase.purchaseId,
        vm0_environment: "preview",
        job_ref: "pr-other",
      },
    });
    mockEnv("ENV", "development");

    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]?.status).toBe("checkout_pending");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("activates one paid invitation exactly once after Clerk acceptance", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_paid_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    await payInvitationPurchase(purchase, invitationId);

    const pending = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(pending.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "invitation_pending",
        amountPaidCents: 1000,
        stripePaymentIntentId: purchase.paymentIntentId,
        clerkInvitationId: invitationId,
      }),
    );
    expect(
      pending.allocations.find((allocation) => {
        return allocation.invitationId === invitationId;
      })?.status,
    ).toBe("paid_pending_invitation");
    expect(
      new Set(
        pending.grants.map((grant) => {
          return grant.userId;
        }),
      ),
    ).toStrictEqual(new Set([purchase.existingMemberUserId]));
    expect(pending.grants).toHaveLength(2);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const acceptedUserId = `user_invited_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });

    const accepted = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(accepted.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "accepted",
        acceptedUserId,
      }),
    );
    expect(
      accepted.allocations.filter((allocation) => {
        return allocation.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        invitationId: null,
        status: "active",
        usagePackUsd: 20,
      }),
    ]);
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      {
        userId: acceptedUserId,
        grantType: "bonus",
        originalAmount: 200,
        expiresAt: new Date(
          purchase.fixture.billingPeriod.end * 1000,
        ).toISOString(),
      },
      {
        userId: acceptedUserId,
        grantType: "purchased",
        originalAmount: 10_000,
        expiresAt: new Date(
          purchase.fixture.billingPeriod.end * 1000,
        ).toISOString(),
      },
    ]);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      purchase.fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 2 }],
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(purchase.purchaseId),
      }),
    );
  });

  it("activates one paid invitation exactly once after Clerk creates the membership", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_membership_${randomUUID()}`;
    const acceptedUserId = `user_membership_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});

    await postClerkMembershipCreated({
      purchase,
      userId: acceptedUserId,
    });
    await postClerkMembershipCreated({
      purchase,
      userId: acceptedUserId,
    });

    const acceptedActor = {
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
    };
    await updateFeatureSwitchesForUser(context, acceptedActor, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    onTestFinished(async () => {
      await deleteFeatureSwitchesForUser(context, acceptedActor);
    });
    authenticateOrg(acceptedActor, "org:member");
    const credits = await accept(
      setupApp({ context, routes: zeroBillingUsagePackCreditsRoutes })(
        zeroBillingUsagePackCreditsContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(credits.body).toStrictEqual({
      totalCredits: 10_200,
      purchasedCredits: 10_000,
      bonusCredits: 200,
      hasUsagePack: true,
      creditGrants: expect.arrayContaining([
        expect.objectContaining({
          grantType: "bonus",
          amount: 200,
          remaining: 200,
          expiresAt: new Date(
            purchase.fixture.billingPeriod.end * 1000,
          ).toISOString(),
        }),
        expect.objectContaining({
          grantType: "purchased",
          amount: 10_000,
          remaining: 10_000,
          expiresAt: new Date(
            purchase.fixture.billingPeriod.end * 1000,
          ).toISOString(),
        }),
      ]),
    });
    expect(credits.body.creditGrants).toHaveLength(2);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("infers a legacy invitation grant's refund source when Clerk removes the member", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_removed_${randomUUID()}`;
    const acceptedUserId = `user_removed_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
      grantType: "purchased",
      remainingAmount: 5000,
    });
    const sourced = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(sourced.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        sourceType: "payment_intent",
        status: "available",
      }),
    );
    await usagePackStateAction({
      action: "delete-refund-source",
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    context.mocks.stripe.refunds.create
      .mockResolvedValueOnce({
        id: `re_removed_failed_${randomUUID()}`,
        status: "failed",
      })
      .mockResolvedValueOnce({
        id: `re_removed_succeeded_${randomUUID()}`,
        status: "succeeded",
      });
    const event = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_removed_${randomUUID()}`,
        organization: { id: purchase.fixture.orgId },
        publicUserData: { userId: acceptedUserId },
        role: "org:member",
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
      await accept(
        setupApp({ context, routes: webhooksClerkRoutes })(
          webhookClerkContract,
        ).post({ body: JSON.stringify(event) }),
        [200],
      );
      await flushWaitUntilForTest();
    }

    const removed = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(removed.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "accepted",
        acceptedUserId,
      }),
    );
    expect(
      removed.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("inactive");
    expect(removed.remainingCredits).toContainEqual({
      userId: acceptedUserId,
      amount: 0,
    });
    expect(removed.changes).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        kind: "removal",
        status: "completed",
      }),
    );
    expect(removed.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        sourceType: "payment_intent",
        sourceAmountCents: 1000,
        status: "succeeded",
        refundCredits: 5000,
        requestedAmountCents: 500,
        refundedAmountCents: 500,
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payment_intent: purchase.paymentIntentId,
        amount: 500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payment_intent: purchase.paymentIntentId,
        amount: 500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:2$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      purchase.fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 }],
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("member-removal"),
      }),
    );
  });

  it("reconciles an in-flight member refund without creating a duplicate Stripe refund", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_processing_${randomUUID()}`;
    const acceptedUserId = `user_processing_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
      grantType: "purchased",
      remainingAmount: 5000,
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    const stripeRefundId = `re_processing_${randomUUID()}`;
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: stripeRefundId,
      status: "pending",
    });
    const event = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_processing_${randomUUID()}`,
        organization: { id: purchase.fixture.orgId },
        publicUserData: { userId: acceptedUserId },
        role: "org:member",
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: JSON.stringify(event) }),
      [200],
    );
    await flushWaitUntilForTest();

    const processing = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(processing.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        status: "processing",
        stripeRefundId,
      }),
    );

    context.mocks.stripe.refunds.retrieve.mockResolvedValue({
      id: stripeRefundId,
      status: "succeeded",
    });
    await reconcileBillingOrganization(purchase.fixture.orgId);

    const reconciled = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(reconciled.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        status: "succeeded",
        refundedAmountCents: 500,
        stripeRefundId,
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.retrieve).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.retrieve).toHaveBeenCalledWith(
      stripeRefundId,
    );
  });

  it("reconciles acceptance when the Stripe projection response is lost", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_projection_retry_${randomUUID()}`;
    const acceptedUserId = `user_projection_retry_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockRejectedValueOnce(
      new Error("Stripe response lost"),
    );

    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });

    const activating = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(activating.invitationPurchases[0]?.status).toBe("activating");
    expect(
      activating.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("paid_pending_invitation");
    expect(
      activating.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toHaveLength(0);

    const renewalPeriod = {
      start: purchase.fixture.billingPeriod.end,
      end: purchase.fixture.billingPeriod.end + 30 * 86_400,
    };
    const renewalQuantities = new Map([[TEST_PRICE_USAGE_PACK_20, 2]]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        purchase.fixture,
        renewalQuantities,
        renewalPeriod,
      ),
    );
    mockNow(new Date(renewalPeriod.start * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(purchase.fixture, {
        invoiceId: `in_invitation_renewal_${randomUUID()}`,
        quantities: renewalQuantities,
        billingPeriod: renewalPeriod,
      }),
    );
    const renewed = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(renewed.invitationPurchases[0]?.status).toBe("activating");
    expect(
      renewed.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("active");
    await runBillingReconciliation(purchase.fixture.orgId);

    const accepted = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(accepted.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({ status: "accepted", acceptedUserId }),
    );
    expect(
      accepted.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("active");
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toHaveLength(4);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("revokes and refunds a paid pending invitation exactly once", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_refund_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: invitationId }] },
    );
    context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
      {},
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });
    const client = setupApp({ context, routes: zeroOrgInviteRoutes })(
      zeroOrgInviteContract,
    );
    await accept(
      client.revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId },
      }),
      [200],
    );
    await accept(
      client.revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId },
      }),
      [200],
    );

    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]?.status).toBe("refunded");
    expect(
      state.allocations.find((allocation) => {
        return allocation.invitationId === invitationId;
      })?.status,
    ).toBe("inactive");
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: purchase.paymentIntentId,
        amount: 1000,
      }),
      expect.any(Object),
    );
  });

  it("honors acceptance just before expiration when reconciliation races the boundary", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_near_expiry_${randomUUID()}`;
    const acceptedUserId = `user_near_expiry_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: acceptedUserId,
              identifier: purchase.email,
            },
            createdAt: purchase.fixture.billingPeriod.end * 1000 - 1000,
          },
        ],
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    mockNow(new Date(purchase.fixture.billingPeriod.end * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });

    await runBillingReconciliation(purchase.fixture.orgId);

    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "accepted",
        acceptedUserId,
      }),
    );
    expect(
      state.allocations.filter((allocation) => {
        return allocation.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({ status: "active", usagePackUsd: 20 }),
    ]);
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("automatically expires an invitation and retries a failed refund", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_expired_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    await updateFeatureSwitchesForUser(context, purchase.fixture, {
      [FeatureSwitchKey.UsagePackPlans]: false,
    });
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: invitationId }] },
    );
    context.mocks.stripe.refunds.create
      .mockResolvedValueOnce({
        id: `re_failed_${randomUUID()}`,
        status: "failed",
      })
      .mockResolvedValueOnce({
        id: `re_succeeded_${randomUUID()}`,
        status: "succeeded",
      });
    mockNow(new Date(purchase.fixture.billingPeriod.end * 1000));
    onTestFinished(() => {
      clearMockNow();
    });

    await runBillingReconciliation(purchase.fixture.orgId);
    const retryPending = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(retryPending.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({ status: "refund_pending", refundAttempt: 2 }),
    );

    await runBillingReconciliation(purchase.fixture.orgId);

    const refunded = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(refunded.invitationPurchases[0]?.status).toBe("refunded");
    expect(
      refunded.allocations.find((allocation) => {
        return allocation.invitationId === invitationId;
      })?.status,
    ).toBe("inactive");
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      {
        idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:1`,
      },
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      {
        idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:2`,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
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
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setZeroPrice();
  });

  async function trackedSeed(
    tier: OrgTier = "team",
  ): Promise<{ orgId: string; userId: string }> {
    const fixture = createOrgFixture();
    await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
    return fixture;
  }

  function recurringConcurrencyPreviewInvoice(quantity: number) {
    const line = {
      id: `il_${randomUUID()}`,
      amount: 10_000 * quantity,
      subtotal: 10_000 * quantity,
      quantity,
      price: { id: TEST_PRICE_CONCURRENCY },
      period: { start: 4_075_660_800, end: 4_078_252_800 },
      parent: {
        type: "subscription_item_details" as const,
        subscription_item_details: { proration: false },
      },
    };
    return {
      id: `in_recurring_${randomUUID()}`,
      amount_due: line.amount,
      currency: "usd",
      lines: { has_more: false, data: [line] },
    };
  }

  it("requires an active Plan subscription for a concurrency purchase", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).create({
        body: {
          quantity: 3,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "An active Plan subscription is required to buy concurrency",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("previews a concurrency purchase on the Plan subscription", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    const recurringInvoice = recurringConcurrencyPreviewInvoice(3);
    const planLine = {
      ...recurringInvoice.lines.data[0],
      id: `il_${randomUUID()}`,
      amount: 20_000,
      subtotal: 20_000,
      quantity: 1,
      price: { id: TEST_PRICE_TEAM },
    };
    context.mocks.stripe.invoices.listLineItems.mockResolvedValueOnce({
      has_more: false,
      data: [planLine, ...recurringInvoice.lines.data],
    });
    context.mocks.stripe.invoices.createPreview
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        const prorationDate = input.subscription_details.proration_date;
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 5500,
          currency: "usd",
          lines: {
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 5500,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: { start: prorationDate },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce({
        ...recurringInvoice,
        amount_due: 50_000,
        lines: { has_more: true, data: [planLine] },
      });

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 5500,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenCalledWith(
      recurringInvoice.id,
      { limit: 100 },
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("adds concurrency to the Plan subscription", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodEndUnix = 4_102_444_800;
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_end: periodEndUnix,
          },
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      fixture.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("reactivates a zero-quantity concurrency item on the Plan subscription", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-purchase";
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 0,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 1,
          },
        ],
      },
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

    expect(response.body).toStrictEqual({ url: hostedInvoiceUrl });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: concurrencyItemId, quantity: 1 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
  });

  it("activates concurrency on the Plan subscription without renewing Plan credits", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });

    const status = await readBillingStatus(fixture);
    expect(status.credits).toBe(fixture.planCredits);
    expect(status.hasSubscription).toBeTruthy();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        currentPeriodEnd: periodEnd.toISOString(),
      }),
    ]);
  });

  it("updates Plan and concurrency state from one shared subscription event", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "past_due",
          cancel_at_period_end: true,
          cancel_at: null,
          schedule: null,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
                current_period_end: Math.floor(periodEnd.getTime() / 1000),
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 3,
                current_period_end: Math.floor(periodEnd.getTime() / 1000),
              },
            ],
          },
        },
        previous_attributes: { cancel_at_period_end: false },
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
    expect(status.subscriptionStatus).toBe("past_due");
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.concurrencySubscriptions[0]).toStrictEqual(
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        cancelAtPeriodEnd: true,
      }),
    );
  });

  it("ends Plan and concurrency state when the shared subscription is deleted", async () => {
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    const event = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "canceled",
          metadata: {},
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
    expect(status.tier).toBe("limited-free-1");
    expect(status.hasSubscription).toBeFalsy();
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("updates an existing subscription without changing its billing anchor", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-increase";
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
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: subscriptionId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 5,
          },
        ],
      },
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
      url: hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      {
        items: [{ id: subscriptionItemId, quantity: 5 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);
  });

  it("keeps the legacy reduction endpoint working without Portal", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      customer: fixture.customerId,
      latest_invoice: null,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: {
                interval: "month",
                interval_count: 1,
                usage_type: "licensed",
                trial_period_days: null,
                meter: null,
              },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });

    const statusBefore = await readBillingStatus(fixture);
    expect(statusBefore.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: subscriptionId,
        quantity: 5,
        canReduce: true,
        canChangeInApp: true,
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
      url: successUrl,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
    const statusAfter = await readBillingStatus(fixture);
    expect(statusAfter.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 5 }),
    ]);
  });

  it("does not let a stale legacy reduction request increase live Stripe quantity", async () => {
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
      pending_update: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
          },
        ],
      },
    });

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencySubscriptionRoutes,
      })(zeroBillingConcurrencySubscriptionContract).reduce({
        params: { subscriptionId },
        body: {
          quantity: 4,
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
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
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

  it("previews and confirms a concurrency change without Portal", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-change";
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
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
    context.mocks.stripe.invoices.createPreview
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 17_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
              {
                id: `il_${randomUUID()}`,
                amount: 2000,
                pricing: { price_details: { price: TEST_PRICE_TEAM } },
                parent: {
                  subscription_item_details: { proration: false },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(4));
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: subscriptionId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 4,
          },
        ],
      },
    });

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);

    const preview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 4 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 2,
      targetQuantity: 4,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 40_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 4 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 4 }],
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 4 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      {
        items: [{ id: subscriptionItemId, quantity: 4 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);
  });

  it("previews a concurrency reduction at the next billing date", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: {
                interval: "month",
                interval_count: 1,
                usage_type: "licensed",
                trial_period_days: null,
                meter: null,
              },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      recurringConcurrencyPreviewInvoice(3),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });

    const preview = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencySubscriptionRoutes,
      })(zeroBillingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 3,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 3 }],
      },
    });

    const confirmed = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencySubscriptionRoutes,
      })(zeroBillingConcurrencySubscriptionContract).confirmChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("replaces an existing scheduled concurrency reduction", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStartUnix = 4_075_660_800;
    const schedulePhaseStartUnix = periodStartUnix + 3600;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date(periodEndUnix * 1000),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const currentItem = {
      id: subscriptionItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 5,
      current_period_start: periodStartUnix,
      current_period_end: periodEndUnix,
    };
    const subscriptionWithoutSchedule = {
      id: subscriptionId,
      pending_update: null,
      schedule: null,
      items: { data: [currentItem] },
    };
    const subscriptionWithSchedule = {
      ...subscriptionWithoutSchedule,
      schedule: scheduleId,
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(subscriptionWithoutSchedule)
      .mockResolvedValueOnce(subscriptionWithoutSchedule)
      .mockResolvedValueOnce(subscriptionWithSchedule)
      .mockResolvedValue(subscriptionWithSchedule);
    context.mocks.stripe.invoices.createPreview
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(3))
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(2));
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: schedulePhaseStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: schedulePhaseStartUnix,
          end_date: periodEndUnix,
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);

    await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const statusAfterFirstChange = await readBillingStatus(fixture);
    expect(statusAfterFirstChange.concurrencySubscriptions[0]).toMatchObject({
      quantity: 5,
      scheduledQuantity: 3,
      scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
    });

    const replacementPreview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(replacementPreview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 2,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 20_000,
      currency: "usd",
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).toHaveBeenLastCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: schedulePhaseStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
            proration_behavior: "none",
          },
        ],
      },
    });

    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const replacementOptions =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.at(-1)?.[2];
    if (
      typeof replacementOptions !== "object" ||
      replacementOptions === null ||
      !("idempotencyKey" in replacementOptions) ||
      typeof replacementOptions.idempotencyKey !== "string"
    ) {
      throw new Error("Expected replacement schedule update options");
    }

    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const retryOptions =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.at(-1)?.[2];
    if (
      typeof retryOptions !== "object" ||
      retryOptions === null ||
      !("idempotencyKey" in retryOptions) ||
      typeof retryOptions.idempotencyKey !== "string"
    ) {
      throw new Error("Expected retry schedule update options");
    }

    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledTimes(3);
    expect(retryOptions.idempotencyKey).not.toBe(
      replacementOptions.idempotencyKey,
    );
    const statusAfterReplacement = await readBillingStatus(fixture);
    expect(statusAfterReplacement.concurrencySubscriptions[0]).toMatchObject({
      quantity: 5,
      scheduledQuantity: 2,
      scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
    });
  });

  it("releases a scheduled reduction before applying an increase", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStartUnix = 4_075_660_800;
    const schedulePhaseStartUnix = periodStartUnix + 3600;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 10,
      periodEnd: new Date(periodEndUnix * 1000),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const currentItem = {
      id: subscriptionItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 10,
      current_period_start: periodStartUnix,
      current_period_end: periodEndUnix,
    };
    const scheduledSubscription = {
      id: subscriptionId,
      schedule: scheduleId,
      pending_update: null,
      latest_invoice: null,
      items: { data: [currentItem] },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: subscriptionId,
      schedule: null,
      pending_update: null,
      latest_invoice: null,
      items: { data: [{ ...currentItem, quantity: 20 }] },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: schedulePhaseStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: schedulePhaseStartUnix,
          end_date: periodEndUnix,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
        },
      ],
    });
    context.mocks.stripe.invoices.createPreview
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(10))
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 100_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 100_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(20));
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });

    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);
    const unchangedPreview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 10 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(unchangedPreview.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 10,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 100_000,
      currency: "usd",
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).toHaveBeenLastCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
          }),
        ]),
      }),
    });
    const preview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 20 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 20,
      immediateAmountCents: 100_000,
      nextRecurringAmountCents: 200_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: schedulePhaseStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 20 }],
            proration_behavior: "none",
          },
        ],
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);

    const response = await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 20 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      {
        items: [{ id: subscriptionItemId, quantity: 20 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    const releaseCall =
      context.mocks.stripe.subscriptionSchedules.release.mock
        .invocationCallOrder[0];
    const updateCall =
      context.mocks.stripe.subscriptions.update.mock.invocationCallOrder[0];
    if (releaseCall === undefined || updateCall === undefined) {
      throw new Error(
        "Expected schedule release and subscription update calls",
      );
    }
    expect(releaseCall).toBeLessThan(updateCall);
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          quantity: 10,
          scheduledQuantity: null,
        }),
      ]),
    );
  });

  it("rejects in-app concurrency changes from non-admin members", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencySubscriptionRoutes,
      })(zeroBillingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId: `sub_${randomUUID()}` },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Only org admins can manage concurrency subscriptions",
      code: "FORBIDDEN",
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("reuses a matching pending in-place update", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-existing";
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
        id: `in_${randomUUID()}`,
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
          },
        ],
      },
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
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;

    const response = await accept(
      setupApp({
        context,
        routes: zeroBillingConcurrencyCheckoutRoutes,
      })(zeroBillingConcurrencyCheckoutContract).create({
        body: {
          quantity: 1,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
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
            has_more: false,
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

  it("adds concurrency to the Plan subscription for a zero token with billing write capability", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    await seedMemberRole({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_end: 4_102_444_800,
          },
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
            current_period_end: 4_102_444_800,
          },
        ],
      },
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
      url: `${APP_ORIGIN}/billing?concurrency=success`,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
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

  it("cancels and restores a shared concurrency item without canceling the Plan", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: zeroBillingConcurrencySubscriptionRoutes,
    })(zeroBillingConcurrencySubscriptionContract);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      phases: [
        { start_date: periodStartUnix, end_date: periodEndUnix },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });

    await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith(
      { from_subscription: fixture.subscriptionId },
      { idempotencyKey: expect.any(String) },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    let status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    const scheduledItemEvent = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: scheduleId,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 2,
                current_period_end: periodEndUnix,
              },
            ],
          },
        },
        previous_attributes: {},
      },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
      scheduledItemEvent,
    );
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(scheduledItemEvent),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      phases: [
        { start_date: periodStartUnix, end_date: periodEndUnix },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
            ],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
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
