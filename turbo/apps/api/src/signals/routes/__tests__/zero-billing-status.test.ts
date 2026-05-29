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

describe("GET /api/zero/billing/status", () => {
  const track = createFixtureTracker<BillingStatusFixture>((fixture) => {
    return store.set(deleteBillingStatusOrg$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the user has no active org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns billing status for authenticated user", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.tier).toBe("free");
    expect(response.body.credits).toBe(100_000);
    expect(response.body.hasSubscription).toBeFalsy();
    expect(response.body.subscriptionStatus).toBeNull();
    expect(response.body.currentPeriodEnd).toBeNull();
  });

  it("returns billing status for zero tokens with billing read capability", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    await seedMemberRole(fixture);
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:read"],
    });

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.credits).toBe(100_000);
  });

  it("returns 403 for zero tokens without billing read capability", async () => {
    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: [],
    });

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Missing required capability: billing:read",
      code: "FORBIDDEN",
    });
  });

  it("returns correct data for subscribed org", async () => {
    const periodEnd = new Date("2099-04-20T00:00:00Z");
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.tier).toBe("pro");
    expect(response.body.credits).toBe(100_000);
    expect(response.body.subscriptionStatus).toBe("active");
    expect(response.body.currentPeriodEnd).toBe(periodEnd.toISOString());
    expect(response.body.cancelAtPeriodEnd).toBeFalsy();
    expect(response.body.hasSubscription).toBeTruthy();
  });

  it("returns cancelAtPeriodEnd true when set", async () => {
    const periodEnd = new Date("2099-04-20T00:00:00Z");
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.cancelAtPeriodEnd).toBeTruthy();
  });

  it("returns 200 for non-admin member", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.status).toBe(200);
  });

  it("includes creditExpiry data for paid org with expires records", async () => {
    const periodEnd = new Date("2099-04-20T00:00:00Z");
    const expiryDate = new Date("2099-05-20T00:00:00Z");
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.creditExpiry.expiringNextCycle).toBe(15_000);
    expect(response.body.creditExpiry.nextExpiryDate).toBe(
      expiryDate.toISOString(),
    );
    expect(response.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        label: "Pro plan",
        amount: 20_000,
        remaining: 15_000,
        expiresAt: expiryDate.toISOString(),
      }),
    ]);
  });

  it("returns zero creditExpiry for free org", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.creditExpiry.expiringNextCycle).toBe(0);
    expect(response.body.creditExpiry.nextExpiryDate).toBeNull();
  });

  it("displays credits minus not-yet-settled expired amount", async () => {
    // Dormant non-subscription org: a 3k expires record is past its
    // expiresAt but the inflated ledger has not yet been settled, so the
    // /status endpoint must subtract the expired amount before reporting.
    const pastDate = new Date("2026-03-01T00:00:00Z");
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    // 100_000 (seeded) + 3000 (granted) − 3000 (expired) = 100_000
    expect(response.body.credits).toBe(100_000);
  });

  it("maps auto_recharge expires records to Pay as you go segment", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const payg = response.body.creditBreakdown.find((segment) => {
      return segment.category === "payAsYouGo";
    });
    expect(payg).toStrictEqual({
      category: "payAsYouGo",
      label: "Pay as you go",
      credits: 20_000,
    });
    expect(
      response.body.creditGrants.filter((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toHaveLength(2);
  });

  it("maps subscription_renewal at Pro amount to Pro plan segment", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
    ]);
  });

  it("maps subscription_renewal at Team amount to Team plan segment", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Team plan",
        credits: 120_000,
        tier: "team",
      },
    ]);
  });

  it("shows Team plan leftover alongside current Pro plan for a downgraded org", async () => {
    // Pro-tier org that still has unused credits from a prior Team renewal.
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.creditBreakdown).toStrictEqual([
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
  });

  it("maps starter_grant records to Free plan segment", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const free = response.body.creditBreakdown.find((segment) => {
      return segment.category === "free";
    });
    expect(free).toStrictEqual({
      category: "free",
      label: "Free plan",
      credits: 10_000,
    });
  });

  it("maps one_time_purchase records to Promotional segment", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const promo = response.body.creditBreakdown.find((segment) => {
      return segment.category === "promotional";
    });
    expect(promo).toStrictEqual({
      category: "promotional",
      label: "Promotional",
      credits: 5000,
    });
  });

  it("surfaces untracked paid-tier balance as Pay as you go fallback", async () => {
    // Paid-tier org whose ledger shows more credits than any active expires
    // record accounts for (pre-sentinel top-up / historical drift).
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.creditBreakdown).toStrictEqual([
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
      response.body.creditGrants.some((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toBeFalsy();
  });

  it("merges untracked balance on free tier into Free plan segment", async () => {
    // Free-tier org where org_metadata.credits exceeds the starter_grant
    // record's remaining. The delta should render under "Free plan", not
    // "Pay as you go".
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const free = response.body.creditBreakdown.find((segment) => {
      return segment.category === "free";
    });
    expect(free).toStrictEqual({
      category: "free",
      label: "Free plan",
      credits: 12_000,
    });
    expect(
      response.body.creditBreakdown.find((segment) => {
        return segment.category === "payAsYouGo";
      }),
    ).toBeUndefined();
  });

  it("returns defaults when org row does not exist", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.tier).toBe("pro-suspend");
    expect(response.body.credits).toBe(0);
    expect(response.body.hasSubscription).toBeFalsy();
  });
});
