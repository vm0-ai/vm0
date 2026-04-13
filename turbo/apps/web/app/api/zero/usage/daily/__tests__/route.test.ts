import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  insertTestCreditUsage,
  setTestCreditUsageCreatedAt,
  updateOrgStripeFields,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

// Only the subscriptions/invoices retrieve methods can be reached transitively
// via getOrgBillingPeriod() when an org has a stripeSubscriptionId.
const stripeMocks = vi.hoisted(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    invoicesRetrieve: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
        invoices: { retrieve: stripeMocks.invoicesRetrieve },
      };
    },
  };
});

import { GET } from "../route";

const context = testContext();

describe("GET /api/zero/usage/daily", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const { userId, orgId } = await context.user;
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily",
    );
    const response = await GET(request);

    expect(response.status).toBe(403);
  });

  it("returns empty result for free tier org", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.period).toBeNull();
    expect(data.daily).toEqual([]);
    expect(data.dailyByMember).toEqual([]);
  });

  it("returns daily credit totals in total mode", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 100,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily?mode=total",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.period).not.toBeNull();
    expect(data.daily.length).toBeGreaterThanOrEqual(1);

    // Both records are on the same day, so total should be 150
    const totalCredits = data.daily.reduce(
      (sum: number, d: { creditsCharged: number }) => {
        return sum + d.creditsCharged;
      },
      0,
    );
    expect(totalCredits).toBe(150);
  });

  it("returns per-member breakdown in member mode", async () => {
    const { orgId } = await context.user;
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    const user1 = uniqueId("user-alpha");
    const user2 = uniqueId("user-beta");

    await insertTestCreditUsage(orgId, {
      userId: user1,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
      userId: user2,
      creditsCharged: 100,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily?mode=member",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.dailyByMember.length).toBeGreaterThanOrEqual(1);

    // Check that members are present in the breakdown
    const firstDay = data.dailyByMember[0];
    expect(firstDay.members.length).toBe(2);
  });

  it("filters by dateFrom and dateTo query params", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    // Insert three records, then back-date them to span a known range.
    const oldId = await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 10,
      status: "processed",
    });
    const inRangeId = await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 20,
      status: "processed",
    });
    const newId = await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 30,
      status: "processed",
    });

    await setTestCreditUsageCreatedAt(oldId, new Date("2026-03-01T12:00:00Z"));
    await setTestCreditUsageCreatedAt(
      inRangeId,
      new Date("2026-03-15T12:00:00Z"),
    );
    await setTestCreditUsageCreatedAt(newId, new Date("2026-04-01T12:00:00Z"));

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily?mode=total&dateFrom=2026-03-10T00:00:00Z&dateTo=2026-03-20T00:00:00Z",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();

    // Only the in-range record (creditsCharged=20) should be aggregated.
    const totalCredits = data.daily.reduce(
      (sum: number, d: { creditsCharged: number }) => {
        return sum + d.creditsCharged;
      },
      0,
    );
    expect(totalCredits).toBe(20);
    expect(data.daily.length).toBe(1);
    expect(data.daily[0].date).toBe("2026-03-15");
  });

  it("excludes pending records", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date("2026-04-20T00:00:00Z");

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 999,
      status: "pending",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/daily?mode=total",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    const totalCredits = data.daily.reduce(
      (sum: number, d: { creditsCharged: number }) => {
        return sum + d.creditsCharged;
      },
      0,
    );
    expect(totalCredits).toBe(50);
  });
});
