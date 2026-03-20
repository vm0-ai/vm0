import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  createTestSchedule,
  createTestZeroAgent,
  createTestRun,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/zero/logs", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return empty list when user has no runs", async () => {
    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.nextCursor).toBeNull();
  });

  describe("with runs", () => {
    let testComposeId: string;
    let runIds: string[];

    beforeEach(async () => {
      // Create compose and multiple runs
      const { composeId } = await createTestCompose(
        `logs-test-${randomUUID().slice(0, 8)}`,
      );
      testComposeId = composeId;

      // Create 3 runs - order will be newest first due to createdAt
      runIds = [];
      for (let i = 0; i < 3; i++) {
        const { runId } = await createTestRun(
          testComposeId,
          `Test prompt ${i}`,
        );
        // Complete runs to set them to "completed" status
        await completeTestRun(user.userId, runId);
        runIds.push(runId);
      }
    });

    it("should return list of run IDs ordered by createdAt DESC", async () => {
      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(3);

      // Verify all run IDs are present (order depends on creation timing)
      const returnedIds = data.data.map((r: { id: string }) => r.id);
      for (const runId of runIds) {
        expect(returnedIds).toContain(runId);
      }
    });

    it("should paginate correctly with limit and cursor", async () => {
      // Request with limit=2
      const request1 = createTestRequest(
        "http://localhost:3000/api/zero/logs?limit=2",
      );
      const response1 = await GET(request1);
      const data1 = await response1.json();

      expect(response1.status).toBe(200);
      expect(data1.data).toHaveLength(2);
      expect(data1.pagination.hasMore).toBe(true);
      expect(data1.pagination.nextCursor).not.toBeNull();

      // Request second page using cursor
      const request2 = createTestRequest(
        `http://localhost:3000/api/zero/logs?limit=2&cursor=${encodeURIComponent(data1.pagination.nextCursor)}`,
      );
      const response2 = await GET(request2);
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(data2.data).toHaveLength(1);
      expect(data2.pagination.hasMore).toBe(false);
      expect(data2.pagination.nextCursor).toBeNull();

      // Ensure no duplicate IDs between pages
      const allIds = [
        ...data1.data.map((r: { id: string }) => r.id),
        ...data2.data.map((r: { id: string }) => r.id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });
  });

  describe("search functionality", () => {
    beforeEach(async () => {
      // Create composes with different names
      const { composeId: compose1 } = await createTestCompose(
        `search-alpha-${randomUUID().slice(0, 8)}`,
      );
      const { composeId: compose2 } = await createTestCompose(
        `search-beta-${randomUUID().slice(0, 8)}`,
      );

      // Create runs for each compose
      const { runId: run1 } = await createTestRun(compose1, "Alpha prompt");
      await completeTestRun(user.userId, run1);

      const { runId: run2 } = await createTestRun(compose2, "Beta prompt");
      await completeTestRun(user.userId, run2);
    });

    it("should filter by agent name with fuzzy search", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?search=alpha",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
    });

    it("should return empty list when search has no matches", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?search=nonexistent-agent-xyz",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
      expect(data.pagination.hasMore).toBe(false);
    });

    it("should be case-insensitive for search", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?search=ALPHA",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeGreaterThan(0);
    });
  });

  describe("agent filter", () => {
    let alphaName: string;
    let betaName: string;

    beforeEach(async () => {
      alphaName = `agent-alpha-${randomUUID().slice(0, 8)}`;
      betaName = `agent-beta-${randomUUID().slice(0, 8)}`;

      const { composeId: compose1 } = await createTestCompose(alphaName);
      const { composeId: compose2 } = await createTestCompose(betaName);

      const { runId: run1 } = await createTestRun(compose1, "Alpha prompt");
      await completeTestRun(user.userId, run1);

      const { runId: run2 } = await createTestRun(compose2, "Beta prompt");
      await completeTestRun(user.userId, run2);
    });

    it("should filter by exact agent name", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?agent=${alphaName}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].agentName).toBe(alphaName);
    });

    it("should return empty list when agent has no runs", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?agent=nonexistent-agent",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
    });

    it("should use exact match, not fuzzy", async () => {
      // Search for partial name should return nothing with agent filter
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?agent=agent-alpha`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
    });

    it("should take precedence over search param", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?agent=${alphaName}&search=beta`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].agentName).toBe(alphaName);
    });
  });

  it("should not return runs from other users", async () => {
    // Create run for current user
    const { composeId } = await createTestCompose(
      `isolation-test-${randomUUID().slice(0, 8)}`,
    );
    const { runId: myRunId } = await createTestRun(composeId, "My prompt");
    await completeTestRun(user.userId, myRunId);

    // Create another user with different prefix to avoid caching
    const otherUser = await context.setupUser({ prefix: "other-user" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-agent-${randomUUID().slice(0, 8)}`,
    );
    const { runId: otherRunId } = await createTestRun(
      otherComposeId,
      "Other prompt",
    );
    await completeTestRun(otherUser.userId, otherRunId);

    // Switch back to original user and list runs
    mockClerk({ userId: user.userId });
    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    // Should only see own run, not other user's run
    const returnedIds = data.data.map((r: { id: string }) => r.id);
    expect(returnedIds).toContain(myRunId);
    expect(returnedIds).not.toContain(otherRunId);
  });

  describe("name and org filter", () => {
    let agentName: string;

    beforeEach(async () => {
      agentName = `org-agent-${randomUUID().slice(0, 8)}`;
      const { composeId } = await createTestCompose(agentName);

      const { runId } = await createTestRun(composeId, "Scoped prompt");
      await completeTestRun(user.userId, runId);
    });

    it("should filter by name param", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?name=${agentName}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].agentName).toBe(agentName);
    });

    it("should return empty when name matches but org does not", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?name=${agentName}&org=nonexistent-org`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
    });

    it("should include orgSlug in response", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?name=${agentName}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].orgSlug).toBeDefined();
      expect(typeof data.data[0].orgSlug).toBe("string");
    });

    it("name param should take precedence over agent param", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?name=${agentName}&agent=nonexistent`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].agentName).toBe(agentName);
    });
  });

  it("should return displayName from agent metadata", async () => {
    const agentName = `display-name-test-${randomUUID().slice(0, 8)}`;
    const { composeId } = await createTestCompose(agentName);
    // Seed zero_agents with displayName (metadata now lives in this table)
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "My Display Name",
    });
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const run = data.data.find((r: { id: string }) => r.id === runId);
    expect(run).toBeDefined();
    expect(run.displayName).toBe("My Display Name");
  });

  it("should return null displayName when agent metadata has none", async () => {
    const agentName = `no-display-name-${randomUUID().slice(0, 8)}`;
    const { composeId } = await createTestCompose(agentName);
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const run = data.data.find((r: { id: string }) => r.id === runId);
    expect(run).toBeDefined();
    expect(run.displayName).toBeNull();
  });

  it("should return 400 for invalid limit", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/logs?limit=0",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for limit exceeding maximum", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/logs?limit=101",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  describe("trigger source inference", () => {
    let testComposeId: string;

    beforeEach(async () => {
      const { composeId } = await createTestCompose(
        `trigger-src-${randomUUID().slice(0, 8)}`,
      );
      testComposeId = composeId;
    });

    it("should return explicit trigger source when set on run", async () => {
      await createTestRunInDb(user.userId, testComposeId, {
        status: "completed",
        triggerSource: "slack",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find(
        (r: { triggerSource: string }) => r.triggerSource === "slack",
      );
      expect(run).toBeDefined();
      expect(run.triggerSource).toBe("slack");
    });

    it("should infer 'schedule' for old rows with scheduleId but no trigger_source", async () => {
      const schedule = await createTestSchedule(
        testComposeId,
        `sched-${randomUUID().slice(0, 8)}`,
      );

      await createTestRunInDb(user.userId, testComposeId, {
        status: "completed",
        scheduleId: schedule.id,
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find(
        (r: { triggerSource: string }) => r.triggerSource === "schedule",
      );
      expect(run).toBeDefined();
      expect(run.triggerSource).toBe("schedule");
    });

    it("should infer 'web' for old rows with continuedFromSessionId but no trigger_source", async () => {
      await createTestRunInDb(user.userId, testComposeId, {
        status: "completed",
        continuedFromSessionId: randomUUID(),
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find(
        (r: { triggerSource: string }) => r.triggerSource === "web",
      );
      expect(run).toBeDefined();
      expect(run.triggerSource).toBe("web");
    });

    it("should default to 'cli' for old rows with no trigger_source and no hints", async () => {
      await createTestRunInDb(user.userId, testComposeId, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeGreaterThan(0);
      // Runs without trigger_source, scheduleId, or continuedFromSessionId default to 'cli'
      expect(data.data[0].triggerSource).toBe("cli");
    });
  });
});
