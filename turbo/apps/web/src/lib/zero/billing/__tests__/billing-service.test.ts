import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import { getOrgBillingFields } from "../../../../__tests__/api-test-helpers";

const stripeMocks = vi.hoisted(() => {
  return {
    customersCreate: vi.fn(),
    checkoutSessionsCreate: vi.fn(),
    subscriptionsRetrieve: vi.fn(),
    billingPortalSessionsCreate: vi.fn(),
    invoicesList: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        customers: { create: stripeMocks.customersCreate },
        checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
        subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
        billingPortal: {
          sessions: { create: stripeMocks.billingPortalSessionsCreate },
        },
        invoices: { list: stripeMocks.invoicesList },
        webhooks: { constructEvent: vi.fn() },
      };
    },
  };
});

const context = testContext();

describe("billing-service", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    stripeMocks.customersCreate.mockReset();
    stripeMocks.checkoutSessionsCreate.mockReset();
    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.billingPortalSessionsCreate.mockReset();
    stripeMocks.invoicesList.mockReset();

    stripeMocks.checkoutSessionsCreate.mockImplementation(async (params) => {
      return {
        url: `https://checkout.stripe.test/${params.customer}`,
      };
    });
  });

  it("serializes Stripe customer creation across concurrent checkout requests", async () => {
    const { createCheckoutSession } = await import("../billing-service");
    const firstCustomerId = uniqueId("cus");

    stripeMocks.customersCreate.mockImplementationOnce(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      return { id: firstCustomerId };
    });

    const checkout1 = createCheckoutSession(
      user.orgId,
      "price_test_pro",
      "https://app.vm0.test/success",
      "https://app.vm0.test/cancel",
    );

    const checkout2 = createCheckoutSession(
      user.orgId,
      "price_test_pro",
      "https://app.vm0.test/success",
      "https://app.vm0.test/cancel",
    );

    const [url1, url2] = await Promise.all([checkout1, checkout2]);

    expect(stripeMocks.customersCreate).toHaveBeenCalledTimes(1);
    expect(stripeMocks.checkoutSessionsCreate).toHaveBeenCalledTimes(2);

    const sessionCustomers = stripeMocks.checkoutSessionsCreate.mock.calls.map(
      ([params]) => {
        return params.customer;
      },
    );
    expect(sessionCustomers).toEqual([firstCustomerId, firstCustomerId]);
    expect(url1).toBe(`https://checkout.stripe.test/${firstCustomerId}`);
    expect(url2).toBe(`https://checkout.stripe.test/${firstCustomerId}`);

    const billing = await getOrgBillingFields(user.orgId);
    expect(billing?.stripeCustomerId).toBe(firstCustomerId);
  });
});
