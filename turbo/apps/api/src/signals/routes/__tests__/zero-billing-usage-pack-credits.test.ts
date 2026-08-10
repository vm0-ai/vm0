import { randomUUID } from "node:crypto";

import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
import { zeroBillingUsagePackCreditsContract } from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
} from "../test-usage-pack-subscription-state";
import { zeroBillingUsagePackCreditsRoutes } from "../zero-billing-usage-pack-credits";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface UsagePackCreditsFixture {
  readonly orgId: string;
  readonly userId: string;
}

function fixture(): UsagePackCreditsFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authenticate(
  actor: UsagePackCreditsFixture,
  role: "org:admin" | "org:member" = "org:member",
): void {
  mocks.clerk.session(actor.userId, actor.orgId, role);
}

function creditsClient() {
  return setupApp({ context, routes: zeroBillingUsagePackCreditsRoutes })(
    zeroBillingUsagePackCreditsContract,
  );
}

function settlementClient() {
  return setupApp({ context, routes: testUsageSettlementRoutes })(
    testUsageSettlementContract,
  );
}

function usagePackStateClient() {
  return setupApp({
    context,
    routes: testUsagePackSubscriptionStateRoutes,
  })(testUsagePackSubscriptionStateContract);
}

async function setupActiveUsagePack(
  actor: UsagePackCreditsFixture,
): Promise<string> {
  await accept(
    settlementClient().setup({
      body: { org_id: actor.orgId, credits: 0 },
    }),
    [200],
  );
  const response = await accept(
    usagePackStateClient().action({
      body: {
        action: "seed",
        orgId: actor.orgId,
        tier: "pro",
        stripePlanPriceId: "price_test_pro",
        stripeCustomerId: `cus_${randomUUID()}`,
        stripeCheckoutSessionId: `cs_${randomUUID()}`,
        allocations: [
          {
            userId: actor.userId,
            invitationId: null,
            usagePackUsd: 20,
            stripePriceId: "price_test_usage_pack_20",
            status: "active",
          },
        ],
      },
    }),
    [200],
  );
  if (response.body.action !== "seeded") {
    throw new Error("Expected seeded usage pack state");
  }
  return response.body.usagePackSubscriptionId;
}

async function createGrant(args: {
  readonly actor: UsagePackCreditsFixture;
  readonly userId?: string;
  readonly grantType: "purchased" | "bonus";
  readonly amount: number;
  readonly expiresAt: string;
}): Promise<void> {
  await accept(
    settlementClient().createGrant({
      body: {
        org_id: args.actor.orgId,
        user_id: args.userId ?? args.actor.userId,
        grant_type: args.grantType,
        idempotency_key: randomUUID(),
        amount: args.amount,
        expires_at: args.expiresAt,
      },
    }),
    [200],
  );
}

function registerCleanup(
  actor: UsagePackCreditsFixture,
  usagePackSubscriptionId?: string,
): void {
  onTestFinished(async () => {
    clearMockNow();
    if (usagePackSubscriptionId) {
      await accept(
        usagePackStateClient().action({
          body: {
            action: "cleanup",
            orgId: actor.orgId,
            usagePackSubscriptionId,
            deleteGrants: false,
            deleteOrgMetadata: true,
          },
        }),
        [200],
      );
    }
    await accept(
      settlementClient().cleanup({ body: { org_id: actor.orgId } }),
      [200],
    );
    await deleteFeatureSwitchesForUser(context, actor);
  });
}

describe("GET /api/zero/billing/usage-pack-credits", () => {
  it("keeps member usage pack credits behind UsagePackPlans", async () => {
    const actor = fixture();
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Usage pack credits are not enabled",
        code: "FORBIDDEN",
      },
    });
  });

  it("reports when the organization has no active usage pack", async () => {
    mockEnv("ENV", "development");
    const actor = fixture();
    registerCleanup(actor);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
      hasUsagePack: false,
    });
  });

  it("returns only the current member's active purchased and bonus credits", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();
    const usagePackSubscriptionId = await setupActiveUsagePack(actor);
    registerCleanup(actor, usagePackSubscriptionId);

    await createGrant({
      actor,
      grantType: "purchased",
      amount: 20_000,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    await createGrant({
      actor,
      grantType: "bonus",
      amount: 400,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    await createGrant({
      actor,
      userId: `user_${randomUUID()}`,
      grantType: "purchased",
      amount: 50_000,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    await createGrant({
      actor,
      grantType: "bonus",
      amount: 1000,
      expiresAt: "2026-08-09T00:00:00.000Z",
    });
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      hasUsagePack: true,
      creditGrants: expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          amount: 20_000,
          remaining: 20_000,
          createdAt: expect.any(String),
          expiresAt: "2026-09-10T00:00:00.000Z",
        }),
        expect.objectContaining({
          grantType: "bonus",
          amount: 400,
          remaining: 400,
          createdAt: expect.any(String),
          expiresAt: "2026-09-10T00:00:00.000Z",
        }),
      ]),
    });
    expect(response.body.creditGrants).toHaveLength(2);
  });

  it("returns every member's active usage pack balance to an admin", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();
    const otherUserId = `user_${randomUUID()}`;
    const usagePackSubscriptionId = await setupActiveUsagePack(actor);
    registerCleanup(actor, usagePackSubscriptionId);

    await createGrant({
      actor,
      grantType: "purchased",
      amount: 20_000,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    await createGrant({
      actor,
      userId: otherUserId,
      grantType: "purchased",
      amount: 50_000,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    await createGrant({
      actor,
      userId: otherUserId,
      grantType: "bonus",
      amount: 4350,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.UsagePackPlans]: true,
    });
    authenticate(actor, "org:admin");

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.memberCredits).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: actor.userId,
          totalCredits: 20_000,
          purchasedCredits: 20_000,
          bonusCredits: 0,
          creditGrants: [
            expect.objectContaining({
              grantType: "purchased",
              remaining: 20_000,
            }),
          ],
        }),
        expect.objectContaining({
          memberId: otherUserId,
          totalCredits: 54_350,
          purchasedCredits: 50_000,
          bonusCredits: 4350,
          creditGrants: expect.arrayContaining([
            expect.objectContaining({
              grantType: "purchased",
              remaining: 50_000,
            }),
            expect.objectContaining({
              grantType: "bonus",
              remaining: 4350,
            }),
          ]),
        }),
      ]),
    );
    expect(response.body.memberCredits).toHaveLength(2);
    expect(response.body.hasUsagePack).toBeTruthy();
  });
});
