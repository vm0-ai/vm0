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
        body: { targetTier: "free" },
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
        body: { targetTier: "free" },
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
        body: { targetTier: "free" },
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
        body: { targetTier: "free" },
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

  it("downgrades team to pro via subscription update", async () => {
    const subId = `sub-team-pro-${randomUUID().slice(0, 8)}`;
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
      items: {
        data: [{ id: "si_item_1", price: { id: TEST_PRICE_TEAM } }],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subId,
      items: {
        data: [{ id: "si_item_1", price: { id: TEST_PRICE_PRO } }],
      },
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
      effectiveDate: null,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      {
        items: [{ id: "si_item_1", price: TEST_PRICE_PRO }],
        proration_behavior: "always_invoice",
      },
    );
  });

  it("downgrades pro to free via cancel at period end", async () => {
    const subId = `sub-pro-free-${randomUUID().slice(0, 8)}`;
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

    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "free" },
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

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.cancelAtPeriodEnd).toBeTruthy();
  });

  it("downgrades team to free via cancel at period end", async () => {
    const subId = `sub-team-free-${randomUUID().slice(0, 8)}`;
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

    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context })(zeroBillingDowngradeContract);
    const response = await accept(
      client.create({
        body: { targetTier: "free" },
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
});
