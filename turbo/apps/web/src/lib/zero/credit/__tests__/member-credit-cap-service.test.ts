import { describe, it, expect, beforeEach, vi } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../__tests__/stripe-mock";
import {
  createTestOrg,
  insertOrgMembersEntry,
  getOrgMembersEntry,
  insertTestCreditUsage,
  updateOrgStripeFields,
} from "../../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../../env";
import { evaluateMemberCaps } from "../member-credit-cap-service";

// Mock stripe module (external dependency) — required because
// evaluateMemberCaps -> getOrgBillingPeriod may call Stripe
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

const context = testContext();

describe("evaluateMemberCaps", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();
  });

  it("does nothing when affectedUserIds is empty", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Should return without any DB changes
    await evaluateMemberCaps(orgId, []);
  });

  it("does nothing for free tier org (no billing period)", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Insert a capped member
    await insertOrgMembersEntry({
      orgId,
      userId,
      creditCap: 100,
      creditEnabled: true,
    });

    // Free tier — no billing period — should return without disabling
    await evaluateMemberCaps(orgId, [userId]);

    const member = await getOrgMembersEntry(orgId, userId);
    expect(member?.creditEnabled).toBe(true);
  });

  it("disables member who exceeds their credit cap", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Set up billing period (future date to avoid stale-period Stripe refresh)
    const periodEnd = new Date("2099-04-01T00:00:00Z");
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    // Insert member with cap of 50 credits
    await insertOrgMembersEntry({
      orgId,
      userId,
      creditCap: 50,
      creditEnabled: true,
    });

    // Insert processed credit usage exceeding cap (75 credits total)
    await insertTestCreditUsage(orgId, {
      userId,
      status: "processed",
      creditsCharged: 75,
      processedAt: new Date("2099-03-15T00:00:00Z"),
    });

    await evaluateMemberCaps(orgId, [userId]);

    const member = await getOrgMembersEntry(orgId, userId);
    expect(member?.creditEnabled).toBe(false);
  });

  it("does not disable member who is under their credit cap", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Set up billing period (future date to avoid stale-period Stripe refresh)
    const periodEnd = new Date("2099-04-01T00:00:00Z");
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    // Insert member with cap of 100 credits
    await insertOrgMembersEntry({
      orgId,
      userId,
      creditCap: 100,
      creditEnabled: true,
    });

    // Insert processed credit usage under cap (25 credits)
    await insertTestCreditUsage(orgId, {
      userId,
      status: "processed",
      creditsCharged: 25,
      processedAt: new Date("2099-03-15T00:00:00Z"),
    });

    await evaluateMemberCaps(orgId, [userId]);

    const member = await getOrgMembersEntry(orgId, userId);
    expect(member?.creditEnabled).toBe(true);
  });

  it("handles multiple members with different usage levels in batch", async () => {
    const userId1 = uniqueId("user");
    const userId2 = uniqueId("user");
    const slug = uniqueId("org");
    mockClerk({ userId: userId1 });
    const { id: orgId } = await createTestOrg(slug);

    // Set up billing period (future date to avoid stale-period Stripe refresh)
    const periodEnd = new Date("2099-04-01T00:00:00Z");
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    // User1: cap 50, usage 75 (over cap -> should be disabled)
    await insertOrgMembersEntry({
      orgId,
      userId: userId1,
      creditCap: 50,
      creditEnabled: true,
    });
    await insertTestCreditUsage(orgId, {
      userId: userId1,
      status: "processed",
      creditsCharged: 75,
      processedAt: new Date("2099-03-15T00:00:00Z"),
    });

    // User2: cap 100, usage 30 (under cap -> should remain enabled)
    await insertOrgMembersEntry({
      orgId,
      userId: userId2,
      creditCap: 100,
      creditEnabled: true,
    });
    await insertTestCreditUsage(orgId, {
      userId: userId2,
      status: "processed",
      creditsCharged: 30,
      processedAt: new Date("2099-03-15T00:00:00Z"),
    });

    await evaluateMemberCaps(orgId, [userId1, userId2]);

    const member1 = await getOrgMembersEntry(orgId, userId1);
    expect(member1?.creditEnabled).toBe(false);

    const member2 = await getOrgMembersEntry(orgId, userId2);
    expect(member2?.creditEnabled).toBe(true);
  });

  it("skips members without a credit cap set", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Set up billing period (future date to avoid stale-period Stripe refresh)
    const periodEnd = new Date("2099-04-01T00:00:00Z");
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    // Insert member without cap (null)
    await insertOrgMembersEntry({
      orgId,
      userId,
      creditCap: null,
      creditEnabled: true,
    });

    // Even with high usage, member without cap should remain enabled
    await insertTestCreditUsage(orgId, {
      userId,
      status: "processed",
      creditsCharged: 999,
      processedAt: new Date("2099-03-15T00:00:00Z"),
    });

    await evaluateMemberCaps(orgId, [userId]);

    const member = await getOrgMembersEntry(orgId, userId);
    expect(member?.creditEnabled).toBe(true);
  });

  it("does not re-enable already disabled members", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Set up billing period (future date to avoid stale-period Stripe refresh)
    const periodEnd = new Date("2099-04-01T00:00:00Z");
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
    });

    // Insert member that is already disabled with cap
    await insertOrgMembersEntry({
      orgId,
      userId,
      creditCap: 100,
      creditEnabled: false,
    });

    // Usage is under cap (10 credits), but member was previously disabled
    await insertTestCreditUsage(orgId, {
      userId,
      status: "processed",
      creditsCharged: 10,
      processedAt: new Date("2099-03-15T00:00:00Z"),
    });

    await evaluateMemberCaps(orgId, [userId]);

    // Should remain disabled (evaluateMemberCaps only disables, never re-enables)
    const member = await getOrgMembersEntry(orgId, userId);
    expect(member?.creditEnabled).toBe(false);
  });
});
