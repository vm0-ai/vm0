import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  testContext,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import {
  grantCreditsToOrg,
  setOrgCredits,
} from "../../../../__tests__/api-test-helpers";

const stripeMocks = vi.hoisted(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    invoicesList: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
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

    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.invoicesList.mockReset();
  });

  it("returns negative credit balances instead of clamping them to zero", async () => {
    const { getBillingStatus } = await import("../billing-service");

    await setOrgCredits(user.orgId, -5);

    const billing = await getBillingStatus(user.orgId);

    expect(billing.credits).toBe(-5);
    expect(billing.creditBreakdown).toEqual([]);
  });

  it("shows remaining debt after a recharge partially offsets a negative balance", async () => {
    const { getBillingStatus } = await import("../billing-service");

    await setOrgCredits(user.orgId, -100);
    await grantCreditsToOrg(user.orgId, 5);

    const billing = await getBillingStatus(user.orgId);

    expect(billing.credits).toBe(-95);
  });
});
