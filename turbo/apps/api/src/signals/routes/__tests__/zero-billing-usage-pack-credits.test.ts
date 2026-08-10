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

function authenticate(actor: UsagePackCreditsFixture): void {
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
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

function registerCleanup(actor: UsagePackCreditsFixture): void {
  onTestFinished(async () => {
    clearMockNow();
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

  it("returns only the current member's active purchased and bonus credits", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();
    registerCleanup(actor);

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
    });
  });
});
