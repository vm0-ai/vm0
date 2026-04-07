import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  ensureOrgRow,
  seedInsightsDaily,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

/** Return an ISO date string N days ago from today. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function defaultInsightData(overrides?: Record<string, unknown>) {
  return {
    agents: [
      { agentName: "Test Agent", agentId: "agent-1", runs: 5, credits: 100 },
    ],
    creditsUsed: 100,
    creditBalance: 9900,
    teamUsage: [{ name: "alice", credits: 100 }],
    topTask: { name: "Send message", count: 10 },
    services: [
      {
        name: "api.slack.com",
        domain: "api.slack.com",
        calls: 10,
        agentNames: ["Test Agent"],
      },
    ],
    permissions: [
      {
        label: "chat:write",
        allowed: 8,
        denied: 2,
        agentNames: ["Test Agent"],
      },
    ],
    ...overrides,
  };
}

describe("GET /api/zero/insights", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    await ensureOrgRow(user.orgId);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return empty days when no insights exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toEqual([]);
    expect(data.totalCredits).toBe(0);
    expect(data.totalRuns).toBe(0);
  });

  it("should return insights with correct structure", async () => {
    const yesterday = daysAgo(1);
    await seedInsightsDaily(
      user.orgId,
      yesterday,
      defaultInsightData(),
      user.userId,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toHaveLength(1);
    expect(data.days[0].date).toBe(yesterday);
    expect(data.days[0].agents).toHaveLength(1);
    expect(data.days[0].agents[0].agentName).toBe("Test Agent");
    expect(data.days[0].creditsUsed).toBe(100);
    expect(data.totalCredits).toBe(100);
    expect(data.totalRuns).toBe(5);
  });

  it("should aggregate totals across multiple days", async () => {
    await seedInsightsDaily(
      user.orgId,
      daysAgo(1),
      defaultInsightData(),
      user.userId,
    );
    await seedInsightsDaily(
      user.orgId,
      daysAgo(2),
      defaultInsightData({
        agents: [
          {
            agentName: "Agent B",
            agentId: "agent-2",
            runs: 3,
            credits: 200,
          },
        ],
        creditsUsed: 200,
      }),
      user.userId,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toHaveLength(2);
    expect(data.totalCredits).toBe(300);
    expect(data.totalRuns).toBe(8);
  });

  it("should respect days query parameter", async () => {
    await seedInsightsDaily(
      user.orgId,
      daysAgo(1),
      defaultInsightData(),
      user.userId,
    );
    await seedInsightsDaily(
      user.orgId,
      daysAgo(2),
      defaultInsightData({ creditsUsed: 50 }),
      user.userId,
    );
    await seedInsightsDaily(
      user.orgId,
      daysAgo(5),
      defaultInsightData({ creditsUsed: 75 }),
      user.userId,
    );

    // days=3 covers daysAgo(1) and daysAgo(2) but not daysAgo(5)
    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights?days=3",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toHaveLength(2);
  });

  it("should clamp days parameter between 1 and 90", async () => {
    await seedInsightsDaily(
      user.orgId,
      daysAgo(0),
      defaultInsightData(),
      user.userId,
    );

    // days=0 should clamp to 1
    const request1 = createTestRequest(
      "http://localhost:3000/api/zero/insights?days=0",
    );
    const response1 = await GET(request1);
    const data1 = await response1.json();
    expect(response1.status).toBe(200);
    expect(data1.days).toHaveLength(1);

    // days=200 should clamp to 90
    const request2 = createTestRequest(
      "http://localhost:3000/api/zero/insights?days=200",
    );
    const response2 = await GET(request2);
    expect(response2.status).toBe(200);
  });

  it("should not return insights from other orgs", async () => {
    await seedInsightsDaily(
      uniqueId("org_other"),
      daysAgo(1),
      defaultInsightData(),
      user.userId,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toEqual([]);
  });

  it("should not return insights from other users", async () => {
    await seedInsightsDaily(
      user.orgId,
      daysAgo(1),
      defaultInsightData(),
      "user_other",
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toEqual([]);
  });

  it("should order days by date descending", async () => {
    const day1 = daysAgo(3);
    const day2 = daysAgo(1);
    const day3 = daysAgo(2);
    await seedInsightsDaily(
      user.orgId,
      day1,
      defaultInsightData(),
      user.userId,
    );
    await seedInsightsDaily(
      user.orgId,
      day2,
      defaultInsightData(),
      user.userId,
    );
    await seedInsightsDaily(
      user.orgId,
      day3,
      defaultInsightData(),
      user.userId,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.days).toHaveLength(3);
    expect(data.days[0].date).toBe(day2);
    expect(data.days[1].date).toBe(day3);
    expect(data.days[2].date).toBe(day1);
  });
});
