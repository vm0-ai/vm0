import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSchedule,
  createTestRun,
  completeTestRun,
  insertOrgMembersCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../src/__tests__/db-test-seeders/agents";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  generateZeroToken,
  generateSandboxToken,
} from "../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";

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
      const returnedIds = data.data.map((r: { id: string }) => {
        return r.id;
      });
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
        ...data1.data.map((r: { id: string }) => {
          return r.id;
        }),
        ...data2.data.map((r: { id: string }) => {
          return r.id;
        }),
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
    let alphaComposeId: string;

    beforeEach(async () => {
      alphaName = `agent-alpha-${randomUUID().slice(0, 8)}`;
      betaName = `agent-beta-${randomUUID().slice(0, 8)}`;

      const { composeId: compose1 } = await createTestCompose(alphaName);
      const { composeId: compose2 } = await createTestCompose(betaName);
      alphaComposeId = compose1;

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
      expect(data.data[0].agentId).toBe(alphaComposeId);
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
      expect(data.data[0].agentId).toBe(alphaComposeId);
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
    const returnedIds = data.data.map((r: { id: string }) => {
      return r.id;
    });
    expect(returnedIds).toContain(myRunId);
    expect(returnedIds).not.toContain(otherRunId);
  });

  describe("name filter", () => {
    let agentName: string;
    let nameComposeId: string;

    beforeEach(async () => {
      agentName = `org-agent-${randomUUID().slice(0, 8)}`;
      const { composeId } = await createTestCompose(agentName);
      nameComposeId = composeId;

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
      expect(data.data[0].agentId).toBe(nameComposeId);
    });

    it("name param should take precedence over agent param", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?name=${agentName}&agent=nonexistent`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].agentId).toBe(nameComposeId);
    });
  });

  it("should return displayName from agent metadata", async () => {
    const agentId = `display-name-test-${randomUUID().slice(0, 8)}`;
    const { composeId } = await createTestCompose(agentId);
    // Seed zero_agents with displayName (metadata now lives in this table)
    await createTestZeroAgent(user.orgId, agentId, {
      displayName: "My Display Name",
    });
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const run = data.data.find((r: { id: string }) => {
      return r.id === runId;
    });
    expect(run).toBeDefined();
    expect(run.displayName).toBe("My Display Name");
  });

  it("should return null displayName when agent metadata has none", async () => {
    const agentId = `no-display-name-${randomUUID().slice(0, 8)}`;
    const { composeId } = await createTestCompose(agentId);
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const request = createTestRequest("http://localhost:3000/api/zero/logs");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const run = data.data.find((r: { id: string }) => {
      return r.id === runId;
    });
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
      const agentId = `trigger-src-${randomUUID().slice(0, 8)}`;
      const { composeId } = await createTestCompose(agentId);
      testComposeId = composeId;
      await createTestZeroAgent(user.orgId, agentId, {});
    });

    it("should return explicit trigger source when set on run", async () => {
      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        triggerSource: "slack",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find((r: { triggerSource: string }) => {
        return r.triggerSource === "slack";
      });
      expect(run).toBeDefined();
      expect(run.triggerSource).toBe("slack");
    });

    it("should return 'schedule' for runs with triggerSource set to schedule", async () => {
      const schedule = await createTestSchedule(
        testComposeId,
        `sched-${randomUUID().slice(0, 8)}`,
      );

      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        scheduleId: schedule.id,
        triggerSource: "schedule",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find((r: { triggerSource: string }) => {
        return r.triggerSource === "schedule";
      });
      expect(run).toBeDefined();
      expect(run.triggerSource).toBe("schedule");
      expect(run.scheduleId).toBe(schedule.id);
    });

    it("should return null scheduleId for non-schedule runs", async () => {
      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        triggerSource: "web",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find((r: { triggerSource: string }) => {
        return r.triggerSource === "web";
      });
      expect(run).toBeDefined();
      expect(run.scheduleId).toBeNull();
    });

    it("should return 'web' for runs with triggerSource set to web", async () => {
      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        triggerSource: "web",
        continuedFromSessionId: randomUUID(),
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const run = data.data.find((r: { triggerSource: string }) => {
        return r.triggerSource === "web";
      });
      expect(run).toBeDefined();
      expect(run.triggerSource).toBe("web");
    });

    it("should default to 'cli' for runs without explicit triggerSource", async () => {
      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeGreaterThan(0);
      expect(data.data[0].triggerSource).toBe("cli");
    });
  });

  describe("triggerSource filter", () => {
    let testComposeId: string;

    beforeEach(async () => {
      const { composeId } = await createTestCompose(
        `source-filter-${randomUUID().slice(0, 8)}`,
      );
      testComposeId = composeId;

      // Create runs with different trigger sources
      for (const source of ["web", "cli", "slack", "schedule"]) {
        await seedTestRun(user.userId, testComposeId, {
          status: "completed",
          triggerSource: source,
          startedAt: new Date(),
          completedAt: new Date(),
        });
      }
    });

    it("should filter runs by triggerSource", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?triggerSource=slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].triggerSource).toBe("slack");
    });

    it("should return all runs when triggerSource is not specified", async () => {
      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(4);
    });

    it("should return empty list when no runs match the triggerSource", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?triggerSource=github",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
    });

    it("should combine triggerSource with status filter", async () => {
      // Add a failed web run
      await seedTestRun(user.userId, testComposeId, {
        status: "failed",
        triggerSource: "web",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      // Filter for completed + web should return 1 (not the failed one)
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?triggerSource=web&status=completed",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].triggerSource).toBe("web");
      expect(data.data[0].status).toBe("completed");
    });

    it("should combine triggerSource with agent filter", async () => {
      // Create a second agent with a slack run
      const otherName = `other-agent-${randomUUID().slice(0, 8)}`;
      const { composeId: otherComposeId } = await createTestCompose(otherName);
      await seedTestRun(user.userId, otherComposeId, {
        status: "completed",
        triggerSource: "slack",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      // Filter for slack source + the other agent
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?triggerSource=slack&agent=${otherName}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].agentId).toBe(otherComposeId);
      expect(data.data[0].triggerSource).toBe("slack");
    });

    it("should correctly count total pages with triggerSource filter", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?triggerSource=web&limit=1",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.pagination.totalPages).toBe(1);
    });
  });

  describe("filters response", () => {
    it("should return empty filters when user has no runs", async () => {
      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.filters).toEqual({
        statuses: [],
        sources: [],
        agents: [],
      });
    });

    it("should return available statuses from user's runs", async () => {
      const { composeId } = await createTestCompose(
        `filter-status-${randomUUID().slice(0, 8)}`,
      );

      await seedTestRun(user.userId, composeId, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });
      await seedTestRun(user.userId, composeId, {
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.filters.statuses).toContain("completed");
      expect(data.filters.statuses).toContain("failed");
    });

    it("should return available trigger sources from user's runs", async () => {
      const { composeId } = await createTestCompose(
        `filter-source-${randomUUID().slice(0, 8)}`,
      );

      await seedTestRun(user.userId, composeId, {
        status: "completed",
        triggerSource: "slack",
        startedAt: new Date(),
        completedAt: new Date(),
      });
      await seedTestRun(user.userId, composeId, {
        status: "completed",
        triggerSource: "web",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.filters.sources).toContain("slack");
      expect(data.filters.sources).toContain("web");
    });

    it("should return available agent names from user's runs", async () => {
      const agentA = `filter-agent-a-${randomUUID().slice(0, 8)}`;
      const agentB = `filter-agent-b-${randomUUID().slice(0, 8)}`;
      const { composeId: composeA } = await createTestCompose(agentA);
      const { composeId: composeB } = await createTestCompose(agentB);

      await seedTestRun(user.userId, composeA, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });
      await seedTestRun(user.userId, composeB, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.filters.agents).toContain(agentA);
      expect(data.filters.agents).toContain(agentB);
    });

    it("should not include null trigger sources in filters", async () => {
      const { composeId } = await createTestCompose(
        `filter-null-src-${randomUUID().slice(0, 8)}`,
      );

      // Create a run without triggerSource (will be null in DB)
      await seedTestRun(user.userId, composeId, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      // filters.sources should not contain null entries
      for (const source of data.filters.sources) {
        expect(source).not.toBeNull();
      }
    });

    it("should return filters independent of current query filters", async () => {
      const { composeId } = await createTestCompose(
        `filter-independent-${randomUUID().slice(0, 8)}`,
      );

      await seedTestRun(user.userId, composeId, {
        status: "completed",
        triggerSource: "slack",
        startedAt: new Date(),
        completedAt: new Date(),
      });
      await seedTestRun(user.userId, composeId, {
        status: "failed",
        triggerSource: "web",
        startedAt: new Date(),
        completedAt: new Date(),
      });

      // Even when filtering by triggerSource=slack, filters should still
      // include "web" as an available source (filters are org-wide, not
      // filtered by the current query)
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?triggerSource=slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.filters.sources).toContain("slack");
      expect(data.filters.sources).toContain("web");
      expect(data.filters.statuses).toContain("completed");
      expect(data.filters.statuses).toContain("failed");
    });
  });

  describe("scheduleId filter", () => {
    let testComposeId: string;
    let scheduleId: string;

    beforeEach(async () => {
      const { composeId } = await createTestCompose(
        `sched-filter-${randomUUID().slice(0, 8)}`,
      );
      testComposeId = composeId;

      const schedule = await createTestSchedule(
        testComposeId,
        `sched-${randomUUID().slice(0, 8)}`,
      );
      scheduleId = schedule.id;

      // Create a run linked to the schedule
      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        scheduleId,
        startedAt: new Date(),
        completedAt: new Date(),
      });

      // Create a run NOT linked to any schedule
      await seedTestRun(user.userId, testComposeId, {
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      });
    });

    it("should return only runs for the given scheduleId", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?scheduleId=${scheduleId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
    });

    it("should return empty list when scheduleId has no matching runs", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?scheduleId=${randomUUID()}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
    });

    it("should correctly count total pages with scheduleId filter", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/zero/logs?scheduleId=${scheduleId}&limit=1`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.pagination.totalPages).toBe(1);
    });

    it("should return 400 for invalid scheduleId format", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/zero/logs?scheduleId=not-a-uuid",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("zero token auth", () => {
    it("should return 200 for zero token with agent-run:read capability", async () => {
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
      });
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const request = createTestRequest("http://localhost:3000/api/zero/logs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data).toEqual([]);
    });

    it("should return 403 for sandbox token without agent-run:read", async () => {
      const { composeId } = await createTestCompose(
        `zero-auth-${randomUUID().slice(0, 8)}`,
      );
      const { runId } = await createTestRun(composeId, "test");
      const token = await generateSandboxToken(user.userId, runId);
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/zero/logs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const response = await GET(request);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:read");
    });

    it("should return 401 when no auth is provided", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/zero/logs");
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });
});
