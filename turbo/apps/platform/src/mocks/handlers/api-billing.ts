/**
 * Billing API Handlers
 *
 * Mock handlers for /api/zero/billing endpoints.
 */

import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingDowngradeContract,
  zeroBillingAutoRechargeContract,
  type BillingStatusResponse,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockBillingStatus: BillingStatusResponse = {
  tier: "free",
  credits: 100_000,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  hasSubscription: false,
  autoRecharge: { enabled: false, threshold: null, amount: null },
  creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
};

export function setMockBillingStatus(
  status: Partial<BillingStatusResponse>,
): void {
  mockBillingStatus = { ...mockBillingStatus, ...status };
}

export function resetMockBilling(): void {
  mockBillingStatus = {
    tier: "free",
    credits: 100_000,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
  };
}

export const apiBillingHandlers = [
  mockApi(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, mockBillingStatus);
  }),

  mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
    return respond(200, {
      url: `https://checkout.stripe.com/test?tier=${body.tier}`,
    });
  }),

  mockApi(zeroBillingPortalContract.create, ({ respond }) => {
    return respond(200, {
      url: "https://billing.stripe.com/test-portal",
    });
  }),

  mockApi(zeroBillingDowngradeContract.create, ({ respond }) => {
    return respond(200, {
      success: true,
      effectiveDate: null,
    });
  }),

  mockApi(zeroBillingAutoRechargeContract.get, ({ respond }) => {
    return respond(200, mockBillingStatus.autoRecharge);
  }),

  mockApi(zeroBillingAutoRechargeContract.update, ({ body, respond }) => {
    mockBillingStatus.autoRecharge = {
      enabled: body.enabled,
      threshold: body.enabled ? (body.threshold ?? null) : null,
      amount: body.enabled ? (body.amount ?? null) : null,
    };
    return respond(200, mockBillingStatus.autoRecharge);
  }),
];
