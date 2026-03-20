import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  getOrgCredits,
  ensureOrgRow,
  updateOrgStripeFields,
  getOrgBillingFields,
  grantCreditsToOrg,
} from "../../../__tests__/api-test-helpers";
import type { StripeMockFns } from "../../../__tests__/stripe-mock";
import { reloadEnv } from "../../../env";
import {
  handleCheckoutCompleted,
  handleInvoicePaid,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  getBillingStatus,
  tierFromPriceId,
} from "../billing-service";

// Mock stripe module (external dependency)
const stripeMocks = vi.hoisted<StripeMockFns>(() => ({
  subscriptionsRetrieve: vi.fn(),
  invoicesRetrieve: vi.fn(),
  customersCreate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  billingPortalSessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: function MockStripe() {
    return {
      subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
      invoices: { retrieve: stripeMocks.invoicesRetrieve },
      customers: { create: stripeMocks.customersCreate },
      checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
      billingPortal: {
        sessions: { create: stripeMocks.billingPortalSessionsCreate },
      },
      webhooks: { constructEvent: stripeMocks.constructEvent },
    };
  },
}));

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_MAX = "price_test_max";

const context = testContext();

describe("billing-service", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Set up env vars for price IDs
    vi.stubEnv("STRIPE_PRICE_ID_PRO", TEST_PRICE_PRO);
    vi.stubEnv("STRIPE_PRICE_ID_MAX", TEST_PRICE_MAX);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();

    // Reset mocks
    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.invoicesRetrieve.mockReset();
  });

  describe("tierFromPriceId", () => {
    it("maps pro price ID to pro tier", () => {
      expect(tierFromPriceId(TEST_PRICE_PRO)).toBe("pro");
    });

    it("maps max price ID to max tier", () => {
      expect(tierFromPriceId(TEST_PRICE_MAX)).toBe("max");
    });

    it("throws on unknown price ID", () => {
      expect(() => tierFromPriceId("price_unknown")).toThrow(
        "Unknown Stripe price ID",
      );
    });
  });

  describe("grantOrgCredits", () => {
    it("atomically adds to existing balance", async () => {
      const before = await getOrgCredits(user.orgId);
      expect(before).toBe(2000);

      await grantCreditsToOrg(user.orgId, 5000);

      const after = await getOrgCredits(user.orgId);
      expect(after).toBe(7000);
    });

    it("creates row with credits if org row does not exist", async () => {
      const newOrgId = uniqueId("org-grant");
      await grantCreditsToOrg(newOrgId, 3000);

      const credits = await getOrgCredits(newOrgId);
      expect(credits).toBe(3000);
    });
  });

  describe("handleCheckoutCompleted", () => {
    it("activates subscription and sets tier", async () => {
      const cusId = uniqueId("cus-checkout");
      const subId = uniqueId("sub-checkout");
      const invId = uniqueId("inv-checkout");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
        latest_invoice: invId,
      });

      stripeMocks.invoicesRetrieve.mockResolvedValue({
        id: invId,
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      });

      const session = {
        id: uniqueId("cs"),
        subscription: subId,
        customer: cusId,
      };

      await handleCheckoutCompleted(session);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("pro");
      expect(billing?.stripeSubscriptionId).toBe(subId);
      expect(billing?.subscriptionStatus).toBe("active");
      expect(billing?.currentPeriodEnd).toBeInstanceOf(Date);
    });

    it("is idempotent — skips if subscription already stored", async () => {
      const cusId = uniqueId("cus-idem");
      const subId = uniqueId("sub-idem");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        tier: "pro",
      });

      const session = {
        id: uniqueId("cs"),
        subscription: subId,
        customer: cusId,
      };

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
        latest_invoice: null,
      });

      await handleCheckoutCompleted(session);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("pro");
    });
  });

  describe("handleInvoicePaid", () => {
    it("grants 20k credits for pro tier", async () => {
      const cusId = uniqueId("cus-inv-pro");
      const subId = uniqueId("sub-inv-pro");
      const invId = uniqueId("inv-pro");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const invoice = {
        id: invId,
        customer: cusId,
        parent: {
          subscription_details: {
            subscription: subId,
          },
        },
      };

      const creditsBefore = await getOrgCredits(user.orgId);
      await handleInvoicePaid(invoice);
      const creditsAfter = await getOrgCredits(user.orgId);

      expect(creditsAfter! - creditsBefore!).toBe(20_000);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.lastProcessedInvoiceId).toBe(invId);
    });

    it("grants 80k credits for max tier", async () => {
      const cusId = uniqueId("cus-inv-max");
      const subId = uniqueId("sub-inv-max");
      const invId = uniqueId("inv-max");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_MAX } }] },
      });

      const invoice = {
        id: invId,
        customer: cusId,
        parent: {
          subscription_details: {
            subscription: subId,
          },
        },
      };

      const creditsBefore = await getOrgCredits(user.orgId);
      await handleInvoicePaid(invoice);
      const creditsAfter = await getOrgCredits(user.orgId);

      expect(creditsAfter! - creditsBefore!).toBe(80_000);
    });

    it("credits rollover — adds to existing balance", async () => {
      await grantCreditsToOrg(user.orgId, 5000);

      const cusId = uniqueId("cus-rollover");
      const subId = uniqueId("sub-rollover");
      const invId = uniqueId("inv-rollover");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const invoice = {
        id: invId,
        customer: cusId,
        parent: {
          subscription_details: {
            subscription: subId,
          },
        },
      };

      const creditsBefore = await getOrgCredits(user.orgId);
      await handleInvoicePaid(invoice);
      const creditsAfter = await getOrgCredits(user.orgId);

      expect(creditsAfter).toBe(creditsBefore! + 20_000);
    });

    it("is idempotent — duplicate invoice ID skipped", async () => {
      const cusId = uniqueId("cus-dedup");
      const subId = uniqueId("sub-dedup");
      const invId = uniqueId("inv-dedup");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        lastProcessedInvoiceId: invId,
      });

      const invoice = {
        id: invId,
        customer: cusId,
        parent: {
          subscription_details: {
            subscription: subId,
          },
        },
      };

      const creditsBefore = await getOrgCredits(user.orgId);
      await handleInvoicePaid(invoice);
      const creditsAfter = await getOrgCredits(user.orgId);

      expect(creditsAfter).toBe(creditsBefore);
    });

    it("skips invoices without subscription", async () => {
      const invoice = {
        id: uniqueId("inv-nosub"),
        customer: uniqueId("cus-nosub"),
        parent: null,
      };

      await handleInvoicePaid(invoice);
    });
  });

  describe("handleSubscriptionUpdated", () => {
    it("syncs status and tier", async () => {
      const cusId = uniqueId("cus-update");
      const subId = uniqueId("sub-update");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const subscription = {
        id: subId,
        status: "past_due",
        items: { data: [{ price: { id: TEST_PRICE_MAX } }] },
      };

      await handleSubscriptionUpdated(subscription);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.subscriptionStatus).toBe("past_due");
      expect(billing?.tier).toBe("max");
    });
  });

  describe("handleSubscriptionDeleted", () => {
    it("downgrades to free and clears subscription", async () => {
      const cusId = uniqueId("cus-delete");
      const subId = uniqueId("sub-delete");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "max",
      });

      const subscription = {
        id: subId,
      };

      await handleSubscriptionDeleted(subscription);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("free");
      expect(billing?.subscriptionStatus).toBe("canceled");
      expect(billing?.stripeSubscriptionId).toBeNull();
    });
  });

  describe("getBillingStatus", () => {
    it("returns correct data for subscribed org", async () => {
      const cusId = uniqueId("cus-status");
      const subId = uniqueId("sub-status");
      const periodEnd = new Date("2026-04-20T00:00:00Z");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        currentPeriodEnd: periodEnd,
        tier: "pro",
      });

      const status = await getBillingStatus(user.orgId);
      expect(status.tier).toBe("pro");
      expect(status.credits).toBe(2000);
      expect(status.subscriptionStatus).toBe("active");
      expect(status.currentPeriodEnd).toEqual(periodEnd);
      expect(status.hasSubscription).toBe(true);
    });

    it("returns defaults for free org", async () => {
      const newOrgId = uniqueId("org-billing-free");
      await ensureOrgRow(newOrgId);

      const status = await getBillingStatus(newOrgId);
      expect(status.tier).toBe("free");
      expect(status.credits).toBe(2000);
      expect(status.subscriptionStatus).toBeNull();
      expect(status.currentPeriodEnd).toBeNull();
      expect(status.hasSubscription).toBe(false);
    });

    it("returns defaults when org row does not exist", async () => {
      const status = await getBillingStatus(uniqueId("org-nonexistent"));
      expect(status.tier).toBe("free");
      expect(status.credits).toBe(0);
      expect(status.hasSubscription).toBe(false);
    });
  });
});
