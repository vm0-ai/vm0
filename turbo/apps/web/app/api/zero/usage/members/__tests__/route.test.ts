import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  insertTestModelUsageEvent,
  insertTestUsageEvent,
  seedRealtimeBillingPricing,
  updateOrgStripeFields,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../../../src/__tests__/stripe-mock";
import {
  REALTIME_PROVIDER,
  REALTIME_TOKEN_CATEGORIES,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
} from "../../../../../../src/lib/zero/billing/model-usage-categories";

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

    await insertTestModelUsageEvent(orgId, {
      userId,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestModelUsageEvent(orgId, {
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

    await insertTestModelUsageEvent(orgId, {
      userId: user1,
      inputTokens: 1000,
      outputTokens: 500,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestModelUsageEvent(orgId, {
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

    await insertTestModelUsageEvent(orgId, {
      userId,
      inputTokens: 1000,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestModelUsageEvent(orgId, {
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

    await insertTestModelUsageEvent(orgId, {
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

  it("rolls up Realtime and transcription per-modality categories into the four bucket totals", async () => {
    const { userId, orgId } = await context.user;
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await updateOrgStripeFields(orgId, {
      stripeCustomerId: uniqueId("cus"),
      stripeSubscriptionId: uniqueId("sub"),
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd,
      tier: "pro",
    });

    // Pricing is configured in production via migration 0345. Seed the same
    // matrix here so the test setup mirrors a real org that has Realtime
    // billing enabled, and so this test is the first consumer of the shared
    // helper that #12140's admission test will reuse.
    await seedRealtimeBillingPricing();

    // Realtime Talker (gpt-realtime-2) emits six per-modality categories that
    // collapse into the four flat buckets used by member/run totals. Each
    // quantity below picks a distinct prime-ish number so the rollup math is
    // unambiguous even if the bucket mapping shifts.
    const realtimeQuantities: Record<
      (typeof REALTIME_TOKEN_CATEGORIES)[number],
      number
    > = {
      "tokens.input.text": 100,
      "tokens.input.audio": 200,
      "tokens.input.cached_text": 30,
      "tokens.input.cached_audio": 70,
      "tokens.output.text": 40,
      "tokens.output.audio": 60,
    };
    for (const category of REALTIME_TOKEN_CATEGORIES) {
      await insertTestUsageEvent(orgId, {
        userId,
        kind: "model",
        provider: REALTIME_PROVIDER,
        category,
        quantity: realtimeQuantities[category],
        status: "processed",
      });
    }

    // Input transcription (gpt-4o-mini-transcribe).
    const transcriptionQuantities: Record<
      (typeof TRANSCRIPTION_TOKEN_CATEGORIES)[number],
      number
    > = {
      "tokens.input.audio": 500,
      "tokens.input.text": 25,
      "tokens.output.text": 15,
    };
    for (const category of TRANSCRIPTION_TOKEN_CATEGORIES) {
      await insertTestUsageEvent(orgId, {
        userId,
        kind: "model",
        provider: TRANSCRIPTION_PROVIDER,
        category,
        quantity: transcriptionQuantities[category],
        status: "processed",
      });
    }

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/members",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.members).toHaveLength(1);

    // inputTokens = realtime input.text + input.audio
    //               + transcription input.audio + input.text
    //             = 100 + 200 + 500 + 25 = 825
    // outputTokens = realtime output.text + output.audio
    //                + transcription output.text
    //              = 40 + 60 + 15 = 115
    // cacheReadInputTokens = realtime input.cached_text + input.cached_audio
    //                      = 30 + 70 = 100
    // cacheCreationInputTokens stays 0 (Realtime has no cache_creation category)
    expect(data.members[0]).toMatchObject({
      inputTokens: 825,
      outputTokens: 115,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
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

    await insertTestModelUsageEvent(orgId, {
      userId,
      inputTokens: 10,
      outputTokens: 5,
      creditsCharged: 10,
      status: "processed",
      processedAt: periodStart,
    });
    await insertTestModelUsageEvent(orgId, {
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
