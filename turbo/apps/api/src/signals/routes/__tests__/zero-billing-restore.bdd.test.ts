import { randomUUID } from "node:crypto";

import { zeroBillingRestoreContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
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

// BDD migration of the legacy `zero-billing-restore.test.ts`.
// The 8 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// preconditions chain (503 STRIPE_SECRET_KEY unset → 401
// unauth → 403 non-admin → 409 no subscription → 409
// subscription not scheduled for cancellation), (2) 200
// restore cancellation chain (200 restores a subscription
// scheduled for cancellation + Stripe update called with
// `{cancel_at_period_end: false}` + DB row updated → 200
// restores a scheduled downgrade by releasing the
// subscription schedule + Stripe release called + DB row
// updated), (3) 200 payment-method chain (200 returns setup
// checkout URL when restore requires a payment method +
// Stripe checkout session called with the expected args).
//
// Service-Level Exception: the `orgMetadata` row written by
// the route is read directly via `writeDb$` because no
// public follow-up GET endpoint exists for a single org
// metadata row.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const APP_ORIGIN = "http://app.localhost:3002";

function mockSubscriptionWithPaymentMethod(
  subId: string,
  customerId: string,
): void {
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
    id: subId,
    customer: customerId,
    default_payment_method: "pm_test",
  });
}

describe("BDD POST /api/zero/billing/restore — preconditions chain", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  });

  it("gwt-wt-wt: 503 STRIPE_SECRET_KEY unset → 401 unauth → 403 non-admin → 409 no subscription → 409 subscription not scheduled for cancellation", async () => {
    // Given: STRIPE_SECRET_KEY is unset.
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    // When + Then: 503 — billing not configured.
    const noKey = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: {},
      }),
      [503],
    );
    expect(noKey.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });

    // Given: STRIPE_SECRET_KEY is set + no auth.
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    // When + Then: 401.
    const noAuth = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: {},
      }),
      [401],
    );
    expect(noAuth.status).toBe(401);

    // Given: a fresh org + a non-admin Clerk session.
    const memberFx = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(memberFx.userId, memberFx.orgId, "org:member");

    // When + Then: 403.
    const member = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });

    // Given: a fresh org + an admin Clerk session.
    const noSubFx = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(noSubFx.userId, noSubFx.orgId, "org:admin");

    // When + Then: 409 — org has no active subscription.
    const noSub = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(noSub.body).toStrictEqual({
      error: {
        message: "Org has no active subscription",
        code: "CONFLICT",
      },
    });

    // Given: an org with a subscription not scheduled for
    // cancellation.
    const notScheduledSubId = `sub-not-scheduled-${randomUUID().slice(0, 8)}`;
    const notScheduledFx = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: notScheduledSubId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: false,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(
      notScheduledFx.userId,
      notScheduledFx.orgId,
      "org:admin",
    );

    // When + Then: 409 — subscription has no scheduled
    // billing change + Stripe update is not called.
    const notScheduled = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(notScheduled.body).toStrictEqual({
      error: {
        message: "Subscription has no scheduled billing change",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("BDD POST /api/zero/billing/restore — 200 restore cancellation chain", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  });

  it("gwt-wt-wt: 200 restores a subscription scheduled for cancellation + Stripe update called with {cancel_at_period_end: false} + DB row updated → 200 restores a scheduled downgrade by releasing the subscription schedule + Stripe release called + DB row updated", async () => {
    // Given: a fresh org with a subscription scheduled for
    // cancellation + Stripe mocks for the update call.
    const subId = `sub-restore-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-restore-${randomUUID().slice(0, 8)}`;
    const cancelFx = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(cancelFx.userId, cancelFx.orgId, "org:admin");
    mockSubscriptionWithPaymentMethod(subId, customerId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    // When + Then: 200 — the cancellation flag is removed
    // + Stripe update is called with the expected args.
    const cancelResponse = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(cancelResponse.body).toStrictEqual({ status: "restored" });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: false },
    );

    // Then: the DB row reflects the restored state.
    const writeDb = store.set(writeDb$);
    const [cancelRow] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, cancelFx.orgId))
      .limit(1);
    expect(cancelRow?.cancelAtPeriodEnd).toBeFalsy();
    expect(cancelRow?.pendingSubscriptionScheduleId).toBeNull();
    expect(cancelRow?.pendingSubscriptionTargetTier).toBeNull();
    expect(cancelRow?.pendingSubscriptionChangeAt).toBeNull();

    // Given: a fresh org with a scheduled downgrade +
    // Stripe mocks for the schedule release call.
    const scheduleSubId = `sub-restore-schedule-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-restore-${randomUUID().slice(0, 8)}`;
    const scheduleCustomerId = `cus-restore-schedule-${randomUUID().slice(0, 8)}`;
    const scheduleFx = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: scheduleCustomerId,
          stripeSubscriptionId: scheduleSubId,
          subscriptionStatus: "active",
          tier: "team",
          cancelAtPeriodEnd: false,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
          pendingSubscriptionChangeAt: new Date("2099-07-04T00:00:00Z"),
        },
        context.signal,
      ),
    );
    mocks.clerk.session(
      scheduleFx.userId,
      scheduleFx.orgId,
      "org:admin",
    );
    mockSubscriptionWithPaymentMethod(scheduleSubId, scheduleCustomerId);
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptions.update.mockClear();

    // When + Then: 200 — the schedule is released + the
    // subscription is not updated.
    const scheduleResponse = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(scheduleResponse.body).toStrictEqual({ status: "restored" });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    // Then: the DB row reflects the restored state.
    const [scheduleRow] = await writeDb
      .select({
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, scheduleFx.orgId))
      .limit(1);
    expect(scheduleRow?.cancelAtPeriodEnd).toBeFalsy();
    expect(scheduleRow?.pendingSubscriptionScheduleId).toBeNull();
    expect(scheduleRow?.pendingSubscriptionTargetTier).toBeNull();
    expect(scheduleRow?.pendingSubscriptionChangeAt).toBeNull();
  });
});

describe("BDD POST /api/zero/billing/restore — 200 payment-method chain", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  });

  it("gwt-wt-wt: 200 returns setup checkout URL when restore requires a payment method + Stripe checkout session called with the expected args", async () => {
    // Given: a fresh org with a subscription scheduled for
    // cancellation + a Stripe subscription with no default
    // payment method + a customer with no default payment
    // method + APP_URL set.
    const subId = `sub-restore-card-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-restore-card-${randomUUID().slice(0, 8)}`;
    const returnUrl = `${APP_ORIGIN}/settings/billing`;
    const checkoutUrl = "https://checkout.stripe.com/setup/restore";
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: true,
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      customer: customerId,
      default_payment_method: null,
      default_source: null,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      deleted: false,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: checkoutUrl,
    });

    // When + Then: 200 — the response carries the checkout
    // URL + the Stripe checkout session is created with
    // the expected `mode: "setup"` args + the subscription
    // is not updated.
    const response = await accept(
      setupApp({ context })(zeroBillingRestoreContract).create({
        body: { returnUrl },
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
        purpose: "billing_restore",
        orgId: fixture.orgId,
        subscriptionId: subId,
      },
      setup_intent_data: {
        metadata: {
          purpose: "billing_restore",
          orgId: fixture.orgId,
          subscriptionId: subId,
        },
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
