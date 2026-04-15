import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import {
  getOrgCredits,
  updateOrgTier,
  updateOrgStripeFields,
  updateOrgAutoRecharge,
  getOrgAutoRechargeFields,
} from "../../../../__tests__/api-test-helpers";

// Stripe mock — must be defined before importing the service
const stripeMocks = vi.hoisted(() => {
  return {
    invoicesCreate: vi.fn(),
    invoiceItemsCreate: vi.fn(),
    invoicesFinalize: vi.fn(),
    invoicesPay: vi.fn(),
    customersRetrieve: vi.fn(),
    subscriptionsRetrieve: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        invoices: {
          create: stripeMocks.invoicesCreate,
          finalizeInvoice: stripeMocks.invoicesFinalize,
          pay: stripeMocks.invoicesPay,
        },
        invoiceItems: { create: stripeMocks.invoiceItemsCreate },
        subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
        customers: {
          create: stripeMocks.customersRetrieve,
          retrieve: stripeMocks.customersRetrieve,
        },
        checkout: { sessions: { create: vi.fn() } },
        billingPortal: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
      };
    },
  };
});

import { reloadEnv } from "../../../../env";
import {
  triggerAutoRecharge,
  handleAutoRechargeInvoicePaid,
} from "../auto-recharge-service";

const context = testContext();

describe("auto-recharge-service", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();

    stripeMocks.invoicesCreate.mockReset();
    stripeMocks.invoiceItemsCreate.mockReset();
    stripeMocks.invoicesFinalize.mockReset();
    stripeMocks.invoicesPay.mockReset();
    stripeMocks.customersRetrieve.mockReset();
    stripeMocks.subscriptionsRetrieve.mockReset();

    // Default: Stripe calls succeed
    stripeMocks.customersRetrieve.mockResolvedValue({
      id: "cus_test",
      deleted: false,
      invoice_settings: { default_payment_method: "pm_test_default" },
    });
    stripeMocks.subscriptionsRetrieve.mockResolvedValue({
      default_payment_method: "pm_sub_default",
    });
    stripeMocks.invoicesCreate.mockResolvedValue({ id: "inv_auto_test" });
    stripeMocks.invoiceItemsCreate.mockResolvedValue({});
    stripeMocks.invoicesFinalize.mockResolvedValue({});
    stripeMocks.invoicesPay.mockResolvedValue({});
  });

  describe("triggerAutoRecharge", () => {
    it("skips when auto-recharge is disabled", async () => {
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: uniqueId("cus"),
      });
      // auto-recharge is disabled by default

      await triggerAutoRecharge(user.orgId);

      expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();
    });

    it("skips when tier is free", async () => {
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: uniqueId("cus"),
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 500,
        autoRechargeAmount: 5000,
      });

      await triggerAutoRecharge(user.orgId);

      expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();
    });

    it("skips when balance is above threshold", async () => {
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: uniqueId("cus"),
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 500,
        autoRechargeAmount: 5000,
      });
      // Default credits = 100000, threshold = 500 → above threshold

      await triggerAutoRecharge(user.orgId);

      expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();
    });

    it("skips when a recent pending recharge exists", async () => {
      const cusId = uniqueId("cus");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
        autoRechargePendingAt: new Date(), // just set now
      });

      await triggerAutoRecharge(user.orgId);

      expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();
    });

    it("creates Stripe invoice with correct amount when threshold is breached", async () => {
      const cusId = uniqueId("cus");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000, // balance (100000) is below this
        autoRechargeAmount: 10_000,
      });

      await triggerAutoRecharge(user.orgId);

      expect(stripeMocks.invoicesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: cusId,
          metadata: {
            type: "auto_recharge",
            orgId: user.orgId,
            creditsAmount: "10000",
          },
        }),
      );

      // 10000 credits / 1000 credits per dollar = $10 = 1000 cents
      expect(stripeMocks.invoiceItemsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          invoice: "inv_auto_test",
          customer: cusId,
          amount: 1000,
          currency: "usd",
        }),
      );

      expect(stripeMocks.invoicesFinalize).toHaveBeenCalledWith(
        "inv_auto_test",
      );
      expect(stripeMocks.invoicesPay).toHaveBeenCalledWith("inv_auto_test");

      // pending_at should be set
      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargePendingAt).toBeInstanceOf(Date);
    });

    it("clears pending flag on Stripe failure", async () => {
      const cusId = uniqueId("cus");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
      });

      stripeMocks.invoicesCreate.mockRejectedValue(new Error("Card declined"));

      await triggerAutoRecharge(user.orgId);

      // pending_at should be cleared after failure
      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargePendingAt).toBeNull();
    });

    it("retries when pending recharge is stale (>10 min)", async () => {
      const cusId = uniqueId("cus");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });

      // Set pending_at to 15 minutes ago (stale)
      const staleTime = new Date(Date.now() - 15 * 60 * 1000);
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
        autoRechargePendingAt: staleTime,
      });

      await triggerAutoRecharge(user.orgId);

      // Should have created a new invoice (retry after stale)
      expect(stripeMocks.invoicesCreate).toHaveBeenCalled();
    });

    it("concurrent triggers — only one succeeds", async () => {
      const cusId = uniqueId("cus");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
      });

      // Run two concurrent triggers
      await Promise.all([
        triggerAutoRecharge(user.orgId),
        triggerAutoRecharge(user.orgId),
      ]);

      // Only one should have created an invoice
      expect(stripeMocks.invoicesCreate).toHaveBeenCalledTimes(1);
    });

    it("skips when Stripe customer is deleted", async () => {
      const cusId = uniqueId("cus");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
      });

      stripeMocks.customersRetrieve.mockResolvedValue({ deleted: true });

      await triggerAutoRecharge(user.orgId);

      // No invoice should be created
      expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();
      // Pending flag should be cleared
      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargePendingAt).toBeNull();
    });

    it("skips when no payment method on customer or subscription", async () => {
      const cusId = uniqueId("cus");
      const subId = uniqueId("sub");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
      });

      // Customer has no default payment method
      stripeMocks.customersRetrieve.mockResolvedValue({
        id: cusId,
        deleted: false,
        invoice_settings: { default_payment_method: null },
      });
      // Subscription also has no payment method
      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        default_payment_method: null,
      });

      await triggerAutoRecharge(user.orgId);

      expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();
      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargePendingAt).toBeNull();
    });

    it("uses subscription payment method when customer has none", async () => {
      const cusId = uniqueId("cus");
      const subId = uniqueId("sub");
      await updateOrgTier(user.orgId, "pro");
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 110_000,
        autoRechargeAmount: 5000,
      });

      // Customer has no default payment method
      stripeMocks.customersRetrieve.mockResolvedValue({
        id: cusId,
        deleted: false,
        invoice_settings: { default_payment_method: null },
      });
      // Subscription has a payment method
      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        default_payment_method: "pm_from_subscription",
      });

      await triggerAutoRecharge(user.orgId);

      // Invoice should be created with subscription's payment method
      const invoiceCall = stripeMocks.invoicesCreate.mock.calls[0]?.[0];
      expect(invoiceCall?.default_payment_method).toBe("pm_from_subscription");
    });
  });

  describe("handleAutoRechargeInvoicePaid", () => {
    it("returns false for non-auto-recharge invoices", async () => {
      const result = await handleAutoRechargeInvoicePaid({
        id: "inv_sub",
        metadata: null,
      });
      expect(result).toBe(false);
    });

    it("returns false for invoices with different metadata type", async () => {
      const result = await handleAutoRechargeInvoicePaid({
        id: "inv_other",
        metadata: { type: "subscription" },
      });
      expect(result).toBe(false);
    });

    it("grants credits and clears pending flag", async () => {
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargePendingAt: new Date(),
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      const result = await handleAutoRechargeInvoicePaid({
        id: "inv_auto",
        metadata: {
          type: "auto_recharge",
          orgId: user.orgId,
          creditsAmount: "5000",
        },
      });

      expect(result).toBe(true);

      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter! - creditsBefore!).toBe(5000);

      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargePendingAt).toBeNull();
    });
  });
});
