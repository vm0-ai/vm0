import { randomUUID } from "node:crypto";

import { zeroBillingAutoRechargeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteAutoRechargeOrg$,
  seedAutoRechargeOrg$,
  type AutoRechargeOrgFixture,
} from "./helpers/zero-billing-auto-recharge";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/billing/auto-recharge", () => {
  const track = createFixtureTracker<AutoRechargeOrgFixture>((fixture) => {
    return store.set(deleteAutoRechargeOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the user has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns the org auto-recharge config from the api implementation", async () => {
    const fixture = await track(
      store.set(
        seedAutoRechargeOrg$,
        {
          enabled: true,
          threshold: 2000,
          amount: 10_000,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 2000,
      amount: 10_000,
    });
  });

  it("returns default config for a new org metadata row", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });

  it("returns the legacy default when the org metadata row does not exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });
});

describe("PUT /api/zero/billing/auto-recharge", () => {
  const track = createFixtureTracker<AutoRechargeOrgFixture>((fixture) => {
    return store.set(deleteAutoRechargeOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("enables auto-recharge for pro tier org", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.autoRechargeEnabled).toBeTruthy();
    expect(row?.autoRechargeThreshold).toBe(1000);
    expect(row?.autoRechargeAmount).toBe(5000);
  });

  it("triggers auto-recharge immediately when enabling below threshold", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(orgMetadata)
      .set({
        credits: 500,
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
      })
      .where(eq(orgMetadata.orgId, fixture.orgId));
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      deleted: false,
      invoice_settings: { default_payment_method: "pm_test" },
    });
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: "in_auto_recharge_enable",
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: "ii_auto_recharge_enable",
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_auto_recharge_enable",
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: "in_auto_recharge_enable",
      status: "paid",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        auto_advance: false,
        default_payment_method: "pm_test",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: fixture.orgId,
          creditsAmount: "5000",
        }),
      }),
    );
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: "in_auto_recharge_enable",
        customer: customerId,
        amount: 500,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      "in_auto_recharge_enable",
    );

    const [row] = await writeDb
      .select({ pendingAt: orgMetadata.autoRechargePendingAt })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.pendingAt).toBeInstanceOf(Date);
  });

  it("disables auto-recharge and clears pending state", async () => {
    const fixture = await track(
      store.set(
        seedAutoRechargeOrg$,
        {
          tier: "pro",
          enabled: true,
          threshold: 1000,
          amount: 5000,
          pendingAt: nowDate(),
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: false },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
        autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId))
      .limit(1);
    expect(row?.autoRechargeEnabled).toBeFalsy();
    expect(row?.autoRechargeThreshold).toBeNull();
    expect(row?.autoRechargeAmount).toBeNull();
    expect(row?.autoRechargePendingAt).toBeNull();
  });

  it("returns 400 when enabling on a suspended org", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Auto-recharge is only available for paid plans (Pro/Team)",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when enabling without threshold and amount", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    await accept(
      client.update({
        body: { enabled: true },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
  });

  it("returns 400 when amount is below minimum", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 500 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
  });

  it("returns 400 when amount exceeds the maximum", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 10_000_001 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
  });

  it("returns 400 when threshold exceeds the maximum", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    await accept(
      client.update({
        body: { enabled: true, threshold: 10_000_001, amount: 20_000_000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
  });

  it("returns 400 when threshold equals amount", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 5000, amount: 5000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });
  });

  it("returns 400 when threshold is greater than amount", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 6000, amount: 5000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });
  });

  it("returns 403 for non-admin member", async () => {
    const fixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroBillingAutoRechargeContract);

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can update auto-recharge settings",
        code: "FORBIDDEN",
      },
    });
  });
});
