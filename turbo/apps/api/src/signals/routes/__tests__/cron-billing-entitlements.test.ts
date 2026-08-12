import { randomUUID } from "node:crypto";

import {
  testBillingReconciliationStateContract,
  type BillingReconciliationFixtureKind,
  type TestBillingReconciliationStateActionBody,
  type TestBillingReconciliationStateActionResponse,
} from "@vm0/api-contracts/contracts/test-billing-reconciliation-state";
import type StripeSDK from "stripe";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockStripeClient } from "../../external/stripe-client";
import { testBillingReconciliationStateRoutes } from "../test-billing-reconciliation-state";

const context = testContext();

const INITIAL_STATUSES: readonly (readonly [
  BillingReconciliationFixtureKind,
  string,
])[] = [
  ["plan-subscription", "past_due"],
  ["atom-grant", "atom_grant"],
  ["concurrency", "past_due"],
  ["usage-allowance", "past_due"],
  ["usage-pack-subscription", "checkout_pending"],
  ["usage-pack-subscription-change", "previewed"],
  ["usage-pack-allocation-change", "previewed"],
  ["usage-pack-refund", "pending"],
  ["usage-pack-migration", "previewed"],
  ["usage-pack-invitation", "checkout_pending"],
];

const RECONCILED_STATUSES: readonly (readonly [
  BillingReconciliationFixtureKind,
  string,
])[] = [
  ["plan-subscription", "canceled"],
  ["atom-grant", "expired"],
  ["concurrency", "canceled"],
  ["usage-allowance", "canceled"],
  ["usage-pack-subscription", "checkout_expired"],
  ["usage-pack-subscription-change", "failed"],
  ["usage-pack-allocation-change", "failed"],
  ["usage-pack-refund", "succeeded"],
  ["usage-pack-migration", "failed"],
  ["usage-pack-invitation", "failed"],
];

function apiClient() {
  return setupApp({
    context,
    routes: testBillingReconciliationStateRoutes,
  })(testBillingReconciliationStateContract);
}

async function stateAction(
  body: TestBillingReconciliationStateActionBody,
): Promise<TestBillingReconciliationStateActionResponse> {
  const response = await accept(apiClient().action({ body }), [200]);
  return response.body;
}

async function seedState(marker: string) {
  const response = await stateAction({ action: "seed", marker });
  if (response.action !== "seeded") {
    throw new Error("Billing reconciliation state was not seeded");
  }
  return response.fixtures;
}

async function readState(marker: string) {
  const response = await stateAction({ action: "read", marker });
  if (response.action !== "read") {
    throw new Error("Billing reconciliation state was not read");
  }
  return response.candidates;
}

function seededFixture(
  fixtures: Awaited<ReturnType<typeof seedState>>,
  kind: BillingReconciliationFixtureKind,
) {
  const fixture = fixtures.find((candidate) => {
    return candidate.kind === kind;
  });
  if (!fixture) {
    throw new Error(`Missing seeded billing reconciliation fixture ${kind}`);
  }
  return fixture;
}

function statuses(
  candidates: Awaited<ReturnType<typeof readState>>,
): readonly (readonly [BillingReconciliationFixtureKind, string])[] {
  return candidates.map((candidate) => {
    return [candidate.kind, candidate.status] as const;
  });
}

describe("billing entitlement reconciliation", () => {
  it("reconciles every selected candidate class without touching an eligible sentinel", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        return Promise.resolve({
          id: subscriptionId,
          status: "canceled",
          cancel_at: null,
          cancel_at_period_end: false,
          metadata: {},
          items: { data: [] },
        });
      },
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (checkoutSessionId) => {
        return Promise.resolve({
          id: checkoutSessionId,
          status: "expired",
          subscription: null,
        });
      },
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });

    const selectedMarker = randomUUID();
    const sentinelMarker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker: selectedMarker });
      await stateAction({ action: "cleanup", marker: sentinelMarker });
    });
    const selectedFixtures = await seedState(selectedMarker);
    await seedState(sentinelMarker);

    expect(statuses(await readState(selectedMarker))).toStrictEqual(
      INITIAL_STATUSES,
    );
    const sentinelBefore = await readState(sentinelMarker);
    expect(statuses(sentinelBefore)).toStrictEqual(INITIAL_STATUSES);

    const response = await accept(
      apiClient().reconcile({
        body: {
          orgIds: selectedFixtures.map((fixture) => {
            return fixture.orgId;
          }),
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, downgraded: 2 });

    const selected = await readState(selectedMarker);
    expect(statuses(selected)).toStrictEqual(RECONCILED_STATUSES);
    expect(selected[0]).toStrictEqual({
      kind: "plan-subscription",
      orgId: seededFixture(selectedFixtures, "plan-subscription").orgId,
      status: "canceled",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });
    expect(selected[1]).toStrictEqual({
      kind: "atom-grant",
      orgId: seededFixture(selectedFixtures, "atom-grant").orgId,
      status: "expired",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });

    await expect(readState(sentinelMarker)).resolves.toStrictEqual(
      sentinelBefore,
    );
  });
});
