import { randomUUID } from "node:crypto";

import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
} from "../test-usage-pack-subscription-state";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";

const context = testContext();
const mocks = createRouteMocks(context);

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
  return setupApp({ context, routes: billingUsagePackCreditsRoutes })(
    billingUsagePackCreditsContract,
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
  allocationUserId = actor.userId,
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
            userId: allocationUserId,
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
  });
}

describe("GET /api/billing/usage-pack-credits", () => {
  it("reports when the organization has no active usage pack", async () => {
    mockEnv("ENV", "development");
    const actor = fixture();
    registerCleanup(actor);
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

  it("reports no usage pack for a member without an active allocation", async () => {
    mockEnv("ENV", "development");
    const actor = fixture();
    const usagePackSubscriptionId = await setupActiveUsagePack(
      actor,
      `user_${randomUUID()}`,
    );
    registerCleanup(actor, usagePackSubscriptionId);
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

  it("returns active one-time credits without a usage pack allocation", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();
    registerCleanup(actor);

    await createGrant({
      actor,
      grantType: "bonus",
      amount: 10_000,
      expiresAt: "2026-09-10T00:00:00.000Z",
    });
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 10_000,
      purchasedCredits: 0,
      bonusCredits: 10_000,
      hasUsagePack: false,
      creditGrants: [
        expect.objectContaining({
          grantType: "bonus",
          amount: 10_000,
          remaining: 10_000,
          createdAt: expect.any(String),
          expiresAt: "2026-09-10T00:00:00.000Z",
        }),
      ],
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
