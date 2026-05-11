import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgStripeFields,
  insertCreditExpiresRecord,
  insertOrgCacheEntry,
  grantCreditsToOrg,
  setOrgCredits,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../../src/__tests__/stripe-mock";

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

import { GET } from "../route";

const context = testContext();

describe("GET /api/zero/billing/status", () => {
  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    await setOrgCredits(user.orgId, 100_000);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns 401 when the user has no active org", async () => {
    mockClerk({ userId: uniqueId("no-org-user"), orgId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns billing status for authenticated user", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("free");
    expect(data.credits).toBe(100_000);
    expect(data.hasSubscription).toBe(false);
    expect(data.subscriptionStatus).toBeNull();
    expect(data.currentPeriodEnd).toBeNull();
  });

  it("returns correct data for subscribed org", async () => {
    const { orgId } = await context.setupUser({ prefix: "sub-user" });
    await setOrgCredits(orgId, 100_000);
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-status"),
      stripeSubscriptionId: uniqueId("sub-status"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("pro");
    expect(data.credits).toBe(100_000);
    expect(data.subscriptionStatus).toBe("active");
    expect(data.currentPeriodEnd).toBe(periodEnd.toISOString());
    expect(data.cancelAtPeriodEnd).toBe(false);
    expect(data.hasSubscription).toBe(true);
  });

  it("returns cancelAtPeriodEnd true when set", async () => {
    const { orgId } = await context.setupUser({ prefix: "cancel-user" });
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-cancel"),
      stripeSubscriptionId: uniqueId("sub-cancel"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
      tier: "pro",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.cancelAtPeriodEnd).toBe(true);
  });

  it("returns 200 for non-admin member", async () => {
    const { userId, orgId } = await context.setupUser({
      prefix: "member-status",
    });
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("includes creditExpiry data for paid org with expires records", async () => {
    const { orgId } = await context.setupUser({ prefix: "expiry-user" });
    const periodEnd = new Date("2026-04-20T00:00:00Z");
    const expiryDate = new Date("2026-05-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-expiry"),
      stripeSubscriptionId: uniqueId("sub-expiry"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertCreditExpiresRecord({
      orgId,
      amount: 20000,
      remaining: 15000,
      expiresAt: expiryDate,
      stripeInvoiceId: uniqueId("inv-expiry"),
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditExpiry.expiringNextCycle).toBe(15000);
    expect(data.creditExpiry.nextExpiryDate).toBe(expiryDate.toISOString());
    expect(data.creditGrants).toEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        label: "Pro plan",
        amount: 20000,
        remaining: 15000,
        expiresAt: expiryDate.toISOString(),
      }),
    ]);
  });

  it("returns zero creditExpiry for free org", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditExpiry.expiringNextCycle).toBe(0);
    expect(data.creditExpiry.nextExpiryDate).toBeNull();
  });

  it("displays credits minus not-yet-settled expired amount", async () => {
    // Dormant non-subscription org: expired row never got settled (no renewal
    // to trigger expireCredits, no run yet to trigger the eager path), so the
    // raw credits column is still inflated by the expired amount. The /status
    // endpoint must subtract it before returning so the UI shows the real
    // spendable balance.
    const { orgId } = await context.setupUser({ prefix: "expiry-unsettled" });
    // Seed a 100k baseline balance — the column default is now 0, so tests
    // that need a specific starting balance must seed it explicitly.
    await setOrgCredits(orgId, 100_000);

    const pastDate = new Date();
    pastDate.setMonth(pastDate.getMonth() - 1);
    await insertCreditExpiresRecord({
      orgId,
      amount: 3000,
      expiresAt: pastDate,
      stripeInvoiceId: uniqueId("inv-expired"),
    });
    // Mirror the inflated ledger: 100k baseline + 3k that's expired
    await grantCreditsToOrg(orgId, 3000);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/billing/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // 100_000 (seeded) + 3_000 (granted) − 3_000 (expired) = 100_000
    expect(data.credits).toBe(100_000);
  });

  it("maps auto_recharge expires records to Pay as you go segment", async () => {
    const { orgId } = await context.setupUser({ prefix: "payg-user" });
    await setOrgCredits(orgId, 40_000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-payg"),
      stripeSubscriptionId: uniqueId("sub-payg"),
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2026-05-20T00:00:00Z"),
      tier: "pro",
    });

    // Pro monthly grant
    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      amount: 20_000,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-sub"),
    });
    // Two separate auto-recharge top-ups — must merge into a single segment
    await insertCreditExpiresRecord({
      orgId,
      source: "auto_recharge",
      amount: 10_000,
      expiresAt: new Date("2999-12-31T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-ar1"),
    });
    await insertCreditExpiresRecord({
      orgId,
      source: "auto_recharge",
      amount: 10_000,
      expiresAt: new Date("2999-12-31T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-ar2"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    const payg = data.creditBreakdown.find((s: { category: string }) => {
      return s.category === "payAsYouGo";
    });
    expect(payg).toEqual({
      category: "payAsYouGo",
      label: "Pay as you go",
      credits: 20_000,
    });
    expect(
      data.creditGrants.filter((grant: { source: string }) => {
        return grant.source === "auto_recharge";
      }),
    ).toHaveLength(2);
  });

  it("maps subscription_renewal at Pro amount to Pro plan segment", async () => {
    const { orgId } = await context.setupUser({ prefix: "pro-renewal" });
    await setOrgCredits(orgId, 20_000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-pro"),
      stripeSubscriptionId: uniqueId("sub-pro"),
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2026-05-20T00:00:00Z"),
      tier: "pro",
    });

    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      amount: 20_000,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-pro"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditBreakdown).toEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
    ]);
  });

  it("maps subscription_renewal at Team amount to Team plan segment", async () => {
    const { orgId } = await context.setupUser({ prefix: "team-renewal" });
    await setOrgCredits(orgId, 120_000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-team"),
      stripeSubscriptionId: uniqueId("sub-team"),
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2026-05-20T00:00:00Z"),
      tier: "team",
    });

    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      amount: 120_000,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-team"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditBreakdown).toEqual([
      {
        category: "plan",
        label: "Team plan",
        credits: 120_000,
        tier: "team",
      },
    ]);
  });

  it("shows Team plan leftover alongside current Pro plan for a downgraded org", async () => {
    // Pro-tier org that still has unused credits from a prior Team renewal.
    const { orgId } = await context.setupUser({ prefix: "leftover-team" });
    await setOrgCredits(orgId, 20_000 + 40_000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-leftover"),
      stripeSubscriptionId: uniqueId("sub-leftover"),
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2026-05-20T00:00:00Z"),
      tier: "pro",
    });

    // Current Pro monthly grant
    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      amount: 20_000,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-pro-leftover"),
    });
    // Leftover Team renewal from previous cycle
    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      amount: 120_000,
      remaining: 40_000,
      expiresAt: new Date("2026-07-20T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-team-leftover"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditBreakdown).toEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
      {
        category: "plan",
        label: "Team plan",
        credits: 40_000,
        tier: "team",
      },
    ]);
  });

  it("maps starter_grant records to Free plan segment", async () => {
    const { orgId } = await context.setupUser({ prefix: "starter" });
    await setOrgCredits(orgId, 10_000);

    await insertCreditExpiresRecord({
      orgId,
      source: "starter_grant",
      amount: 10_000,
      expiresAt: new Date("2099-12-31T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-starter"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    const free = data.creditBreakdown.find((s: { category: string }) => {
      return s.category === "free";
    });
    expect(free).toEqual({
      category: "free",
      label: "Free plan",
      credits: 10_000,
    });
  });

  it("maps one_time_purchase records to Promotional segment", async () => {
    const { orgId } = await context.setupUser({ prefix: "promo-user" });
    await setOrgCredits(orgId, 5_000);

    await insertCreditExpiresRecord({
      orgId,
      source: "one_time_purchase",
      amount: 5_000,
      expiresAt: new Date("2099-12-31T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-promo"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    const promo = data.creditBreakdown.find((s: { category: string }) => {
      return s.category === "promotional";
    });
    expect(promo).toEqual({
      category: "promotional",
      label: "Promotional",
      credits: 5_000,
    });
  });

  it("surfaces untracked paid-tier balance as Pay as you go fallback", async () => {
    // Paid-tier org whose ledger shows more credits than any active expires
    // record accounts for (pre-sentinel top-up / historical drift).
    const { orgId } = await context.setupUser({ prefix: "untracked-pro" });
    await setOrgCredits(orgId, 25_000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus-untracked"),
      stripeSubscriptionId: uniqueId("sub-untracked"),
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2026-05-20T00:00:00Z"),
      tier: "pro",
    });

    // Only 20k is tracked via the Pro renewal record
    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      amount: 20_000,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-untracked-sub"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.creditBreakdown).toEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
      {
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: 5_000,
      },
    ]);
    expect(
      data.creditGrants.some((grant: { source: string }) => {
        return grant.source === "auto_recharge";
      }),
    ).toBe(false);
  });

  it("merges untracked balance on free tier into Free plan segment", async () => {
    // Free-tier org where `org_metadata.credits` exceeds the starter_grant
    // record's remaining. The delta should render under "Free plan", not
    // "Pay as you go".
    const { orgId } = await context.setupUser({ prefix: "untracked-free" });
    await setOrgCredits(orgId, 12_000);

    await insertCreditExpiresRecord({
      orgId,
      source: "starter_grant",
      amount: 10_000,
      expiresAt: new Date("2099-12-31T00:00:00Z"),
      stripeInvoiceId: uniqueId("inv-free-starter"),
    });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/billing/status"),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    const free = data.creditBreakdown.find((s: { category: string }) => {
      return s.category === "free";
    });
    expect(free).toEqual({
      category: "free",
      label: "Free plan",
      credits: 12_000,
    });
    // No "Pay as you go" segment should be emitted on free tier.
    expect(
      data.creditBreakdown.find((s: { category: string }) => {
        return s.category === "payAsYouGo";
      }),
    ).toBeUndefined();
  });

  it("returns defaults when org row does not exist", async () => {
    const newOrgId = uniqueId("org-norow");
    const newSlug = `billing-norow-${Date.now()}`;
    mockClerk({
      userId: uniqueId("user"),
      orgId: newOrgId,
      orgSlug: newSlug,
      orgRole: "org:admin",
      clerkOrgs: [{ id: newOrgId, slug: newSlug, name: "NoRow" }],
    });

    // Populate org_cache so resolveOrg recognizes this org (no org_metadata row)
    await insertOrgCacheEntry({ orgId: newOrgId, slug: newSlug });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/billing/status`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tier).toBe("free");
    expect(data.credits).toBe(0);
    expect(data.hasSubscription).toBe(false);
  });
});
