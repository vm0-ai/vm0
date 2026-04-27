import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  insertTestCreditUsage,
  insertTestUsageEvent,
  updateOrgStripeFields,
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

describe("GET /api/zero/usage/members", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
    // Default so the Stripe refresh path in getOrgBillingPeriod never hits an
    // undefined response. Tests that exercise a stale/missing period still
    // benefit from a valid shape here.
    stripeMocks.subscriptionsRetrieve.mockResolvedValue({
      items: {
        data: [
          {
            current_period_end:
              Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          },
        ],
      },
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns empty result for free tier org (no billing period)", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.period).toBeNull();
    expect(data.members).toEqual([]);
  });

  it("returns aggregated usage for single user with processed records", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 150,
      creditsCharged: 100,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.period).not.toBeNull();
    expect(data.members).toHaveLength(1);
    expect(data.members[0].inputTokens).toBe(3000);
    expect(data.members[0].outputTokens).toBe(1500);
    expect(data.members[0].cacheReadInputTokens).toBe(500);
    expect(data.members[0].cacheCreationInputTokens).toBe(250);
    expect(data.members[0].creditsCharged).toBe(150);
  });

  it("returns separate aggregation for multiple users", async () => {
    const { orgId } = await context.user;
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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
      inputTokens: 1000,
      outputTokens: 500,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
      userId: user2,
      inputTokens: 3000,
      outputTokens: 1500,
      creditsCharged: 200,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members).toHaveLength(2);

    // Sorted by creditsCharged descending
    expect(data.members[0].creditsCharged).toBe(200);
    expect(data.members[1].creditsCharged).toBe(50);
  });

  it("excludes pending records from aggregation", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 1000,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 5000,
      creditsCharged: 0,
      status: "pending",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members).toHaveLength(1);
    expect(data.members[0].inputTokens).toBe(1000);
    expect(data.members[0].creditsCharged).toBe(50);
  });

  it("includes processed usage_event records in member totals", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestUsageEvent(orgId, {
      userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: 300,
      creditsCharged: 30,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.output",
      quantity: 120,
      creditsCharged: 12,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.cache_read",
      quantity: 80,
      creditsCharged: 8,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.cache_creation",
      quantity: 40,
      creditsCharged: 4,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 1,
      creditsCharged: 20,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: 9999,
      creditsCharged: 999,
      status: "pending",
    });

    const eventOnlyUserId = uniqueId("event-only-user");
    await insertTestUsageEvent(orgId, {
      userId: eventOnlyUserId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 1,
      creditsCharged: 200,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members).toHaveLength(2);

    const mixedMember = data.members.find((member: { userId: string }) => {
      return member.userId === userId;
    });
    expect(mixedMember).toMatchObject({
      inputTokens: 1300,
      outputTokens: 620,
      cacheReadInputTokens: 280,
      cacheCreationInputTokens: 140,
      creditsCharged: 124,
    });

    const eventOnlyMember = data.members.find((member: { userId: string }) => {
      return member.userId === eventOnlyUserId;
    });
    expect(eventOnlyMember).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      creditsCharged: 200,
    });
  });

  it("uses processedAt for billing-period membership", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const periodStart = new Date(periodEnd);
    periodStart.setMonth(periodStart.getMonth() - 1);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 10,
      outputTokens: 5,
      creditsCharged: 10,
      status: "processed",
      processedAt: periodStart,
    });
    await insertTestCreditUsage(orgId, {
      userId,
      inputTokens: 999,
      outputTokens: 999,
      creditsCharged: 999,
      status: "processed",
      processedAt: periodEnd,
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: 999,
      creditsCharged: 999,
      status: "processed",
      processedAt: periodEnd,
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members).toHaveLength(1);
    expect(data.members[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      creditsCharged: 10,
    });
  });
});
