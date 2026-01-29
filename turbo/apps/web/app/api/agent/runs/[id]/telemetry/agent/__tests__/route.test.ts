import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

// Only mock external services
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

/**
 * Helper to create mock Axiom agent event
 */
function createAxiomAgentEvent(
  timestamp: string,
  sequenceNumber: number,
  eventType: string,
  eventData: Record<string, unknown>,
  runId: string,
) {
  return {
    _time: timestamp,
    runId,
    userId: "test-user",
    sequenceNumber,
    eventType,
    eventData,
  };
}

describe("GET /api/agent/runs/:id/telemetry/agent", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose and run via API
    const { composeId } = await createTestCompose(
      `test-telemetry-agent-${Date.now()}`,
    );
    testComposeId = composeId;

    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain("authenticated");
    });
  });

  describe("Authorization", () => {
    it("should reject request for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject request for run owned by different user", async () => {
      // Create another user and their compose/run (this switches Clerk auth to the new user)
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-telemetry-agent-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user prompt",
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      // Try to access other user's run
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty events when Axiom returns empty", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return empty events when Axiom is not configured", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return agent events from Axiom", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          0,
          "init",
          { type: "init", model: "claude-3" },
          testRunId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].sequenceNumber).toBe(0);
      expect(data.events[0].eventType).toBe("init");
      expect(data.events[0].eventData).toEqual({
        type: "init",
        model: "claude-3",
      });
      expect(data.events[0].createdAt).toBe("2024-01-01T00:00:00Z");
      expect(data.hasMore).toBe(false);

      // Verify Axiom was queried with correct APL
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining(`where runId == "${testRunId}"`),
      );
    });
  });

  describe("Multiple Events", () => {
    it("should return events in chronological order", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          0,
          "init",
          { type: "init" },
          testRunId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:01Z",
          1,
          "text",
          { type: "text", content: "Hello" },
          testRunId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:02Z",
          2,
          "tool_use",
          { type: "tool_use", name: "bash" },
          testRunId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:03Z",
          3,
          "result",
          { type: "result", success: true },
          testRunId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(4);
      expect(data.events[0].eventType).toBe("init");
      expect(data.events[1].eventType).toBe("text");
      expect(data.events[2].eventType).toBe("tool_use");
      expect(data.events[3].eventType).toBe("result");
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter and indicate hasMore", async () => {
      // Mock Axiom returning limit+1 records (indicating more data exists)
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          0,
          "event0",
          { type: "event0" },
          testRunId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:01Z",
          1,
          "event1",
          { type: "event1" },
          testRunId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:02Z",
          2,
          "event2",
          { type: "event2" },
          testRunId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:03Z",
          3,
          "event3",
          { type: "event3" },
          testRunId,
        ), // Extra record
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.events[0].sequenceNumber).toBe(0);
      expect(data.events[1].sequenceNumber).toBe(1);
      expect(data.events[2].sequenceNumber).toBe(2);
      expect(data.hasMore).toBe(true);

      // Verify limit+1 was requested
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("limit 4"),
      );
    });

    it("should include since filter in Axiom query", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:10Z",
          1,
          "recent_event",
          { type: "recent" },
          testRunId,
        ),
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].eventType).toBe("recent_event");

      // Verify since filter was included in APL query
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time > datetime"),
      );
    });
  });

  describe("Event Data", () => {
    it("should include createdAt as ISO string", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-15T10:30:00.000Z",
          0,
          "test",
          { type: "test" },
          testRunId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events[0].createdAt).toBe("2024-01-15T10:30:00.000Z");
    });

    it("should preserve complex event data structures", async () => {
      const complexEventData = {
        type: "tool_result",
        tool: "bash",
        result: {
          stdout: "hello world",
          stderr: "",
          exitCode: 0,
        },
        metadata: {
          duration_ms: 150,
          retries: 0,
        },
      };

      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          0,
          "tool_result",
          complexEventData,
          testRunId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events[0].eventData).toEqual(complexEventData);
    });
  });

  describe("Framework Field", () => {
    it("should return default framework 'claude-code' for compose without framework", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.framework).toBe("claude-code");
    });
  });
});
