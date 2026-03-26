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
} from "../../../../../src/__tests__/api-test-helpers";
import type { StripeMockFns } from "../../../../../src/__tests__/stripe-mock";
import { reloadEnv } from "../../../../../src/env";

// Mock stripe module (external dependency)
const stripeMocks = vi.hoisted<StripeMockFns>(() => ({
  subscriptionsRetrieve: vi.fn(),
  subscriptionsUpdate: vi.fn(),
  subscriptionsCancel: vi.fn(),
  invoicesRetrieve: vi.fn(),
  invoicesList: vi.fn(),
  customersCreate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  billingPortalSessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
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
}));

// Import route handler AFTER mocks are set up
import { POST } from "../route";

const TEST_WEBHOOK_SECRET = "whsec_test_secret";
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";

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
    vi.stubEnv("ZERO_PRO_PLAN_PRICE_ID", TEST_PRICE_PRO);
    vi.stubEnv("ZERO_MAX_PLAN_PRICE_ID", TEST_PRICE_TEAM);
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
        latest_invoice: null,
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
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      });

      expect(response.status).toBe(200);

      const billing = await getOrgBillingFields(user.orgId);
      expect(billing?.tier).toBe("pro");
      expect(billing?.subscriptionStatus).toBe("active");
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
    });
  });
});
