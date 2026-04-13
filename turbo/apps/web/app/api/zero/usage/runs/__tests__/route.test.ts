import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  insertTestCreditUsage,
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

  it("returns empty result when no runs with credit usage", async () => {
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
      creditsCharged: 100,
      status: "processed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/usage/runs",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // Each insertTestCreditUsage creates a separate run
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
      await insertTestCreditUsage(orgId, {
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
      `http://localhost:3000/api/zero/usage/runs?userIds=${user1}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].creditsCharged).toBe(50);
  });

  it("excludes runs with only pending credit usage", async () => {
    const { userId, orgId } = await context.user;

    await insertTestCreditUsage(orgId, {
      userId,
      creditsCharged: 50,
      status: "processed",
    });

    await insertTestCreditUsage(orgId, {
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
});
