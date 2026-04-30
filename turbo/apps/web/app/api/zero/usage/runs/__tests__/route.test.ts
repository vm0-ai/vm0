import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCompletedRun,
  createTestRequest,
  insertTestModelUsageEvent,
  insertTestModelUsageEventForRun,
  insertTestUsageEvent,
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

describe("GET /api/zero/usage/runs", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const { userId, orgId } = await context.user;
    mockClerk({ userId, orgId, orgRole: "org:member" });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(403);
  });

  it("returns empty result when no runs with processed usage events", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.runs).toEqual([]);
    expect(data.pagination.total).toBe(0);
  });

  it("returns per-run records with credit totals", async () => {
    const { userId, orgId } = await context.user;

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
      creditsCharged: 100,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // Each insertTestModelUsageEvent creates a separate run
    expect(data.runs).toHaveLength(2);
    expect(data.pagination.total).toBe(2);

    // Sorted by createdAt DESC — most recent first
    expect(data.runs[0].creditsCharged).toBe(100);
    expect(data.runs[1].creditsCharged).toBe(50);
  });

  it("paginates results correctly", async () => {
    const { userId, orgId } = await context.user;

    // Create 3 runs
    for (let i = 0; i < 3; i++) {
      await insertTestModelUsageEvent(orgId, {
        userId,
        creditsCharged: (i + 1) * 10,
        status: "processed",
      });
    }

    // Page 1 with pageSize=2
    const request1 = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs?page=1&pageSize=2",
    );
    const response1 = await GET(request1);
    const data1 = await response1.json();

    expect(data1.runs).toHaveLength(2);
    expect(data1.pagination.total).toBe(3);
    expect(data1.pagination.page).toBe(1);
    expect(data1.pagination.pageSize).toBe(2);

    // Page 2
    const request2 = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs?page=2&pageSize=2",
    );
    const response2 = await GET(request2);
    const data2 = await response2.json();

    expect(data2.runs).toHaveLength(1);
    expect(data2.pagination.page).toBe(2);
  });

  it("filters by userId", async () => {
    const { orgId } = await context.user;
    const user1 = uniqueId("user-alpha");
    const user2 = uniqueId("user-beta");

    await insertTestModelUsageEvent(orgId, {
      userId: user1,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestModelUsageEvent(orgId, {
      userId: user2,
      creditsCharged: 100,
      status: "processed",
    });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/usage/runs?userIds=${user1}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].creditsCharged).toBe(50);
  });

  it("excludes runs with only pending usage events", async () => {
    const { userId, orgId } = await context.user;

    await insertTestModelUsageEvent(orgId, {
      userId,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestModelUsageEvent(orgId, {
      userId,
      creditsCharged: 0,
      status: "pending",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // Only the processed run should appear
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].creditsCharged).toBe(50);
  });

  it("returns run-linked usage_event records and excludes runless events", async () => {
    const { userId, orgId } = await context.user;
    const runId = await createCompletedRun(orgId, userId, new Date());

    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: 300,
      creditsCharged: 30,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 1,
      creditsCharged: 20,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 1,
      creditsCharged: 999,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.runs).toHaveLength(1);
    expect(data.pagination.total).toBe(1);
    expect(data.runs[0]).toMatchObject({
      runId,
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 0,
      cacheTokens: 0,
      creditsCharged: 50,
    });
  });

  it("sums multiple usage_event totals for the same run", async () => {
    const { userId, orgId } = await context.user;
    const runId = await createCompletedRun(orgId, userId, new Date());

    await insertTestModelUsageEventForRun({
      runId,
      orgId,
      userId,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      creditsCharged: 40,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: 30,
      creditsCharged: 3,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.output",
      quantity: 70,
      creditsCharged: 7,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.cache_read",
      quantity: 11,
      creditsCharged: 1,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.cache_creation",
      quantity: 13,
      creditsCharged: 2,
      status: "processed",
    });
    await insertTestUsageEvent(orgId, {
      userId,
      runId,
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      quantity: 9999,
      creditsCharged: 999,
      status: "pending",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.runs).toHaveLength(1);
    expect(data.pagination.total).toBe(1);
    expect(data.runs[0]).toMatchObject({
      runId,
      inputTokens: 130,
      outputTokens: 120,
      cacheTokens: 54,
      creditsCharged: 53,
    });
  });
});
