import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  ensureOrgRow,
  seedInsightsDaily,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function defaultInsightData(overrides?: Record<string, unknown>) {
  return {
    agents: [
      { agentName: "Test Agent", agentId: "agent-1", runs: 3, credits: 50 },
    ],
    creditsUsed: 50,
    creditBalance: 9950,
    teamUsage: [{ name: "alice", credits: 50 }],
    topTask: null,
    services: [],
    permissions: [],
    ...overrides,
  };
}

describe("GET /api/zero/insights/range", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    await ensureOrgRow(user.orgId);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights/range",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return nulls when no insights exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights/range",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.minDate).toBeNull();
    expect(data.maxDate).toBeNull();
    expect(data.totalDays).toBe(0);
  });

  it("should return correct range for a single day", async () => {
    const date = daysAgo(1);
    await seedInsightsDaily(
      user.orgId,
      date,
      defaultInsightData(),
      user.userId,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights/range",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.minDate).toBe(date);
    expect(data.maxDate).toBe(date);
    expect(data.totalDays).toBe(1);
  });

  it("should return correct range for multiple days", async () => {
    const day1 = daysAgo(5);
    const day2 = daysAgo(3);
    const day3 = daysAgo(1);
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
      "http://localhost:3000/api/zero/insights/range",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.minDate).toBe(day1);
    expect(data.maxDate).toBe(day3);
    expect(data.totalDays).toBe(3);
  });

  it("should not include insights from other orgs", async () => {
    const otherOrg = uniqueId("org_other");
    await seedInsightsDaily(
      otherOrg,
      daysAgo(1),
      defaultInsightData(),
      user.userId,
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights/range",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.minDate).toBeNull();
    expect(data.maxDate).toBeNull();
    expect(data.totalDays).toBe(0);
  });

  it("should not include insights from other users", async () => {
    await seedInsightsDaily(
      user.orgId,
      daysAgo(1),
      defaultInsightData(),
      "user_other",
    );

    const request = createTestRequest(
      "http://localhost:3000/api/zero/insights/range",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.minDate).toBeNull();
    expect(data.maxDate).toBeNull();
    expect(data.totalDays).toBe(0);
  });
});
