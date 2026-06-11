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

// BDD migration of the legacy
// `zero-billing-auto-recharge.test.ts`. The 17 legacy
// `it()`s collapse into 4 BDD `it()`s: (1) GET chain
// (401 unauthenticated → 401 user has no active org → 200
// returns the org config → 200 returns default config for
// new metadata row → 200 returns legacy default when org
// metadata row does not exist), (2) PUT enable + immediate
// trigger chain (401 unauthenticated → 200 enables for pro
// tier org → 200 triggers immediately when enabling below
// threshold → 200 disables + clears pending state), (3)
// PUT validation chain (400 enabling on suspended org →
// 400 enabling without threshold/amount → 400 amount below
// minimum → 400 amount exceeds max → 400 threshold
// exceeds max), (4) PUT threshold + role chain (400
// threshold equals amount → 400 threshold greater than
// amount → 403 non-admin member).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const track = createFixtureTracker<AutoRechargeOrgFixture>((fixture) => {
  return store.set(deleteAutoRechargeOrg$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(zeroBillingAutoRechargeContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD GET /api/zero/billing/auto-recharge — auth + read chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 user has no active org → 200 returns the org config → 200 returns default config for new metadata row → 200 returns legacy default when org metadata row does not exist", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(apiClient().get({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture with auto-recharge enabled at
    // threshold=2000 + amount=10_000.

    // When + Then: 200 — the saved config is returned.
    const configuredFixture = await track(
      store.set(
        seedAutoRechargeOrg$,
        { enabled: true, threshold: 2000, amount: 10_000 },
        context.signal,
      ),
    );
    mocks.clerk.session(configuredFixture.userId, configuredFixture.orgId);
    const configuredResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(configuredResponse.body).toStrictEqual({
      enabled: true,
      threshold: 2000,
      amount: 10_000,
    });

    // Given: a fresh org metadata row with no auto-recharge
    // settings.

    // When + Then: 200 — defaults: enabled=false,
    // threshold=null, amount=null.
    const defaultFixture = await track(
      store.set(seedAutoRechargeOrg$, {}, context.signal),
    );
    mocks.clerk.session(defaultFixture.userId, defaultFixture.orgId);
    const defaultResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(defaultResponse.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    // Given: a Clerk session with no org row seeded.

    // When + Then: 200 — legacy default returned.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const legacyResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(legacyResponse.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });
});

describe("BDD PUT /api/zero/billing/auto-recharge — enable + immediate trigger + disable chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 200 enables for pro tier org → 200 triggers immediately when enabling below threshold → 200 disables + clears pending state", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a pro-tier fixture.

    // When + Then: 200 — auto-recharge is enabled +
    // persisted to the org metadata row.
    const enableFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(enableFixture.userId, enableFixture.orgId, "org:admin");
    const enableResponse = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(enableResponse.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });
    const enableWriteDb = store.set(writeDb$);
    const [enableRow] = await enableWriteDb
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, enableFixture.orgId))
      .limit(1);
    expect(enableRow?.autoRechargeEnabled).toBeTruthy();
    expect(enableRow?.autoRechargeThreshold).toBe(1000);
    expect(enableRow?.autoRechargeAmount).toBe(5000);

    // Given: a pro-tier fixture with credits=500 below the
    // threshold + stripe customer + default payment method.

    // When + Then: 200 — auto-recharge triggers
    // immediately + Stripe invoice/item/pay are called
    // with the expected args + autoRechargePendingAt is
    // set.
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const triggerFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    const triggerWriteDb = store.set(writeDb$);
    await triggerWriteDb
      .update(orgMetadata)
      .set({
        credits: 500,
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
      })
      .where(eq(orgMetadata.orgId, triggerFixture.orgId));
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
    mocks.clerk.session(
      triggerFixture.userId,
      triggerFixture.orgId,
      "org:admin",
    );
    const triggerResponse = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(triggerResponse.body).toStrictEqual({
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
          orgId: triggerFixture.orgId,
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
    const [triggerRow] = await triggerWriteDb
      .select({ pendingAt: orgMetadata.autoRechargePendingAt })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, triggerFixture.orgId))
      .limit(1);
    expect(triggerRow?.pendingAt).toBeInstanceOf(Date);

    // Given: a pro-tier fixture with auto-recharge enabled
    // + threshold/amount set + pendingAt set.

    // When + Then: 200 — auto-recharge is disabled +
    // threshold/amount/pendingAt are cleared.
    const disableFixture = await track(
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
    mocks.clerk.session(
      disableFixture.userId,
      disableFixture.orgId,
      "org:admin",
    );
    const disableResponse = await accept(
      apiClient().update({
        body: { enabled: false },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(disableResponse.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
    const disableWriteDb = store.set(writeDb$);
    const [disableRow] = await disableWriteDb
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
        autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, disableFixture.orgId))
      .limit(1);
    expect(disableRow?.autoRechargeEnabled).toBeFalsy();
    expect(disableRow?.autoRechargeThreshold).toBeNull();
    expect(disableRow?.autoRechargeAmount).toBeNull();
    expect(disableRow?.autoRechargePendingAt).toBeNull();
  });
});

describe("BDD PUT /api/zero/billing/auto-recharge — validation chain", () => {
  it("gwt-wt-wt: 400 enabling on suspended org → 400 enabling without threshold/amount → 400 amount below minimum → 400 amount exceeds max → 400 threshold exceeds max", async () => {
    // Given: a suspended (free-tier) fixture.

    // When + Then: 400 — Auto-recharge is only available
    // for paid plans.
    const suspendedFixture = await track(
      store.set(seedAutoRechargeOrg$, {}, context.signal),
    );
    mocks.clerk.session(
      suspendedFixture.userId,
      suspendedFixture.orgId,
      "org:admin",
    );
    const suspendedResponse = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: sessionHeaders(),
      }),
      [400],
    );
    expect(suspendedResponse.body).toStrictEqual({
      error: {
        message: "Auto-recharge is only available for paid plans (Pro/Team)",
        code: "BAD_REQUEST",
      },
    });

    // Given: a pro-tier fixture + enabled=true with no
    // threshold/amount.

    // When + Then: 400.
    const missingArgsFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(
      missingArgsFixture.userId,
      missingArgsFixture.orgId,
      "org:admin",
    );
    await accept(
      apiClient().update({
        body: { enabled: true },
        headers: sessionHeaders(),
      }),
      [400],
    );

    // Given: a pro-tier fixture + threshold=1000 +
    // amount=500 (below minimum).

    // When + Then: 400.
    const lowAmountFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(
      lowAmountFixture.userId,
      lowAmountFixture.orgId,
      "org:admin",
    );
    await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 500 },
        headers: sessionHeaders(),
      }),
      [400],
    );

    // Given: a pro-tier fixture + threshold=1000 +
    // amount=10_000_001 (above max).

    // When + Then: 400.
    const highAmountFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(
      highAmountFixture.userId,
      highAmountFixture.orgId,
      "org:admin",
    );
    await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 10_000_001 },
        headers: sessionHeaders(),
      }),
      [400],
    );

    // Given: a pro-tier fixture + threshold=10_000_001 +
    // amount=20_000_000 (threshold above max).

    // When + Then: 400.
    const highThresholdFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(
      highThresholdFixture.userId,
      highThresholdFixture.orgId,
      "org:admin",
    );
    await accept(
      apiClient().update({
        body: { enabled: true, threshold: 10_000_001, amount: 20_000_000 },
        headers: sessionHeaders(),
      }),
      [400],
    );
  });
});

describe("BDD PUT /api/zero/billing/auto-recharge — threshold + role chain", () => {
  it("gwt-wt-wt: 400 threshold equals amount → 400 threshold greater than amount → 403 non-admin member", async () => {
    // Given: a pro-tier fixture + threshold=5000 +
    // amount=5000 (threshold equals amount).

    // When + Then: 400 — must be less than amount to
    // avoid recharge loops.
    const equalFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(equalFixture.userId, equalFixture.orgId, "org:admin");
    const equalResponse = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 5000, amount: 5000 },
        headers: sessionHeaders(),
      }),
      [400],
    );
    expect(equalResponse.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });

    // Given: a pro-tier fixture + threshold=6000 +
    // amount=5000 (threshold greater than amount).

    // When + Then: 400.
    const greaterFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(
      greaterFixture.userId,
      greaterFixture.orgId,
      "org:admin",
    );
    const greaterResponse = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 6000, amount: 5000 },
        headers: sessionHeaders(),
      }),
      [400],
    );
    expect(greaterResponse.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });

    // Given: a pro-tier fixture + a Clerk session as
    // `org:member`.

    // When + Then: 403 — Only org admins can update
    // auto-recharge settings.
    const memberFixture = await track(
      store.set(seedAutoRechargeOrg$, { tier: "pro" }, context.signal),
    );
    mocks.clerk.session(
      memberFixture.userId,
      memberFixture.orgId,
      "org:member",
    );
    const memberResponse = await accept(
      apiClient().update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
        headers: sessionHeaders(),
      }),
      [403],
    );
    expect(memberResponse.body).toStrictEqual({
      error: {
        message: "Only org admins can update auto-recharge settings",
        code: "FORBIDDEN",
      },
    });
  });
});
