import { vi } from "vitest";
import type { Mock } from "vitest";
import type { StripeMockFns } from "../stripe-mock";
import { uniqueId } from "../test-helpers";
import { POST } from "../../../app/api/webhooks/stripe/route";

/**
 * Stripe Webhook Simulator
 *
 * Simulates Stripe webhook events by configuring the constructEvent mock
 * and calling the route handler directly. Consumer test files MUST set up
 * the Stripe module mock using vi.hoisted():
 *
 *   const stripeMocks = vi.hoisted<StripeMockFns>(() => createStripeMocks());
 *   vi.mock("stripe", () => createStripeModuleMock(stripeMocks));
 *
 * And stub the required env vars in beforeEach:
 *
 *   vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
 *   vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_secret");
 *   reloadEnv();
 */

function createStripeWebhookRequest(body: string): Request {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "t=123,v1=abc",
    },
    body,
  });
}

/**
 * Create the set of Stripe mock functions for use with vi.hoisted().
 * Safe to call inside vi.hoisted() — only uses vi.fn(), no imports.
 */
export function createStripeMocks(): StripeMockFns {
  return {
    subscriptionsRetrieve: vi.fn(),
    subscriptionsUpdate: vi.fn(),
    subscriptionsCancel: vi.fn(),
    invoicesRetrieve: vi.fn(),
    invoicesList: vi.fn(),
    customersCreate: vi.fn(),
    checkoutSessionsCreate: vi.fn(),
    billingPortalSessionsCreate: vi.fn(),
    constructEvent: vi.fn(),
  };
}

/**
 * Create the vi.mock("stripe") factory object.
 * Safe to call inside vi.hoisted() — only references the mocks parameter.
 */
export function createStripeModuleMock(mocks: StripeMockFns) {
  return {
    default: function MockStripe() {
      return {
        subscriptions: {
          retrieve: mocks.subscriptionsRetrieve,
          update: mocks.subscriptionsUpdate,
          cancel: mocks.subscriptionsCancel,
        },
        invoices: {
          retrieve: mocks.invoicesRetrieve,
          list: mocks.invoicesList,
        },
        customers: { create: mocks.customersCreate },
        checkout: { sessions: { create: mocks.checkoutSessionsCreate } },
        billingPortal: {
          sessions: { create: mocks.billingPortalSessionsCreate },
        },
        webhooks: { constructEvent: mocks.constructEvent },
      };
    },
  };
}

export async function simulateStripeCheckoutCompleted(
  constructEventMock: Mock,
  orgId: string,
  customerId: string,
  subscriptionId: string,
  tier?: string,
): Promise<Response> {
  constructEventMock.mockReturnValue({
    id: uniqueId("evt"),
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: orgId,
        customer: customerId,
        subscription: subscriptionId,
        metadata: { tier: tier ?? "pro" },
      },
    },
  });
  return POST(
    createStripeWebhookRequest(
      JSON.stringify({ type: "checkout.session.completed" }),
    ),
  );
}

export async function simulateStripeInvoicePaid(
  constructEventMock: Mock,
  customerId: string,
  invoiceId: string,
  amountPaid?: number,
): Promise<Response> {
  constructEventMock.mockReturnValue({
    id: uniqueId("evt"),
    type: "invoice.paid",
    data: {
      object: {
        id: invoiceId,
        customer: customerId,
        amount_paid: amountPaid ?? 2000,
      },
    },
  });
  return POST(
    createStripeWebhookRequest(JSON.stringify({ type: "invoice.paid" })),
  );
}

export async function simulateStripeSubscriptionUpdated(
  constructEventMock: Mock,
  subscriptionId: string,
  status: string,
  tier: string,
  currentPeriodEnd?: number,
): Promise<Response> {
  constructEventMock.mockReturnValue({
    id: uniqueId("evt"),
    type: "customer.subscription.updated",
    data: {
      object: {
        id: subscriptionId,
        status,
        metadata: { tier },
        current_period_end:
          currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 86400 * 30,
      },
    },
  });
  return POST(
    createStripeWebhookRequest(
      JSON.stringify({ type: "customer.subscription.updated" }),
    ),
  );
}

export async function simulateStripeSubscriptionDeleted(
  constructEventMock: Mock,
  subscriptionId: string,
): Promise<Response> {
  constructEventMock.mockReturnValue({
    id: uniqueId("evt"),
    type: "customer.subscription.deleted",
    data: { object: { id: subscriptionId } },
  });
  return POST(
    createStripeWebhookRequest(
      JSON.stringify({ type: "customer.subscription.deleted" }),
    ),
  );
}
