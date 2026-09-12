import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { expect, test } from "vitest";

import { orgPlanCapabilitiesFromBilling } from "../org-plan-capabilities.ts";

function billingStatus(
  overrides: Partial<BillingStatusResponse>,
): BillingStatusResponse {
  return {
    tier: "limited-free-1",
    showUsagePack: false,
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
    ...overrides,
  };
}

test("restricted built-in models prefers the current field over the retired alias", () => {
  const capabilities = orgPlanCapabilitiesFromBilling(
    billingStatus({
      restrictedBuiltInModels: false,
      restrictedVm0Models: true,
    }),
  );

  expect(capabilities.restrictedBuiltInModels).toBeFalsy();
});

test("restricted built-in models reads the retired alias from an API before the rename", () => {
  const capabilities = orgPlanCapabilitiesFromBilling(
    billingStatus({ restrictedVm0Models: false }),
  );

  // The limited-free-1 tier table would restrict, so this value can only come
  // from the alias the older API sent.
  expect(capabilities.restrictedBuiltInModels).toBeFalsy();
});

test("restricted built-in models falls back to the legacy tier table", () => {
  const capabilities = orgPlanCapabilitiesFromBilling(
    billingStatus({ tier: "limited-free-1" }),
  );

  expect(capabilities.restrictedBuiltInModels).toBeTruthy();
});
