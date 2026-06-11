import { randomUUID } from "node:crypto";

import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  deleteBillingStatusOrg$,
  seedBillingStatusOrg$,
  type BillingStatusFixture,
} from "./helpers/zero-billing-status";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";

// BDD migration of the legacy `zero-billing-status.test.ts`.
// The 22 legacy `it()`s collapse into 5 BDD `it()`s: (1)
// auth chain (401 unauthenticated → 401 authenticated
// session has no org → 403 zero token without
// `billing:read` → 200 zero token with `billing:read` →
// 200 non-admin org member), (2) basic status chain
// (200 free tier with credits + onboarding pending → 200
// preserves negative credit balance → 200 defaults when
// org row does not exist), (3) subscription + scheduling
// chain (200 subscribed org → 200 onboarding payment
// pending → 200 cancelAtPeriodEnd true → 200 scheduled
// downgrade details), (4) credit expiry data chain
// (200 creditExpiry populated for paid org with expires
// records → 200 zero creditExpiry for free org → 200
// credits minus not-yet-settled expired amount), (5)
// credit breakdown chain (200 auto_recharge → Pay as you
// go → 200 subscription_renewal at Pro → Pro plan → 200
// subscription_renewal at Team → Team plan → 200 Team
// plan leftover alongside Pro plan for downgraded org →
// 200 starter_grant → Free plan → 200 one_time_purchase
// → Promotional → 200 untracked paid-tier balance → Pay
// as you go fallback → 200 untracked free-tier balance
// merged into Free plan).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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

async function seedMemberRole(
  fixture: BillingStatusFixture,
  role: "admin" | "member" = "member",
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMembersCache).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    role,
  });
}

const track = createFixtureTracker<BillingStatusFixture>((fixture) => {
  return store.set(deleteBillingStatusOrg$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(zeroBillingStatusContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD GET /api/zero/billing/status — auth chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 authenticated session has no org → 403 zero token without `billing:read` → 200 zero token with `billing:read` → 200 non-admin org member", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(apiClient().get({ headers: {} }), [401]);
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a Clerk session with no organization.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a zero token with no `billing:read`.

    // When + Then: 403 — Missing required capability:
    // billing:read.
    const badToken = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: [],
    });
    const forbidden = await accept(
      apiClient().get({
        headers: { authorization: `Bearer ${badToken}` },
      }),
      [403],
    );
    expect(forbidden.body.error).toStrictEqual({
      message: "Missing required capability: billing:read",
      code: "FORBIDDEN",
    });

    // Given: a fixture + a zero token with `billing:read`.

    // When + Then: 200 — credits are returned.
    const goodTokenFixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    await seedMemberRole(goodTokenFixture);
    const goodToken = zeroToken({
      userId: goodTokenFixture.userId,
      orgId: goodTokenFixture.orgId,
      capabilities: ["billing:read"],
    });
    const goodTokenResponse = await accept(
      apiClient().get({
        headers: { authorization: `Bearer ${goodToken}` },
      }),
      [200],
    );
    expect(goodTokenResponse.body.credits).toBe(100_000);

    // Given: a fixture + a Clerk session as `org:member`.

    // When + Then: 200 — non-admin members can read.
    const memberFixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mocks.clerk.session(
      memberFixture.userId,
      memberFixture.orgId,
      "org:member",
    );
    const memberResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(memberResponse.status).toBe(200);
  });
});

describe("BDD GET /api/zero/billing/status — basic status chain", () => {
  it("gwt-wt-wt: 200 free tier with credits + onboarding pending → 200 preserves negative credit balance → 200 defaults when org row does not exist", async () => {
    // Given: a fixture with 100_000 credits.

    // When + Then: 200 — tier=free, credits=100_000,
    // onboardingPaymentPending=false,
    // hasSubscription=false.
    const freeFixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mocks.clerk.session(freeFixture.userId, freeFixture.orgId);
    const freeResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(freeResponse.body.tier).toBe("free");
    expect(freeResponse.body.credits).toBe(100_000);
    expect(freeResponse.body.onboardingPaymentPending).toBeFalsy();
    expect(freeResponse.body.hasSubscription).toBeFalsy();
    expect(freeResponse.body.subscriptionStatus).toBeNull();
    expect(freeResponse.body.currentPeriodEnd).toBeNull();

    // Given: a fixture with onboardingPaymentPending=true.

    // When + Then: 200 — onboardingPaymentPending=true.
    const onboardingFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        { onboardingPaymentPending: true },
        context.signal,
      ),
    );
    mocks.clerk.session(onboardingFixture.userId, onboardingFixture.orgId);
    const onboardingResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(onboardingResponse.body.onboardingPaymentPending).toBeTruthy();

    // Given: a fixture with credits=-1234.

    // When + Then: 200 — negative credit balance is
    // preserved.
    const negativeFixture = await track(
      store.set(seedBillingStatusOrg$, { credits: -1234 }, context.signal),
    );
    mocks.clerk.session(negativeFixture.userId, negativeFixture.orgId);
    const negativeResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(negativeResponse.body.credits).toBe(-1234);

    // Given: a Clerk session with no org row seeded.

    // When + Then: 200 — defaults: tier=pro-suspend,
    // credits=0, hasSubscription=false.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const defaultsResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(defaultsResponse.body.tier).toBe("pro-suspend");
    expect(defaultsResponse.body.credits).toBe(0);
    expect(defaultsResponse.body.hasSubscription).toBeFalsy();
  });
});

describe("BDD GET /api/zero/billing/status — subscription + scheduling chain", () => {
  it("gwt-wt-wt: 200 subscribed org → 200 cancelAtPeriodEnd true → 200 scheduled downgrade details", async () => {
    // Given: a pro-tier fixture with an active subscription
    // + periodEnd=2099-04-20.

    // When + Then: 200 — tier=pro, credits=100_000,
    // subscriptionStatus=active, currentPeriodEnd,
    // cancelAtPeriodEnd=false, scheduledChange=null,
    // hasSubscription=true.
    const periodEnd = new Date("2099-04-20T00:00:00Z");
    const subFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 100_000,
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: periodEnd,
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(subFixture.userId, subFixture.orgId);
    const subResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(subResponse.body.tier).toBe("pro");
    expect(subResponse.body.credits).toBe(100_000);
    expect(subResponse.body.subscriptionStatus).toBe("active");
    expect(subResponse.body.currentPeriodEnd).toBe(periodEnd.toISOString());
    expect(subResponse.body.cancelAtPeriodEnd).toBeFalsy();
    expect(subResponse.body.scheduledChange).toBeNull();
    expect(subResponse.body.hasSubscription).toBeTruthy();

    // Given: a pro-tier fixture with cancelAtPeriodEnd=true
    // + periodEnd=2099-04-20.

    // When + Then: 200 — cancelAtPeriodEnd=true +
    // scheduledChange.cancel=pro-suspend at periodEnd.
    const cancelFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: true,
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(cancelFixture.userId, cancelFixture.orgId);
    const cancelResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(cancelResponse.body.cancelAtPeriodEnd).toBeTruthy();
    expect(cancelResponse.body.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "pro-suspend",
      effectiveDate: periodEnd.toISOString(),
    });

    // Given: a team-tier fixture with
    // pendingSubscriptionTargetTier=pro +
    // pendingSubscriptionChangeAt=periodEnd.

    // When + Then: 200 — cancelAtPeriodEnd=false +
    // scheduledChange.downgrade=pro at periodEnd.
    const downgradeFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          subscription: {
            tier: "team",
            status: "active",
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: false,
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
            pendingSubscriptionScheduleId: `sched_${randomUUID()}`,
            pendingSubscriptionTargetTier: "pro",
            pendingSubscriptionChangeAt: periodEnd,
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(downgradeFixture.userId, downgradeFixture.orgId);
    const downgradeResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(downgradeResponse.body.cancelAtPeriodEnd).toBeFalsy();
    expect(downgradeResponse.body.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: periodEnd.toISOString(),
    });
  });
});

describe("BDD GET /api/zero/billing/status — credit expiry data chain", () => {
  it("gwt-wt-wt: 200 creditExpiry populated for paid org with expires records → 200 zero creditExpiry for free org → 200 credits minus not-yet-settled expired amount", async () => {
    // Given: a pro-tier fixture + 1 subscription_renewal
    // expires record (amount=20_000, remaining=15_000,
    // expiresAt=2099-05-20).

    // When + Then: 200 — creditExpiry.expiringNextCycle
    // = 15_000 + creditExpiry.nextExpiryDate +
    // creditGrants contains the renewal record.
    const periodEnd = new Date("2099-04-20T00:00:00Z");
    const expiryDate = new Date("2099-05-20T00:00:00Z");
    const expiryFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: periodEnd,
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 20_000,
              remaining: 15_000,
              expiresAt: expiryDate,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(expiryFixture.userId, expiryFixture.orgId);
    const expiryResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(expiryResponse.body.creditExpiry.expiringNextCycle).toBe(15_000);
    expect(expiryResponse.body.creditExpiry.nextExpiryDate).toBe(
      expiryDate.toISOString(),
    );
    expect(expiryResponse.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        label: "Pro plan",
        amount: 20_000,
        remaining: 15_000,
        expiresAt: expiryDate.toISOString(),
      }),
    ]);

    // Given: a free-tier fixture with no expires records.

    // When + Then: 200 — expiringNextCycle=0,
    // nextExpiryDate=null.
    const freeExpiryFixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mocks.clerk.session(freeExpiryFixture.userId, freeExpiryFixture.orgId);
    const freeExpiryResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(freeExpiryResponse.body.creditExpiry.expiringNextCycle).toBe(0);
    expect(freeExpiryResponse.body.creditExpiry.nextExpiryDate).toBeNull();

    // Given: a dormant non-subscription fixture with
    // credits=100_000 + 1 subscription_renewal expires
    // record (amount=3000, expiresAt=2026-03-01) +
    // extraGrantedCredits=3000.

    // When + Then: 200 — credits = 100_000 + 3000 − 3000
    // = 100_000 (the expired amount is subtracted before
    // reporting).
    const pastDate = new Date("2026-03-01T00:00:00Z");
    const dormantFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 100_000,
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 3000,
              expiresAt: pastDate,
            },
          ],
          extraGrantedCredits: 3000,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(dormantFixture.userId, dormantFixture.orgId);
    const dormantResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(dormantResponse.body.credits).toBe(100_000);
  });
});

describe("BDD GET /api/zero/billing/status — credit breakdown chain", () => {
  it("gwt-wt-wt: 200 auto_recharge → Pay as you go → 200 subscription_renewal at Pro → Pro plan → 200 subscription_renewal at Team → Team plan → 200 Team plan leftover alongside Pro plan for downgraded org → 200 starter_grant → Free plan → 200 one_time_purchase → Promotional → 200 untracked paid-tier balance → Pay as you go fallback → 200 untracked free-tier balance merged into Free plan", async () => {
    // Given: a pro-tier fixture with credits=40_000 + 1
    // subscription_renewal (20_000) + 2 auto_recharge
    // (10_000 each).

    // When + Then: 200 — creditBreakdown contains a
    // payAsYouGo segment at 20_000 + 2 auto_recharge
    // creditGrants.
    const autoRechargeFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 40_000,
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: new Date("2099-05-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 20_000,
              expiresAt: new Date("2099-06-20T00:00:00Z"),
            },
            {
              source: "auto_recharge",
              amount: 10_000,
              expiresAt: new Date("2999-12-31T00:00:00Z"),
            },
            {
              source: "auto_recharge",
              amount: 10_000,
              expiresAt: new Date("2999-12-31T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(autoRechargeFixture.userId, autoRechargeFixture.orgId);
    const autoRechargeResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    const payg = autoRechargeResponse.body.creditBreakdown.find((segment) => {
      return segment.category === "payAsYouGo";
    });
    expect(payg).toStrictEqual({
      category: "payAsYouGo",
      label: "Pay as you go",
      credits: 20_000,
    });
    expect(
      autoRechargeResponse.body.creditGrants.filter((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toHaveLength(2);

    // Given: a pro-tier fixture with credits=20_000 + 1
    // subscription_renewal at 20_000.

    // When + Then: 200 — creditBreakdown is exactly the
    // Pro plan segment at 20_000.
    const proPlanFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 20_000,
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: new Date("2099-05-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 20_000,
              expiresAt: new Date("2099-06-20T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(proPlanFixture.userId, proPlanFixture.orgId);
    const proPlanResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(proPlanResponse.body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
    ]);

    // Given: a team-tier fixture with credits=120_000 + 1
    // subscription_renewal at 120_000.

    // When + Then: 200 — creditBreakdown is exactly the
    // Team plan segment at 120_000.
    const teamPlanFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 120_000,
          subscription: {
            tier: "team",
            status: "active",
            currentPeriodEnd: new Date("2099-05-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 120_000,
              expiresAt: new Date("2099-06-20T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(teamPlanFixture.userId, teamPlanFixture.orgId);
    const teamPlanResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(teamPlanResponse.body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Team plan",
        credits: 120_000,
        tier: "team",
      },
    ]);

    // Given: a pro-tier fixture with credits=60_000 + 2
    // subscription_renewal records (20_000 from
    // 2099-06-20 + 120_000 from 2099-07-20 with
    // remaining=40_000).

    // When + Then: 200 — creditBreakdown has both Pro
    // plan (20_000) and Team plan leftover (40_000).
    const downgradeFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 20_000 + 40_000,
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: new Date("2099-05-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 20_000,
              expiresAt: new Date("2099-06-20T00:00:00Z"),
            },
            {
              source: "subscription_renewal",
              amount: 120_000,
              remaining: 40_000,
              expiresAt: new Date("2099-07-20T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(downgradeFixture.userId, downgradeFixture.orgId);
    const downgradeResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(downgradeResponse.body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
      {
        category: "plan",
        label: "Team plan",
        credits: 40_000,
        tier: "team",
      },
    ]);

    // Given: a fixture with credits=10_000 + 1
    // starter_grant expires record at 10_000.

    // When + Then: 200 — creditBreakdown has a Free plan
    // segment at 10_000.
    const starterFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 10_000,
          expiresRecords: [
            {
              source: "starter_grant",
              amount: 10_000,
              expiresAt: new Date("2099-12-31T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(starterFixture.userId, starterFixture.orgId);
    const starterResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    const free = starterResponse.body.creditBreakdown.find((segment) => {
      return segment.category === "free";
    });
    expect(free).toStrictEqual({
      category: "free",
      label: "Free plan",
      credits: 10_000,
    });

    // Given: a fixture with credits=5_000 + 1
    // one_time_purchase expires record at 5_000.

    // When + Then: 200 — creditBreakdown has a
    // Promotional segment at 5_000.
    const promoFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 5000,
          expiresRecords: [
            {
              source: "one_time_purchase",
              amount: 5000,
              expiresAt: new Date("2099-12-31T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(promoFixture.userId, promoFixture.orgId);
    const promoResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    const promo = promoResponse.body.creditBreakdown.find((segment) => {
      return segment.category === "promotional";
    });
    expect(promo).toStrictEqual({
      category: "promotional",
      label: "Promotional",
      credits: 5000,
    });

    // Given: a pro-tier fixture with credits=25_000 + 1
    // subscription_renewal at 20_000 (5_000 untracked).

    // When + Then: 200 — creditBreakdown has Pro plan
    // (20_000) + Pay as you go (5_000) + no
    // auto_recharge creditGrants.
    const untrackedPaidFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 25_000,
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: new Date("2099-05-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          expiresRecords: [
            {
              source: "subscription_renewal",
              amount: 20_000,
              expiresAt: new Date("2099-06-20T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(
      untrackedPaidFixture.userId,
      untrackedPaidFixture.orgId,
    );
    const untrackedPaidResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    expect(untrackedPaidResponse.body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
      {
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: 5000,
      },
    ]);
    expect(
      untrackedPaidResponse.body.creditGrants.some((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toBeFalsy();

    // Given: a fixture with credits=12_000 + 1
    // starter_grant at 10_000 (2_000 untracked).

    // When + Then: 200 — creditBreakdown has Free plan
    // at 12_000 + no Pay as you go segment.
    const untrackedFreeFixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 12_000,
          expiresRecords: [
            {
              source: "starter_grant",
              amount: 10_000,
              expiresAt: new Date("2099-12-31T00:00:00Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(
      untrackedFreeFixture.userId,
      untrackedFreeFixture.orgId,
    );
    const untrackedFreeResponse = await accept(
      apiClient().get({ headers: sessionHeaders() }),
      [200],
    );
    const freeUntracked = untrackedFreeResponse.body.creditBreakdown.find(
      (segment) => {
        return segment.category === "free";
      },
    );
    expect(freeUntracked).toStrictEqual({
      category: "free",
      label: "Free plan",
      credits: 12_000,
    });
    expect(
      untrackedFreeResponse.body.creditBreakdown.find((segment) => {
        return segment.category === "payAsYouGo";
      }),
    ).toBeUndefined();
  });
});
