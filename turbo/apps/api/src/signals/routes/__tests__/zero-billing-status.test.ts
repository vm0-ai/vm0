import { randomUUID } from "node:crypto";

import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { createStore } from "ccstate";
import { onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  seedOrgMetadata,
  setOnboardingPaymentPendingFixture,
} from "../../../test-fixtures/system-config-seeds";
import {
  deleteOrgPlanEntitlementFixture,
  insertOrgMetadataAsLegacyWriterFixture,
  updateOrgPlanKeyAsLegacyWriterFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import {
  deleteBillingStatusOrg$,
  seedBillingStatusOrg$,
  type BillingStatusFixture,
} from "./helpers/zero-billing-status";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { createBddApi } from "./helpers/api-bdd";
import { signSandboxJwtForTests } from "../../auth/tokens";

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

function mockMemberRole(
  fixture: BillingStatusFixture,
  role: "org:admin" | "org:member" = "org:member",
): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role,
        organization: {
          id: fixture.orgId,
          slug: fixture.orgId.toLowerCase(),
          name: "Billing Status Test Org",
        },
        publicUserData: { userId: fixture.userId },
        createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      },
    ],
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

    expect(response.body.tier).toBe("limited-free-1");
    expect(response.body.supportByok).toBeFalsy();
    expect(response.body.restrictedVm0Models).toBeTruthy();
    expect(response.body.videoGenerationAllowed).toBeFalsy();
    expect(response.body.credits).toBe(100_000);
    expect(response.body.onboardingPaymentPending).toBeFalsy();
    expect(response.body.hasSubscription).toBeFalsy();
    expect(response.body.subscriptionStatus).toBeNull();
    expect(response.body.currentPeriodEnd).toBeNull();
  });

  it("returns billing status for zero tokens with billing read capability", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 100_000 }, context.signal),
    );
    mockMemberRole(fixture);
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
    expect(response.body.scheduledChange).toBeNull();
    expect(response.body.hasSubscription).toBeTruthy();
  });

  it("returns custom tier status without subscription plan credits", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, { credits: 0 }, context.signal),
    );
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "custom",
      credits: 0,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.tier).toBe("custom");
    expect(response.body.hasSubscription).toBeFalsy();
    expect(response.body.currentPeriodEnd).toBeNull();
    expect(response.body.concurrencyLimit).toBe(10);
    expect(response.body.creditBreakdown).toStrictEqual([]);
  });

  it("returns finite concurrency limit when the concurrency cap is disabled", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          subscription: {
            tier: "pro",
            status: "active",
            currentPeriodEnd: new Date("2099-04-20T00:00:00Z"),
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

    expect(response.body.concurrencyLimit).toBe(2);
    expect(Number.isFinite(response.body.concurrencyLimit)).toBeTruthy();
  });

  it("returns entitlement capabilities for a non-staff org", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "3");
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    onTestFinished(async () => {
      await deleteOrgPlanEntitlementFixture(orgId);
    });
    await seedOrgMetadata({
      orgId,
      tier: "pro",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      baseConcurrencyLimit: 10,
      canBuyConcurrency: true,
      canBuyCredits: false,
      autoRechargeAllowed: false,
      supportByok: false,
      restrictedVm0Models: true,
      videoGenerationAllowed: false,
      workflowWebhookAutomationAllowed: true,
    });
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      setupApp({ context })(zeroBillingStatusContract).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.tier).toBe("pro");
    expect(response.body.canBuyConcurrency).toBeTruthy();
    expect(response.body.canBuyCredits).toBeFalsy();
    expect(response.body.autoRechargeAllowed).toBeFalsy();
    expect(response.body.supportByok).toBeFalsy();
    expect(response.body.restrictedVm0Models).toBeTruthy();
    expect(response.body.videoGenerationAllowed).toBeFalsy();
    expect(response.body.workflowWebhookAutomationAllowed).toBeTruthy();
    expect(response.body.concurrencyLimit).toBe(3);
  });

  it("keeps credit purchase capability accurate for legacy rollout writes", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    onTestFinished(async () => {
      await deleteOrgPlanEntitlementFixture(orgId);
    });
    await insertOrgMetadataAsLegacyWriterFixture({
      orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);
    const initialResponse = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(initialResponse.body.canBuyCredits).toBeFalsy();

    await updateOrgPlanKeyAsLegacyWriterFixture({ orgId, planKey: "pro" });

    const updatedResponse = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(updatedResponse.body.tier).toBe("limited-free-1");
    expect(updatedResponse.body.canBuyCredits).toBeTruthy();
  });

  it("includes active concurrency subscription slots", async () => {
    const currentPeriodEnd = new Date("2099-04-20T00:00:00Z");
    const concurrencySubscriptionId = `sub_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 120_000,
          subscription: {
            tier: "team",
            status: "active",
            currentPeriodEnd,
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          concurrencyEntitlements: [
            {
              stripeSubscriptionId: concurrencySubscriptionId,
              slots: 2,
              startsAt: new Date("2026-01-01T00:00:00Z"),
              expiresAt: new Date("2099-05-20T00:00:00Z"),
              cancelAtPeriodEnd: true,
            },
            {
              stripeSubscriptionId: concurrencySubscriptionId,
              slots: 1,
              startsAt: new Date("2026-01-01T00:00:00Z"),
              expiresAt: new Date("2099-06-20T00:00:00Z"),
            },
            {
              stripeSubscriptionId: concurrencySubscriptionId,
              slots: 5,
              startsAt: new Date("2025-01-01T00:00:00Z"),
              expiresAt: new Date("2026-01-01T00:00:00Z"),
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

    expect(response.body.concurrencyLimit).toBe(13);
    expect(response.body.concurrencySubscriptions).toStrictEqual([
      {
        id: concurrencySubscriptionId,
        quantity: 3,
        currentPeriodEnd: "2099-06-20T00:00:00.000Z",
        cancelAtPeriodEnd: true,
      },
    ]);
  });

  it("includes active usage allowance windows", async () => {
    const shortStartsAt = new Date("2026-01-01T00:00:00Z");
    const shortExpiresAt = new Date("2099-01-01T05:00:00Z");
    const weeklyStartsAt = new Date("2026-01-01T00:00:00Z");
    const weeklyExpiresAt = new Date("2099-01-08T00:00:00Z");
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 120_000,
          subscription: {
            tier: "team",
            status: "active",
            currentPeriodEnd: new Date("2099-04-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          usageAllowance: {
            shortWindowSeconds: 18_000,
            shortWindowUnits: 5000,
            weeklyWindowSeconds: 604_800,
            weeklyWindowUnits: 50_000,
            effectiveAt: new Date("2026-01-01T00:00:00Z"),
            expiresAt: new Date("2099-04-20T00:00:00Z"),
            windows: [
              {
                kind: "short",
                startsAt: shortStartsAt,
                expiresAt: shortExpiresAt,
                unitLimit: 5000,
                consumedUnits: 1250,
              },
              {
                kind: "weekly",
                startsAt: weeklyStartsAt,
                expiresAt: weeklyExpiresAt,
                unitLimit: 50_000,
                consumedUnits: 10_000,
              },
            ],
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

    expect(response.body.usageAllowance).toStrictEqual({
      windows: [
        {
          kind: "short",
          windowSeconds: 18_000,
          unitLimit: 5000,
          consumedUnits: 1250,
          remainingUnits: 3750,
          startsAt: shortStartsAt.toISOString(),
          expiresAt: shortExpiresAt.toISOString(),
        },
        {
          kind: "weekly",
          windowSeconds: 604_800,
          unitLimit: 50_000,
          consumedUnits: 10_000,
          remainingUnits: 40_000,
          startsAt: weeklyStartsAt.toISOString(),
          expiresAt: weeklyExpiresAt.toISOString(),
        },
      ],
    });
  });

  it("ignores usage allowance windows from a previous entitlement period", async () => {
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 120_000,
          subscription: {
            tier: "team",
            status: "active",
            currentPeriodEnd: new Date("2099-04-20T00:00:00Z"),
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          usageAllowance: {
            shortWindowSeconds: 18_000,
            shortWindowUnits: 5000,
            weeklyWindowSeconds: 604_800,
            weeklyWindowUnits: 50_000,
            effectiveAt: new Date("2026-07-01T00:00:00Z"),
            expiresAt: new Date("2099-04-20T00:00:00Z"),
            windows: [
              {
                kind: "short",
                startsAt: new Date("2026-06-30T00:00:00Z"),
                expiresAt: new Date("2099-01-01T05:00:00Z"),
                unitLimit: 5000,
                consumedUnits: 1250,
              },
              {
                kind: "weekly",
                startsAt: new Date("2026-06-30T00:00:00Z"),
                expiresAt: new Date("2099-01-08T00:00:00Z"),
                unitLimit: 50_000,
                consumedUnits: 10_000,
              },
            ],
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      setupApp({ context })(zeroBillingStatusContract).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.usageAllowance).toStrictEqual({
      windows: [
        {
          kind: "short",
          windowSeconds: 18_000,
          unitLimit: 5000,
          consumedUnits: 0,
          remainingUnits: 5000,
          startsAt: null,
          expiresAt: null,
        },
        {
          kind: "weekly",
          windowSeconds: 604_800,
          unitLimit: 50_000,
          consumedUnits: 0,
          remainingUnits: 50_000,
          startsAt: null,
          expiresAt: null,
        },
      ],
    });
  });

  it("excludes canceled concurrency subscriptions from status", async () => {
    const currentPeriodEnd = new Date("2099-04-20T00:00:00Z");
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 120_000,
          subscription: {
            tier: "team",
            status: "active",
            currentPeriodEnd,
            stripeCustomerId: `cus_${randomUUID()}`,
            stripeSubscriptionId: `sub_${randomUUID()}`,
          },
          concurrencyEntitlements: [
            {
              stripeSubscriptionId: `sub_${randomUUID()}`,
              slots: 2,
              startsAt: new Date("2026-01-01T00:00:00Z"),
              expiresAt: new Date("2099-05-20T00:00:00Z"),
              subscriptionStatus: "canceled",
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

    expect(response.body.concurrencyLimit).toBe(10);
    expect(response.body.concurrencySubscriptions).toStrictEqual([]);
  });

  it("returns onboarding payment pending state", async () => {
    const fixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      expiresRecordIds: [],
    };
    const completed = await createBddApi(context).completeOnboarding({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
      email: `${fixture.userId}@example.test`,
    });
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.onboardingPaymentPending).toBeTruthy();
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
    expect(response.body.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: periodEnd.toISOString(),
    });
  });

  it("returns scheduled downgrade details when set", async () => {
    const periodEnd = new Date("2099-04-20T00:00:00Z");
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroBillingStatusContract);

    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.cancelAtPeriodEnd).toBeFalsy();
    expect(response.body.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: periodEnd.toISOString(),
    });
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

    expect(response.body.creditExpiry.expiringNextCycle).toBe(20_000);
    expect(response.body.creditExpiry.nextExpiryDate).toBe(
      expiryDate.toISOString(),
    );
    expect(response.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        label: "Pro plan",
        amount: 20_000,
        remaining: 20_000,
        expiresAt: expiryDate.toISOString(),
      }),
    ]);
  });

  it("returns zero creditExpiry without active credit grants", async () => {
    const fixture = await track(
      store.set(seedBillingStatusOrg$, {}, context.signal),
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
    // Dormant non-subscription org: a 3k purchase grant is past its
    // expiresAt but the inflated ledger has not yet been settled, so the
    // /status endpoint must subtract the expired amount before reporting.
    const pastDate = new Date("2026-03-01T00:00:00Z");
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 103_000,
          expiresRecords: [
            {
              source: "credit_purchase",
              amount: 3000,
              expiresAt: pastDate,
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

    // 103_000 ledger credits - 3000 expired credits = 100_000 displayed.
    expect(response.body.credits).toBe(100_000);
  });

  it("maps pay-as-you-go expires records to Pay as you go segment", async () => {
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
              source: "credit_purchase",
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
        return (
          grant.source === "auto_recharge" || grant.source === "credit_purchase"
        );
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

  it("maps one_time_purchase records to Promotional segment", async () => {
    const fixture = await track(
      store.set(
        seedBillingStatusOrg$,
        {
          credits: 100_000,
          expiresRecords: [
            {
              source: "one_time_purchase",
              amount: 100_000,
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
      credits: 100_000,
    });
  });

  it("surfaces paid-tier credit purchases as Pay as you go", async () => {
    // Paid-tier org with a plan renewal plus an extra credit purchase.
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
