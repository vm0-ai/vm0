import { randomUUID } from "node:crypto";

import { zeroBillingRestoreContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
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

describe("POST /api/zero/billing/restore", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
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
    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
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

    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
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

  it("returns 409 when org has no subscription", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
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

  it("returns 409 when subscription is not scheduled for cancellation", async () => {
    const subId = `sub-not-scheduled-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: false,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Subscription has no scheduled billing change",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("restores a subscription scheduled for cancellation", async () => {
    const subId = `sub-restore-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: false },
    );

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
    expect(row?.cancelAtPeriodEnd).toBeFalsy();
    expect(row?.pendingSubscriptionScheduleId).toBeNull();
    expect(row?.pendingSubscriptionTargetTier).toBeNull();
    expect(row?.pendingSubscriptionChangeAt).toBeNull();
  });

  it("restores a scheduled downgrade by releasing its subscription schedule", async () => {
    const subId = `sub-restore-schedule-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-restore-${randomUUID().slice(0, 8)}`;
    const changeAt = new Date("2099-07-04T00:00:00Z");
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          cancelAtPeriodEnd: false,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
          pendingSubscriptionChangeAt: changeAt,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context })(zeroBillingRestoreContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
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
    expect(row?.cancelAtPeriodEnd).toBeFalsy();
    expect(row?.pendingSubscriptionScheduleId).toBeNull();
    expect(row?.pendingSubscriptionTargetTier).toBeNull();
    expect(row?.pendingSubscriptionChangeAt).toBeNull();
  });
});
