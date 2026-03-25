/**
 * Billing API Handlers
 *
 * Mock handlers for /api/zero/billing endpoints.
 */

import { http, HttpResponse } from "msw";
import type { BillingStatus } from "../../signals/zero-page/billing.ts";

let mockBillingStatus: BillingStatus = {
  tier: "free",
  credits: 10_000,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  hasSubscription: false,
  autoRecharge: { enabled: false, threshold: null, amount: null },
};

export function resetMockBilling(): void {
  mockBillingStatus = {
    tier: "free",
    credits: 10_000,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
  };
}

export const apiBillingHandlers = [
  http.get("*/api/zero/billing/status", () => {
    return HttpResponse.json(mockBillingStatus);
  }),

  http.post("*/api/zero/billing/checkout", async ({ request }) => {
    const body = (await request.json()) as {
      tier: string;
      successUrl: string;
      cancelUrl: string;
    };
    return HttpResponse.json({
      url: `https://checkout.stripe.com/test?tier=${body.tier}`,
    });
  }),

  http.post("*/api/zero/billing/portal", () => {
    return HttpResponse.json({
      url: "https://billing.stripe.com/test-portal",
    });
  }),

  http.get("*/api/zero/billing/auto-recharge", () => {
    return HttpResponse.json(mockBillingStatus.autoRecharge);
  }),

  http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
    const body = (await request.json()) as {
      enabled: boolean;
      threshold?: number;
      amount?: number;
    };
    mockBillingStatus.autoRecharge = {
      enabled: body.enabled,
      threshold: body.enabled ? (body.threshold ?? null) : null,
      amount: body.enabled ? (body.amount ?? null) : null,
    };
    return HttpResponse.json(mockBillingStatus.autoRecharge);
  }),
];
