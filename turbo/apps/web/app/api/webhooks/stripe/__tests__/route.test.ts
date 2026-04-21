import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  getOrgCredits,
  updateOrgStripeFields,
  getOrgBillingFields,
  grantCreditsToOrg,
  updateOrgAutoRecharge,
  getOrgAutoRechargeFields,
  insertOrgMembersEntry,
  getOrgMembersEntry,
  findCreditExpiresRecords,
  insertCreditExpiresRecord,
  setOrgCredits,
} from "../../../../../src/__tests__/api-test-helpers";
import type { StripeMockFns } from "../../../../../src/__tests__/stripe-mock";
import { reloadEnv } from "../../../../../src/env";

// Mock stripe module (external dependency)
const stripeMocks = vi.hoisted<StripeMockFns>(() => {
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
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: {
          retrieve: stripeMocks.subscriptionsRetrieve,
          update: stripeMocks.subscriptionsUpdate,
          cancel: stripeMocks.subscriptionsCancel,
        },
        invoices: {
          retrieve: stripeMocks.invoicesRetrieve,
          list: stripeMocks.invoicesList,
        },
        customers: { create: stripeMocks.customersCreate },
        checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
        billingPortal: {
          sessions: { create: stripeMocks.billingPortalSessionsCreate },
        },
        webhooks: { constructEvent: stripeMocks.constructEvent },
      };
    },
  };
});

// Import route handler AFTER mocks are set up
import { POST } from "../route";

const TEST_WEBHOOK_SECRET = "whsec_test_secret";
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_TEAM_LEGACY = "price_test_team_legacy";

const TEST_ZERO_PRICE = JSON.stringify({
  pro: [TEST_PRICE_PRO],
  team: [TEST_PRICE_TEAM, TEST_PRICE_TEAM_LEGACY],
});

/**
 * Build a minimal invoice.lines payload carrying a subscription line item
 * whose period.end matches the real subscription billing-cycle end.
 *
 * This mirrors the shape `handleInvoicePaid` now reads from — specifically,
 * `invoice.lines.data[i].period.end` where the line's parent type is
 * `"subscription_item_details"`. See issue #9777.
 */
function invoiceLinesWithSubscriptionPeriod(periodEnd: number) {
  return {
    data: [
      {
        period: { end: periodEnd },
        parent: { type: "subscription_item_details" as const },
      },
    ],
  };
}

const context = testContext();

/** Create a Stripe webhook request */
function createStripeWebhookRequest(
  body: string,
  options?: { missingSignature?: boolean },
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (!options?.missingSignature) {
    headers["stripe-signature"] = "t=123,v1=abc";
  }

  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body,
  });
}

/** Helper to send a webhook event through the route */
async function sendWebhookEvent(
  type: string,
  dataObject: Record<string, unknown>,
): Promise<Response> {
  stripeMocks.constructEvent.mockReturnValue({
    id: uniqueId("evt"),
    type,
    data: { object: dataObject },
  });

  const request = createStripeWebhookRequest(JSON.stringify({ type }));
  return POST(request);
}

describe("POST /api/webhooks/stripe", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    vi.stubEnv("ZERO_PRICE", TEST_ZERO_PRICE);
    reloadEnv();

    stripeMocks.constructEvent.mockReset();
    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.invoicesRetrieve.mockReset();
  });

  it("returns 503 when STRIPE_WEBHOOK_SECRET is not configured", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    reloadEnv();

    const request = createStripeWebhookRequest("{}");
    const response = await POST(request);

    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toContain("not configured");
  });

  it("returns 401 when stripe-signature header is missing", async () => {
    const request = createStripeWebhookRequest("{}", {
      missingSignature: true,
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("stripe-signature");
  });

  it("returns 401 when signature verification fails", async () => {
    stripeMocks.constructEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const request = createStripeWebhookRequest(
      JSON.stringify({ type: "checkout.session.completed" }),
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Invalid webhook signature");
  });

  it("returns 200 for unhandled event types without processing", async () => {
    const response = await sendWebhookEvent("payment_intent.created", {});
    expect(response.status).toBe(200);
  });

  describe("checkout.session.completed", () => {
    it("activates subscription and sets tier", async () => {
      const cusId = uniqueId("cus-checkout");
      const subId = uniqueId("sub-checkout");
      const itemPeriodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: {
          data: [
            {
              price: { id: TEST_PRICE_PRO },
              current_period_end: itemPeriodEnd,
            },
          ],
        },
      });

      const response = await sendWebhookEvent("checkout.session.completed", {
        id: uniqueId("cs"),
        subscription: subId,
        customer: cusId,
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("pro");
      expect(billing?.stripeSubscriptionId).toBe(subId);
      expect(billing?.subscriptionStatus).toBe("active");
      expect(billing?.currentPeriodEnd).toBeInstanceOf(Date);
      expect(billing?.cancelAtPeriodEnd).toBe(false);
      // invoices.retrieve must NOT be called — checkout handler now reads
      // period end directly from subscription.items (issue #9777).
      expect(stripeMocks.invoicesRetrieve).not.toHaveBeenCalled();
    });

    it("is idempotent — skips if subscription already stored", async () => {
      const cusId = uniqueId("cus-idem");
      const subId = uniqueId("sub-idem");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        tier: "pro",
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const response = await sendWebhookEvent("checkout.session.completed", {
        id: uniqueId("cs"),
        subscription: subId,
        customer: cusId,
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("pro");
    });
  });

  describe("invoice.paid", () => {
    it("grants 20k credits for pro tier", async () => {
      const cusId = uniqueId("cus-inv-pro");
      const subId = uniqueId("sub-inv-pro");
      const invId = uniqueId("inv-pro");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      const response = await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      expect(response.status).toBe(200);

      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter! - creditsBefore!).toBe(20_000);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.lastProcessedInvoiceId).toBe(invId);
    });

    it("grants 120k credits for team tier", async () => {
      const cusId = uniqueId("cus-inv-team");
      const subId = uniqueId("sub-inv-team");
      const invId = uniqueId("inv-team");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_TEAM } }] },
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      const response = await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      expect(response.status).toBe(200);

      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter! - creditsBefore!).toBe(120_000);
    });

    it("credits rollover — adds to existing balance", async () => {
      await grantCreditsToOrg(user.orgId, 5000);

      const cusId = uniqueId("cus-rollover");
      const subId = uniqueId("sub-rollover");
      const invId = uniqueId("inv-rollover");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

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

      const creditsBefore = await getOrgCredits(user.orgId);

      await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        parent: { subscription_details: { subscription: subId } },
      });

      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter).toBe(creditsBefore);
    });

    it("skips invoices without subscription", async () => {
      const response = await sendWebhookEvent("invoice.paid", {
        id: uniqueId("inv-nosub"),
        customer: uniqueId("cus-nosub"),
        parent: null,
      });

      expect(response.status).toBe(200);
    });

    it("grants credits for auto-recharge invoice via metadata", async () => {
      const cusId = uniqueId("cus-auto");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargePendingAt: new Date(),
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      const response = await sendWebhookEvent("invoice.paid", {
        id: uniqueId("inv-auto"),
        customer: cusId,
        metadata: {
          type: "auto_recharge",
          orgId: user.orgId,
          creditsAmount: "5000",
        },
        parent: null,
      });

      expect(response.status).toBe(200);

      // Credits should be granted
      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter! - creditsBefore!).toBe(5000);

      // Pending flag should be cleared
      const autoRecharge = await getOrgAutoRechargeFields(user.orgId);
      expect(autoRecharge?.autoRechargePendingAt).toBeNull();
    });

    it("resets disabled member credit flags on invoice.paid", async () => {
      const cusId = uniqueId("cus-reset");
      const subId = uniqueId("sub-reset");
      const invId = uniqueId("inv-reset");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      // Insert a disabled member
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const response = await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      expect(response.status).toBe(200);

      // Member should be re-enabled after invoice.paid
      const member = await getOrgMembersEntry(user.orgId, user.userId);
      expect(member?.creditEnabled).toBe(true);
    });
  });

  describe("customer.subscription.updated", () => {
    it("syncs status and tier", async () => {
      const cusId = uniqueId("cus-update");
      const subId = uniqueId("sub-update");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await sendWebhookEvent("customer.subscription.updated", {
        id: subId,
        status: "past_due",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: TEST_PRICE_TEAM } }] },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.subscriptionStatus).toBe("past_due");
      expect(billing?.tier).toBe("team");
    });

    it("downgrades tier from team to pro when price changes", async () => {
      const cusId = uniqueId("cus-downgrade");
      const subId = uniqueId("sub-downgrade");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "team",
      });

      const response = await sendWebhookEvent("customer.subscription.updated", {
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("pro");
      expect(billing?.subscriptionStatus).toBe("active");
    });

    it("resolves legacy price ID to correct tier", async () => {
      const cusId = uniqueId("cus-legacy");
      const subId = uniqueId("sub-legacy");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await sendWebhookEvent("customer.subscription.updated", {
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: TEST_PRICE_TEAM_LEGACY } }] },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("team");
    });

    it("syncs cancelAtPeriodEnd true from subscription.updated", async () => {
      const cusId = uniqueId("cus-cancel-sync");
      const subId = uniqueId("sub-cancel-sync");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await sendWebhookEvent("customer.subscription.updated", {
        id: subId,
        status: "active",
        cancel_at_period_end: true,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.cancelAtPeriodEnd).toBe(true);
    });

    it("clears cancelAtPeriodEnd when subscription is uncancelled", async () => {
      const cusId = uniqueId("cus-uncancel");
      const subId = uniqueId("sub-uncancel");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        tier: "pro",
      });

      const response = await sendWebhookEvent("customer.subscription.updated", {
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.cancelAtPeriodEnd).toBe(false);
    });
  });

  describe("invoice.paid — credit expiry", () => {
    it("creates expires record with correct expires_at", async () => {
      const cusId = uniqueId("cus-exp-create");
      const subId = uniqueId("sub-exp-create");
      const invId = uniqueId("inv-exp-create");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const response = await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      expect(response.status).toBe(200);

      const records = await findCreditExpiresRecords(user.orgId);
      expect(records).toHaveLength(1);
      expect(records[0]!.amount).toBe(20000);
      expect(records[0]!.remaining).toBe(20000);
      expect(records[0]!.stripeInvoiceId).toBe(invId);

      // expires_at should be subscription line period.end + 1 month
      const expectedExpiresAt = new Date(periodEnd * 1000);
      expectedExpiresAt.setMonth(expectedExpiresAt.getMonth() + 1);
      expect(records[0]!.expiresAt.getTime()).toBe(expectedExpiresAt.getTime());
    });

    it("expires old credits before granting new ones", async () => {
      const cusId = uniqueId("cus-exp-settle");
      const subId = uniqueId("sub-exp-settle");
      const invId = uniqueId("inv-exp-settle");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      // Seed enough baseline credits so expireCredits can deduct 3000
      // without hitting the GREATEST(balance - expired, 0) clamp at 0.
      await setOrgCredits(user.orgId, 100_000);
      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      // Insert an expired record with 3000 remaining
      const pastDate = new Date();
      pastDate.setMonth(pastDate.getMonth() - 1);
      await insertCreditExpiresRecord({
        orgId: user.orgId,
        amount: 5000,
        remaining: 3000,
        expiresAt: pastDate,
        stripeInvoiceId: uniqueId("inv-old"),
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const response = await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      expect(response.status).toBe(200);

      // Net change: -3000 (expired) + 20000 (granted) = +17000
      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter! - creditsBefore!).toBe(17000);

      // Old record should be settled
      const records = await findCreditExpiresRecords(user.orgId);
      const oldRecord = records.find((r) => {
        return r.stripeInvoiceId !== invId;
      });
      expect(oldRecord?.remaining).toBe(0);
    });

    it("duplicate invoice.paid is idempotent for expires records", async () => {
      const cusId = uniqueId("cus-exp-idem");
      const subId = uniqueId("sub-exp-idem");
      const invId = uniqueId("inv-exp-idem");
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      // First call
      await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      // Second call — should be skipped via lastProcessedInvoiceId
      await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      const records = await findCreditExpiresRecords(user.orgId);
      expect(records).toHaveLength(1);
    });

    it("throws and rolls back transaction when no subscription line item has period.end", async () => {
      const cusId = uniqueId("cus-no-period-end");
      const subId = uniqueId("sub-no-period-end");
      const invId = uniqueId("inv-no-period-end");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      const creditsBefore = await getOrgCredits(user.orgId);

      // Send invoice.paid with lines.data containing no subscription_item_details
      // line — handler throws because it cannot derive the subscription
      // period end from the invoice.
      await expect(
        sendWebhookEvent("invoice.paid", {
          id: invId,
          customer: cusId,
          parent: { subscription_details: { subscription: subId } },
          lines: { data: [] },
        }),
      ).rejects.toThrow("no subscription line item with period.end");

      // Credits must NOT have changed (transaction rolled back)
      const creditsAfter = await getOrgCredits(user.orgId);
      expect(creditsAfter).toBe(creditsBefore);

      // No expires record should have been created
      const records = await findCreditExpiresRecords(user.orgId);
      expect(records).toHaveLength(0);
    });

    it("writes subscription line period.end to currentPeriodEnd (not invoice.period_end) — regression for #9777", async () => {
      // Regression test: before the fix, handleInvoicePaid read the
      // top-level invoice.period_end, which on a renewal invoice collapses
      // to the invoice creation moment — NOT the next renewal date.
      // This resulted in currentPeriodEnd being persisted as a stale
      // timestamp, producing an infinite "currentPeriodEnd is stale"
      // warning loop every time getOrgBillingPeriod was called.
      const cusId = uniqueId("cus-regression");
      const subId = uniqueId("sub-regression");
      const invId = uniqueId("inv-regression");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
      });

      stripeMocks.subscriptionsRetrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      // Simulate the exact shape of a real Stripe renewal invoice:
      // the top-level invoice.period_end reflects the INVOICE accrual
      // period (effectively the invoice creation moment), while the
      // subscription line item's period.end is the actual next renewal
      // date. The handler MUST use the latter.
      const invoiceAccrualEnd = Math.floor(
        new Date("2026-03-26T07:24:12Z").getTime() / 1000,
      );
      const subscriptionPeriodEnd = Math.floor(
        new Date("2026-04-26T07:24:12Z").getTime() / 1000,
      );

      const response = await sendWebhookEvent("invoice.paid", {
        id: invId,
        customer: cusId,
        period_end: invoiceAccrualEnd, // wrong field — must be ignored
        lines: invoiceLinesWithSubscriptionPeriod(subscriptionPeriodEnd),
        parent: { subscription_details: { subscription: subId } },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      // currentPeriodEnd must be the subscription period end (Apr 26),
      // NOT the invoice accrual end (Mar 26).
      expect(billing?.currentPeriodEnd).toEqual(
        new Date("2026-04-26T07:24:12Z"),
      );
    });

    it("auto-recharge does NOT create expires record", async () => {
      const cusId = uniqueId("cus-exp-auto");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
      });
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargePendingAt: new Date(),
      });

      const response = await sendWebhookEvent("invoice.paid", {
        id: uniqueId("inv-auto-exp"),
        customer: cusId,
        metadata: {
          type: "auto_recharge",
          orgId: user.orgId,
          creditsAmount: "5000",
        },
        parent: null,
      });

      expect(response.status).toBe(200);

      const records = await findCreditExpiresRecords(user.orgId);
      expect(records).toHaveLength(0);
    });
  });

  describe("customer.subscription.deleted", () => {
    it("downgrades to free and clears subscription", async () => {
      const cusId = uniqueId("cus-delete");
      const subId = uniqueId("sub-delete");

      await updateOrgStripeFields(user.orgId, {
        stripeCustomerId: cusId,
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        tier: "team",
      });

      const response = await sendWebhookEvent("customer.subscription.deleted", {
        id: subId,
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("free");
      expect(billing?.subscriptionStatus).toBe("canceled");
      expect(billing?.stripeSubscriptionId).toBeNull();
      expect(billing?.cancelAtPeriodEnd).toBe(false);
    });
  });
});
