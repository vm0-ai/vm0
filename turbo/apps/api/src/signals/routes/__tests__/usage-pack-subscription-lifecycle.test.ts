import { randomUUID } from "node:crypto";

import { testBillingReconciliationStateContract } from "@okouai/api-contracts/contracts/test-billing-reconciliation-state";
import type StripeSDK from "stripe";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { mockStripeClient } from "../../external/stripe-client";
import { testBillingReconciliationStateRoutes } from "../test-billing-reconciliation-state";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
  type TestUsagePackSubscriptionStateAction,
  type TestUsagePackSubscriptionStateResponse,
} from "../test-usage-pack-subscription-state";
import { webhooksStripeRoutes } from "../webhooks-stripe";

const context = testContext();

const TEST_PRICE_PRO = "price_usage_pack_lifecycle_pro";
const TEST_PRICE_TEAM = "price_usage_pack_lifecycle_team";
const TEST_PRICE_PLAN_PRO = "price_usage_pack_lifecycle_plan_pro";
const TEST_PRICE_PLAN_TEAM = "price_usage_pack_lifecycle_plan_team";
const TEST_PRICE_PACK_20 = "price_usage_pack_lifecycle_20";
const TEST_PRICE_PACK_50 = "price_usage_pack_lifecycle_50";
const TEST_PRICE_PACK_100 = "price_usage_pack_lifecycle_100";
const TEST_PRICE_PACK_200 = "price_usage_pack_lifecycle_200";

type UsagePackUsd = 20 | 50 | 100 | 200;

interface UsagePackLifecycleFixture {
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly usagePackSubscriptionId: string;
  readonly checkoutSessionId: string;
  readonly userId: string;
  readonly invitationId: string | null;
}

interface UsagePackSelection {
  readonly usagePackUsd: UsagePackUsd;
  readonly userId?: string;
  readonly invitationId?: string;
}

function priceIdForUsagePack(usagePackUsd: UsagePackUsd): string {
  switch (usagePackUsd) {
    case 20: {
      return TEST_PRICE_PACK_20;
    }
    case 50: {
      return TEST_PRICE_PACK_50;
    }
    case 100: {
      return TEST_PRICE_PACK_100;
    }
    case 200: {
      return TEST_PRICE_PACK_200;
    }
  }
}

function usagePackForPriceId(priceId: string): {
  readonly usagePackUsd: UsagePackUsd;
  readonly bonusCredits: number;
} {
  switch (priceId) {
    case TEST_PRICE_PACK_20: {
      return { usagePackUsd: 20, bonusCredits: 400 };
    }
    case TEST_PRICE_PACK_50: {
      return { usagePackUsd: 50, bonusCredits: 2600 };
    }
    case TEST_PRICE_PACK_100: {
      return { usagePackUsd: 100, bonusCredits: 8700 };
    }
    case TEST_PRICE_PACK_200: {
      return { usagePackUsd: 200, bonusCredits: 22_200 };
    }
    default: {
      throw new Error(`Unexpected usage pack Price: ${priceId}`);
    }
  }
}

function configureUsagePackEnvironment(): void {
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mockEnv("ZERO_PRICE_PRO", TEST_PRICE_PRO);
  mockEnv("ZERO_PRICE_TEAM", TEST_PRICE_TEAM);
  mockEnv("ZERO_PRICE_USAGE_PACK_PLAN_PRO", TEST_PRICE_PLAN_PRO);
  mockEnv("ZERO_PRICE_USAGE_PACK_PLAN_TEAM", TEST_PRICE_PLAN_TEAM);
  mockEnv("ZERO_PRICE_USAGE_PACK_20", TEST_PRICE_PACK_20);
  mockEnv("ZERO_PRICE_USAGE_PACK_50", TEST_PRICE_PACK_50);
  mockEnv("ZERO_PRICE_USAGE_PACK_100", TEST_PRICE_PACK_100);
  mockEnv("ZERO_PRICE_USAGE_PACK_200", TEST_PRICE_PACK_200);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_usage_pack_lifecycle");
}

function usagePackMetadata(fixture: UsagePackLifecycleFixture) {
  return {
    orgId: fixture.orgId,
    tier: "pro",
    priceId: TEST_PRICE_PLAN_PRO,
    purpose: "usage_pack_subscription",
    usagePackSubscriptionId: fixture.usagePackSubscriptionId,
  };
}

function period(offsetDays: number): {
  readonly start: number;
  readonly end: number;
} {
  const start = Math.floor(now() / 1000) + offsetDays * 86_400;
  return { start, end: start + 30 * 86_400 };
}

function stripeSubscription(
  fixture: UsagePackLifecycleFixture,
  paidPeriod: { readonly start: number; readonly end: number },
  quantities: ReadonlyMap<string, number>,
  options?: {
    readonly cancelAtPeriodEnd?: boolean;
    readonly status?: string;
  },
) {
  const cancelAtPeriodEnd = options?.cancelAtPeriodEnd ?? false;
  return {
    id: fixture.subscriptionId,
    customer: fixture.customerId,
    status: options?.status ?? "active",
    cancel_at: cancelAtPeriodEnd ? paidPeriod.end : null,
    cancel_at_period_end: cancelAtPeriodEnd,
    schedule: null,
    trial_end: null,
    metadata: usagePackMetadata(fixture),
    items: {
      data: [
        {
          price: { id: TEST_PRICE_PLAN_PRO },
          quantity: 1,
          current_period_start: paidPeriod.start,
          current_period_end: paidPeriod.end,
        },
        ...[...quantities].map(([priceId, quantity]) => {
          return {
            price: { id: priceId },
            quantity,
            current_period_start: paidPeriod.start,
            current_period_end: paidPeriod.end,
          };
        }),
      ],
    },
  };
}

function paidInvoice(
  fixture: UsagePackLifecycleFixture,
  args: {
    readonly invoiceId: string;
    readonly paidPeriod: { readonly start: number; readonly end: number };
    readonly quantities: ReadonlyMap<string, number>;
    readonly fraction?: number;
    readonly linePeriodEnd?: number;
  },
) {
  const metadata = usagePackMetadata(fixture);
  return {
    id: args.invoiceId,
    customer: fixture.customerId,
    metadata,
    status: "paid",
    paid: true,
    parent: {
      subscription_details: {
        subscription: fixture.subscriptionId,
        metadata,
      },
    },
    lines: {
      has_more: false,
      data: [...args.quantities].map(([priceId, quantity]) => {
        const configuration = usagePackForPriceId(priceId);
        const fullAmount = configuration.usagePackUsd * 100 * quantity;
        const amount = Math.round(fullAmount * (args.fraction ?? 1));
        return {
          id: `il_${randomUUID()}`,
          amount,
          subtotal: amount,
          quantity,
          price: { id: priceId },
          period: {
            start: args.paidPeriod.start,
            end: args.linePeriodEnd ?? args.paidPeriod.end,
          },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              proration: (args.fraction ?? 1) < 1,
            },
          },
        };
      }),
    },
  };
}

function stripeEvent(type: string, object: object) {
  return {
    id: `evt_${randomUUID()}`,
    type,
    created: Math.floor(now() / 1000),
    data: { object },
  };
}

async function postStripeEvent(
  event: object,
  expectedStatus: 200 | 500,
): Promise<void> {
  context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
  const response = await createApp({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  }).request("/api/webhooks/stripe", {
    method: "POST",
    body: JSON.stringify(event),
    headers: { "stripe-signature": "t=1,v1=usage-pack-lifecycle" },
  });
  expect(response.status).toBe(expectedStatus);
}

async function reconcileBillingOrganization(orgId: string) {
  const response = await accept(
    setupApp({
      context,
      routes: testBillingReconciliationStateRoutes,
    })(testBillingReconciliationStateContract).reconcile({
      body: { orgIds: [orgId] },
    }),
    [200],
  );
  return response.body;
}

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

async function readUsagePackState(fixture: UsagePackLifecycleFixture) {
  const response = await usagePackStateAction({
    action: "read",
    orgId: fixture.orgId,
    usagePackSubscriptionId: fixture.usagePackSubscriptionId,
  });
  if (response.action !== "read") {
    throw new Error("Usage pack test state did not return a read response");
  }
  return response.state;
}

async function seedUsagePackLifecycle(
  selections: readonly UsagePackSelection[],
): Promise<UsagePackLifecycleFixture> {
  const orgId = `org_usage_pack_${randomUUID()}`;
  const customerId = `cus_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  const checkoutSessionId = `cs_${randomUUID()}`;
  const userId =
    selections.find((selection) => {
      return selection.userId !== undefined;
    })?.userId ?? `user_${randomUUID()}`;
  const invitationId =
    selections.find((selection) => {
      return selection.invitationId !== undefined;
    })?.invitationId ?? null;

  await seedOrgMetadata({ orgId, tier: "limited-free-1", credits: 0 });
  const seeded = await usagePackStateAction({
    action: "seed",
    orgId,
    tier: "pro",
    stripePlanPriceId: TEST_PRICE_PLAN_PRO,
    stripeCustomerId: customerId,
    stripeCheckoutSessionId: checkoutSessionId,
    allocations: selections.map((selection) => {
      return {
        userId: selection.userId ?? null,
        invitationId: selection.invitationId ?? null,
        usagePackUsd: selection.usagePackUsd,
        stripePriceId: priceIdForUsagePack(selection.usagePackUsd),
      };
    }),
  });
  if (seeded.action !== "seeded") {
    throw new Error("Failed to seed usage pack subscription");
  }
  const usagePackSubscriptionId = seeded.usagePackSubscriptionId;
  onTestFinished(async () => {
    await usagePackStateAction({
      action: "cleanup",
      orgId,
      usagePackSubscriptionId,
      deleteGrants: true,
      deleteOrgMetadata: true,
    });
  });
  return {
    orgId,
    customerId,
    subscriptionId,
    usagePackSubscriptionId,
    checkoutSessionId,
    userId,
    invitationId,
  };
}

function mockUsagePackPriceCatalog(
  bonusCredits: (priceId: string) => string = (priceId) => {
    return String(usagePackForPriceId(priceId).bonusCredits);
  },
): void {
  context.mocks.stripe.prices.retrieve.mockImplementation((priceId) => {
    if (typeof priceId !== "string") {
      throw new Error("Expected a Stripe Price ID");
    }
    const configuration = usagePackForPriceId(priceId);
    return Promise.resolve({
      id: priceId,
      active: false,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: configuration.usagePackUsd * 100,
      product: {
        id: `prod_${configuration.usagePackUsd}`,
        metadata: { bonusCredits: bonusCredits(priceId) },
      },
    });
  });
}

async function grantRows(fixture: UsagePackLifecycleFixture) {
  return (await readUsagePackState(fixture)).grants;
}

describe("usage pack subscription Stripe lifecycle", () => {
  beforeEach(() => {
    configureUsagePackEnvironment();
    mockUsagePackPriceCatalog();
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (sessionId) => {
        return Promise.resolve({
          id: typeof sessionId === "string" ? sessionId : "cs_unknown",
          status: "expired",
          customer: null,
          subscription: null,
          metadata: null,
        });
      },
    );
  });

  it("waits for invoice.paid, grants member buckets once, and renews while the switch is off", async () => {
    const userId = `user_${randomUUID()}`;
    const invitationId = `inv_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
      { invitationId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 2]]);
    let paidPeriod = period(0);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );

    await postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: fixture.checkoutSessionId,
        customer: fixture.customerId,
        subscription: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );
    await postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscription(fixture, paidPeriod, quantities),
      ),
      200,
    );

    await expect(grantRows(fixture)).resolves.toHaveLength(0);
    const beforePayment = (await readUsagePackState(fixture)).org;
    expect(beforePayment).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        stripeSubscriptionId: fixture.subscriptionId,
      }),
    );

    const firstInvoiceId = `in_${randomUUID()}`;
    const firstInvoice = paidInvoice(fixture, {
      invoiceId: firstInvoiceId,
      paidPeriod,
      quantities,
    });
    await postStripeEvent(stripeEvent("invoice.paid", firstInvoice), 200);
    await postStripeEvent(stripeEvent("invoice.paid", firstInvoice), 200);

    await expect(grantRows(fixture)).resolves.toStrictEqual([
      {
        userId,
        grantType: "bonus",
        originalAmount: 400,
        expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
      },
      {
        userId,
        grantType: "purchased",
        originalAmount: 20_000,
        expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
      },
    ]);
    const allocationRows = (await readUsagePackState(fixture)).allocations;
    expect(allocationRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId,
          invitationId: null,
          status: "active",
        }),
        expect.objectContaining({
          userId: null,
          invitationId,
          status: "pending_invitation",
        }),
      ]),
    );
    const activatedOrg = (await readUsagePackState(fixture)).org;
    expect(activatedOrg).toStrictEqual(
      expect.objectContaining({ tier: "pro", credits: 0 }),
    );

    paidPeriod = period(30);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );
    const renewalInvoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    await postStripeEvent(stripeEvent("invoice.paid", renewalInvoice), 200);
    await expect(grantRows(fixture)).resolves.toHaveLength(4);
    const renewalGrantRows = await grantRows(fixture);
    expect(
      renewalGrantRows.filter((grant) => {
        return (
          grant.expiresAt === new Date(paidPeriod.end * 1000).toISOString()
        );
      }),
    ).toHaveLength(2);
    expect(
      (await readUsagePackState(fixture)).fulfillmentInvoiceIds,
    ).toHaveLength(2);
  });

  it("floors prorated purchased and bonus grants independently", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 50 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_50, 1]]);
    const paidPeriod = period(0);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod,
          quantities,
          fraction: 1667 / 5000,
        }),
      ),
      200,
    );

    await expect(grantRows(fixture)).resolves.toStrictEqual([
      {
        userId,
        grantType: "bonus",
        originalAmount: 866,
        expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
      },
      {
        userId,
        grantType: "purchased",
        originalAmount: 16_670,
        expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
      },
    ]);
  });

  it("rejects an invoice line that extends beyond the current Stripe period", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );
    const invoiceId = `in_${randomUUID()}`;

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId,
          paidPeriod,
          quantities,
          fraction: 0.5,
          linePeriodEnd: paidPeriod.end + 1,
        }),
      ),
      500,
    );
    await expect(grantRows(fixture)).resolves.toHaveLength(0);
    expect(
      (await readUsagePackState(fixture)).fulfillmentInvoiceIds,
    ).toHaveLength(0);

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId,
          paidPeriod,
          quantities,
          fraction: 0.5,
        }),
      ),
      200,
    );
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
  });

  it("fulfills an older paid invoice without rewinding the current period", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const olderPeriod = period(0);
    const currentPeriod = period(30);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, currentPeriod, quantities),
    );

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod: currentPeriod,
          quantities,
        }),
      ),
      200,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod: olderPeriod,
          quantities,
        }),
      ),
      200,
    );

    await expect(grantRows(fixture)).resolves.toHaveLength(4);
    const subscription = (await readUsagePackState(fixture)).subscription;
    expect(subscription).toStrictEqual(
      expect.objectContaining({
        currentPeriodStart: new Date(currentPeriod.start * 1000).toISOString(),
        currentPeriodEnd: new Date(currentPeriod.end * 1000).toISOString(),
      }),
    );
  });

  it("keeps paid grants through scheduled cancellation and uses the existing terminal fallback", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    let currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod,
          quantities,
        }),
      ),
      200,
    );

    currentSubscription = stripeSubscription(fixture, paidPeriod, quantities, {
      cancelAtPeriodEnd: true,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.updated", currentSubscription),
      200,
    );
    const scheduledOrg = (await readUsagePackState(fixture)).org;
    expect(scheduledOrg).toStrictEqual(
      expect.objectContaining({ tier: "pro", cancelAtPeriodEnd: true }),
    );
    await expect(grantRows(fixture)).resolves.toHaveLength(2);

    await postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        id: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );
    const canceledState = await readUsagePackState(fixture);
    expect(canceledState.org).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        stripeSubscriptionId: null,
      }),
    );
    const [allocation] = canceledState.allocations;
    expect(allocation?.status).toBe("inactive");
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
  });

  it("settles a paid invoice delivered after deletion without reactivating the subscription", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    let currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: fixture.checkoutSessionId,
        customer: fixture.customerId,
        subscription: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );

    currentSubscription = stripeSubscription(fixture, paidPeriod, quantities, {
      status: "canceled",
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        id: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );

    const invoiceId = `in_${randomUUID()}`;
    const invoice = paidInvoice(fixture, {
      invoiceId,
      paidPeriod,
      quantities,
    });
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);

    const state = await readUsagePackState(fixture);
    expect(state.grants).toHaveLength(2);
    expect(state.fulfillmentInvoiceIds).toStrictEqual([invoiceId]);
    expect(state.subscription).toStrictEqual(
      expect.objectContaining({
        subscriptionStatus: "canceled",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    );
    const [allocation] = state.allocations;
    expect(allocation).toStrictEqual(
      expect.objectContaining({
        status: "inactive",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    );
    expect(state.org).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        stripeSubscriptionId: null,
      }),
    );
  });

  it("reconciles an expired payment failure through the existing billing fallback", async () => {
    mockNow(new Date("2999-02-01T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(-32);
    let currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod,
          quantities,
        }),
      ),
      200,
    );

    currentSubscription = stripeSubscription(fixture, paidPeriod, quantities, {
      status: "past_due",
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.updated", currentSubscription),
      200,
    );
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });

    await expect(
      reconcileBillingOrganization(fixture.orgId),
    ).resolves.toStrictEqual(expect.objectContaining({ success: true }));
    const downgradedOrg = (await readUsagePackState(fixture)).org;
    expect(downgradedOrg).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        subscriptionStatus: "past_due",
      }),
    );
  });

  it("reconciles a completed Checkout Session and missed paid invoice without enabling enrollment", async () => {
    mockNow(new Date("2999-03-01T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    const subscription = stripeSubscription(fixture, paidPeriod, quantities);
    const invoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    await usagePackStateAction({
      action: "set-updated-at",
      orgId: fixture.orgId,
      usagePackSubscriptionId: fixture.usagePackSubscriptionId,
      updatedAt: new Date(now() - 10 * 60 * 1000).toISOString(),
    });
    const sentinel = await seedUsagePackLifecycle([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    await usagePackStateAction({
      action: "set-updated-at",
      orgId: sentinel.orgId,
      usagePackSubscriptionId: sentinel.usagePackSubscriptionId,
      updatedAt: new Date(now() - 10 * 60 * 1000).toISOString(),
    });
    const sentinelBefore = await readUsagePackState(sentinel);
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (sessionId) => {
        if (sessionId === fixture.checkoutSessionId) {
          return Promise.resolve({
            id: fixture.checkoutSessionId,
            status: "complete",
            customer: fixture.customerId,
            subscription: fixture.subscriptionId,
            metadata: usagePackMetadata(fixture),
          });
        }
        return Promise.resolve({
          id: typeof sessionId === "string" ? sessionId : "cs_unknown",
          status: "expired",
          customer: null,
          subscription: null,
          metadata: null,
        });
      },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [invoice] });

    await expect(
      reconcileBillingOrganization(fixture.orgId),
    ).resolves.toStrictEqual({ success: true, downgraded: 0 });
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
    const reconciled = (await readUsagePackState(fixture)).subscription;
    expect(reconciled).toStrictEqual(
      expect.objectContaining({
        stripeSubscriptionId: fixture.subscriptionId,
        currentPeriodEnd: new Date(paidPeriod.end * 1000).toISOString(),
      }),
    );
    await expect(readUsagePackState(sentinel)).resolves.toStrictEqual(
      sentinelBefore,
    );
  });

  it("rolls back invalid Product metadata and succeeds when Stripe retries", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    const invoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );
    let validProductMetadata = false;
    mockUsagePackPriceCatalog(() => {
      return validProductMetadata ? "400" : "not-an-integer";
    });

    await postStripeEvent(stripeEvent("invoice.paid", invoice), 500);
    await expect(grantRows(fixture)).resolves.toHaveLength(0);
    const pendingState = await readUsagePackState(fixture);
    expect(pendingState.fulfillmentInvoiceIds).toHaveLength(0);
    const [pendingAllocation] = pendingState.allocations;
    expect(pendingAllocation?.status).toBe("pending_payment");

    validProductMetadata = true;
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
  });
});
