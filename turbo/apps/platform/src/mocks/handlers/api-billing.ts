/**
 * Billing API Handlers
 *
 * Mock handlers for /api/billing endpoints.
 */

import { http, HttpResponse } from "msw";
import type { BillingStatus } from "../../signals/zero-page/billing.ts";

let mockBillingStatus: BillingStatus = {
  tier: "free",
  credits: 2000,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  hasSubscription: false,
};

export function setMockBillingStatus(status: Partial<BillingStatus>): void {
  mockBillingStatus = { ...mockBillingStatus, ...status };
}

export function resetMockBilling(): void {
  mockBillingStatus = {
    tier: "free",
    credits: 2000,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    hasSubscription: false,
  };
}

export const apiBillingHandlers = [
  http.get("*/api/billing/status", () => {
    return HttpResponse.json(mockBillingStatus);
  }),

  http.post("*/api/billing/checkout", async ({ request }) => {
    const body = (await request.json()) as {
      tier: string;
      successUrl: string;
      cancelUrl: string;
    };
    return HttpResponse.json({
      url: `https://checkout.stripe.com/test?tier=${body.tier}`,
    });
  }),

  http.post("*/api/billing/portal", () => {
    return HttpResponse.json({
      url: "https://billing.stripe.com/test-portal",
    });
  }),
];
