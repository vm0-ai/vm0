import {
  zeroBillingStatusContract,
  zeroBillingCheckoutContract,
  zeroBillingPortalContract,
  zeroBillingDowngradeContract,
  zeroBillingAutoRechargeContract,
  zeroBillingInvoicesContract,
  zeroBillingRedeemContract,
  type BillingStatusResponse,
  type BillingInvoice,
  type RedeemResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { mockApi } from "../msw-contract.ts";

let mockBillingInvoices: BillingInvoice[] = [];

export function setMockBillingInvoices(invoices: BillingInvoice[]): void {
  mockBillingInvoices = invoices;
}

// Fixed ISO string so snapshot tests stay stable. Reflects the new free-tier
// default: a freshly-granted org has all 10k starter credits expiring in
// ~1 month. Tests that need a different state should call setMockBillingStatus.
const MOCK_STARTER_GRANT_EXPIRY = "2099-01-01T00:00:00.000Z";

function defaultBillingStatus(): BillingStatusResponse {
  return {
    tier: "free",
    credits: 10_000,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 10_000,
      nextExpiryDate: MOCK_STARTER_GRANT_EXPIRY,
    },
    creditBreakdown: [
      { category: "free", label: "Free plan", credits: 10_000 },
    ],
    creditGrants: [
      {
        id: "starter-grant",
        source: "starter_grant",
        label: "Free plan",
        amount: 10_000,
        remaining: 10_000,
        createdAt: "2098-12-01T00:00:00.000Z",
        expiresAt: MOCK_STARTER_GRANT_EXPIRY,
      },
    ],
  };
}

let mockBillingStatus: BillingStatusResponse = defaultBillingStatus();

export function setMockBillingStatus(
  status: Partial<BillingStatusResponse>,
): void {
  mockBillingStatus = { ...mockBillingStatus, ...status };
}

function defaultRedeemResponse(): RedeemResponse {
  return {
    status: "ready",
    checkoutUrl: "https://checkout.stripe.com/test/redeem",
  };
}

let mockRedeemResponse: RedeemResponse = defaultRedeemResponse();

export function setMockRedeemResponse(response: RedeemResponse): void {
  mockRedeemResponse = response;
}

export function resetMockBilling(): void {
  mockBillingStatus = defaultBillingStatus();
  mockBillingInvoices = [];
  mockRedeemResponse = defaultRedeemResponse();
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

  mockApi(zeroBillingInvoicesContract.get, ({ respond }) => {
    return respond(200, { invoices: mockBillingInvoices });
  }),

  mockApi(zeroBillingRedeemContract.create, ({ respond }) => {
    return respond(200, mockRedeemResponse);
  }),
];
