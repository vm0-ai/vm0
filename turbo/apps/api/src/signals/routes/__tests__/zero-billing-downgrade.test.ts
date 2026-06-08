import { randomUUID } from "node:crypto";

import { zeroBillingDowngradeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/zero-billing-invoices";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";

describe("POST /api/zero/billing/downgrade", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: [TEST_PRICE_PRO], team: [TEST_PRICE_TEAM] }),
    );
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
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
    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: {},
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin org member", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
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

  it("returns 400 for invalid targetTier", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await client.create({
      body: { targetTier: "team" as "pro" },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
  });

  it("returns 409 when org has no subscription", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Org has no active subscription",
        code: "CONFLICT",
      },
    });
  });

  it("returns 400 when target tier is same or higher", async () => {
    const subId = `sub-same-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Cannot downgrade from pro to pro: target tier is same or higher",
        code: "BAD_REQUEST",
      },
    });
  });

  it("schedules team to pro at period end", async () => {
    const subId = `sub-team-pro-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const scheduleId = `sched-team-pro-${randomUUID().slice(0, 8)}`;
    const discountId = `di-team-pro-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      default_payment_method: "pm_card",
      discounts: [discountId],
      items: {
        data: [
          {
            id: "si_item_1",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: periodStart,
        end_date: periodEnd,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith({
      from_subscription: subId,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
        {
          start_date: periodEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
      ],
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeFalsy();
    expect(row?.pendingSubscriptionScheduleId).toBe(scheduleId);
    expect(row?.pendingSubscriptionTargetTier).toBe("pro");
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      new Date(periodEnd * 1000).toISOString(),
    );
    expect(row?.currentPeriodEnd?.toISOString()).toBe(
      new Date(periodEnd * 1000).toISOString(),
    );
  });

  it("reuses an existing Stripe schedule when scheduling team to pro", async () => {
    const subId = `sub-team-existing-schedule-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const scheduleId = `sched-existing-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: scheduleId,
      default_payment_method: "pm_card",
      items: {
        data: [
          {
            id: "si_item_1",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none",
        },
        {
          start_date: periodEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.pendingSubscriptionScheduleId).toBe(scheduleId);
    expect(row?.pendingSubscriptionTargetTier).toBe("pro");
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      new Date(periodEnd * 1000).toISOString(),
    );
  });

  it("returns setup checkout URL when team to pro needs a payment method", async () => {
    const subId = `sub-team-pro-no-card-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-team-pro-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const checkoutUrl = "https://checkout.stripe.com/setup/downgrade";
    const returnUrl = "https://app.vm0.ai/settings?settings=billing";
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      customer: customerId,
      default_payment_method: null,
      default_source: null,
      discounts: [],
      items: {
        data: [
          {
            id: "si_item_1",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_setup_downgrade",
      url: checkoutUrl,
    });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro", returnUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "payment_method_required",
      checkoutUrl,
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: returnUrl,
      cancel_url: returnUrl,
      metadata: {
        purpose: "billing_downgrade",
        orgId: fixture.orgId,
        subscriptionId: subId,
        targetTier: "pro",
      },
      setup_intent_data: {
        metadata: {
          purpose: "billing_downgrade",
          orgId: fixture.orgId,
          subscriptionId: subId,
          targetTier: "pro",
        },
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("downgrades pro to pro-suspend via cancel at period end", async () => {
    const subId = `sub-pro-suspend-${randomUUID().slice(0, 8)}`;
    const periodEnd = new Date(now() + 30 * 86_400 * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          currentPeriodEnd: periodEnd,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const periodStartUnix = Math.floor((now() - 86_400 * 1000) / 1000);
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_pro",
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
            quantity: 1,
            price: {
              id: TEST_PRICE_PRO,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: periodEnd.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: true },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeTruthy();
    expect(row?.pendingSubscriptionScheduleId).toBeNull();
    expect(row?.pendingSubscriptionTargetTier).toBe("pro-suspend");
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      periodEnd.toISOString(),
    );
  });

  it("downgrades team to pro-suspend via cancel at period end", async () => {
    const subId = `sub-team-suspend-${randomUUID().slice(0, 8)}`;
    const periodEnd = new Date(now() + 30 * 86_400 * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd: periodEnd,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const periodStartUnix = Math.floor((now() - 86_400 * 1000) / 1000);
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: periodEnd.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: true },
    );
  });

  it("preserves fixed-term team access when cancelling to pro-suspend", async () => {
    const subId = `sub-team-fixed-term-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const finalEnd = 1_790_587_151;
    const finalEndDate = new Date(finalEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd: finalEndDate,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: finalEndDate.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      {
        cancel_at: finalEnd,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeTruthy();
    expect(row?.currentPeriodEnd?.toISOString()).toBe(
      finalEndDate.toISOString(),
    );
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      finalEndDate.toISOString(),
    );
  });

  it("does not overwrite an existing subscription cancel_at", async () => {
    const subId = `sub-pro-fixed-cancel-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const cancelAt = 1_790_587_151;
    const cancelAtDate = new Date(cancelAt * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          currentPeriodEnd: new Date(periodEnd * 1000),
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      cancel_at: cancelAt,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_pro",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_PRO,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: cancelAtDate.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeTruthy();
    expect(row?.currentPeriodEnd?.toISOString()).toBe(
      cancelAtDate.toISOString(),
    );
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      cancelAtDate.toISOString(),
    );
  });

  it("preserves external schedule phases when cancelling at schedule end", async () => {
    const subId = `sub-pro-external-schedule-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-external-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const finalEnd = 1_790_587_151;
    const finalEndDate = new Date(finalEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          currentPeriodEnd: new Date(periodEnd * 1000),
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: "si_item_pro",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_PRO,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      current_phase: { start_date: periodStart, end_date: finalEnd },
      phases: [
        { start_date: periodStart, end_date: periodEnd },
        { start_date: periodEnd, end_date: finalEnd },
      ],
      end_behavior: "release",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: finalEndDate.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeTruthy();
    expect(row?.currentPeriodEnd?.toISOString()).toBe(
      finalEndDate.toISOString(),
    );
    expect(row?.pendingSubscriptionScheduleId).toBe(scheduleId);
    expect(row?.pendingSubscriptionTargetTier).toBe("pro-suspend");
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      finalEndDate.toISOString(),
    );
  });

  it("replaces a pending team to pro schedule with cancellation at period end", async () => {
    const subId = `sub-team-schedule-suspend-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-team-suspend-${randomUUID().slice(0, 8)}`;
    const discountId = `di-team-suspend-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const currentPeriodEnd = new Date(periodEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
          pendingSubscriptionChangeAt: currentPeriodEnd,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: scheduleId,
      discounts: [discountId],
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "pro-suspend" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: currentPeriodEnd.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
      ],
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeTruthy();
    expect(row?.pendingSubscriptionScheduleId).toBe(scheduleId);
    expect(row?.pendingSubscriptionTargetTier).toBe("pro-suspend");
    expect(row?.pendingSubscriptionChangeAt?.toISOString()).toBe(
      currentPeriodEnd.toISOString(),
    );
  });
});
