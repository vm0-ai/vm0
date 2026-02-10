import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "../route";
import { filterConsecutiveEvents } from "../filter-events";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  createTestCliToken,
  deleteTestCliToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

// Only mock external services

const context = testContext();

/**
 * Helper to create mock Axiom agent event
 */
function createAxiomAgentEvent(overrides: {
  runId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
  _time?: string;
}) {
  return {
    _time: overrides._time ?? new Date().toISOString(),
    runId: overrides.runId,
    userId: "test-user",
    sequenceNumber: overrides.sequenceNumber,
    eventType: overrides.eventType,
    eventData: overrides.eventData,
  };
}

describe("GET /api/agent/runs/:id/events", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose and run via API
    const { composeId } = await createTestCompose(
      `test-events-agent-${Date.now()}`,
    );
    testComposeId = composeId;

    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;
  });

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain("authenticated");
    });
  });

  // ============================================
  // Authorization Tests
  // ============================================

  describe("Authorization", () => {
    it("should reject request for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/events`,
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
        `other-events-agent-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user prompt",
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      // Try to access other user's run
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404); // 404 for security (not 403)
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  // ============================================
  // Success - Basic Retrieval Tests
  // ============================================

  describe("Success - Basic Retrieval", () => {
    it("should return empty events list when no events exist", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(-1);
      // Verify run state is included
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("running");
    });

    it("should return empty events when Axiom is not configured", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return all events when they exist", async () => {
      const testEvents = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "system",
          eventData: {
            type: "system",
            subtype: "init",
            sessionId: "session-123",
          },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello" }],
            },
          },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "result",
          eventData: {
            type: "result",
            subtype: "success",
            is_error: false,
          },
        }),
      ];

      context.mocks.axiom.queryAxiom.mockResolvedValue(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.events[0].sequenceNumber).toBe(0);
      expect(data.events[1].sequenceNumber).toBe(1);
      expect(data.events[2].sequenceNumber).toBe(2);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(2);
    });
  });

  // ============================================
  // Pagination Tests
  // ============================================

  describe("Pagination", () => {
    it("should verify APL query includes 'since' parameter", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=2`,
      );

      await GET(request);

      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledTimes(1);
      const apl = context.mocks.axiom.queryAxiom.mock.calls[0]![0];
      expect(apl).toContain("sequenceNumber > 2");
    });

    it("should verify APL query includes 'limit' parameter", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=3`,
      );

      await GET(request);

      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledTimes(1);
      const apl = context.mocks.axiom.queryAxiom.mock.calls[0]![0];
      expect(apl).toContain("limit 3");
    });

    it("should set hasMore to true when results equal limit", async () => {
      const testEvents = Array.from({ length: 3 }, (_, i) =>
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: i,
          eventType: `event_${i}`,
          eventData: { type: `event_${i}` },
        }),
      );

      context.mocks.axiom.queryAxiom.mockResolvedValue(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.hasMore).toBe(true);
      expect(data.nextSequence).toBe(2);
    });

    it("should set hasMore to false when results less than limit", async () => {
      const testEvents = Array.from({ length: 2 }, (_, i) =>
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: i,
          eventType: `event_${i}`,
          eventData: { type: `event_${i}` },
        }),
      );

      context.mocks.axiom.queryAxiom.mockResolvedValue(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(2);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(1);
    });
  });

  // ============================================
  // Data Integrity Tests
  // ============================================

  describe("Data Integrity", () => {
    it("should preserve complete event data (eventData field)", async () => {
      const complexEventData = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Write",
              input: {
                file_path: "/tmp/test.txt",
                content: "Hello World",
              },
            },
          ],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 500,
            output_tokens: 50,
          },
        },
        session_id: "session-abc-123",
      };

      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: complexEventData,
        }),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].eventData).toEqual(complexEventData);
    });

    it("should return createdAt from Axiom _time", async () => {
      const timestamp = "2024-12-24T10:30:00.000Z";

      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "test",
          eventData: { type: "test" },
          _time: timestamp,
        }),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].createdAt).toBe(timestamp);
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe("Edge Cases", () => {
    it("should handle since parameter with value 0", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=0`,
      );

      await GET(request);

      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledTimes(1);
      const apl = context.mocks.axiom.queryAxiom.mock.calls[0]![0];
      expect(apl).toContain("sequenceNumber > 0");
    });

    it("should return nextSequence as 'since' value when no events returned", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=100`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(100);
    });

    it("should use default limit of 100 when not specified", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      await GET(request);

      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledTimes(1);
      const apl = context.mocks.axiom.queryAxiom.mock.calls[0]![0];
      expect(apl).toContain("limit 100");
    });
  });

  // ============================================
  // Run State Tests
  // ============================================

  describe("Run State", () => {
    it("should return run state with status 'running' for running run", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("running");
      expect(data.run.result).toBeUndefined();
      expect(data.run.error).toBeUndefined();
    });

    it("should return run state with result for completed run", async () => {
      // Complete the run via webhook helpers
      await completeTestRun(user.userId, testRunId);

      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("completed");
      expect(data.run.result).toBeDefined();
      expect(data.run.result.checkpointId).toBeDefined();
    });
  });

  // ============================================
  // Framework Field Tests
  // ============================================

  describe("Framework Field", () => {
    it("should return default framework 'claude-code' for compose without framework", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.framework).toBe("claude-code");
    });
  });

  // ============================================
  // Consecutive Events Filtering Tests (Issue #1233)
  // ============================================

  describe("Consecutive Events Filtering", () => {
    it("should return all events when there are no gaps", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "event_0",
          eventData: { type: "event_0" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "event_1",
          eventData: { type: "event_1" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "event_2",
          eventData: { type: "event_2" },
        }),
      ];

      const result = filterConsecutiveEvents(events, -1);

      expect(result).toHaveLength(3);
      expect(result.map((e) => e.sequenceNumber)).toEqual([0, 1, 2]);
    });

    it("should truncate at first gap (Axiom eventual consistency)", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "event_0",
          eventData: { type: "event_0" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "event_1",
          eventData: { type: "event_1" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "event_3",
          eventData: { type: "event_3" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 5,
          eventType: "event_5",
          eventData: { type: "event_5" },
        }),
      ];

      const result = filterConsecutiveEvents(events, -1);

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.sequenceNumber)).toEqual([0, 1]);
    });

    it("should return empty when first event is not since+1", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "event_3",
          eventData: { type: "event_3" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 4,
          eventType: "event_4",
          eventData: { type: "event_4" },
        }),
      ];

      const result = filterConsecutiveEvents(events, -1);

      expect(result).toHaveLength(0);
    });

    it("should handle continuation from non-zero since", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 6,
          eventType: "event_6",
          eventData: { type: "event_6" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 7,
          eventType: "event_7",
          eventData: { type: "event_7" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 8,
          eventType: "event_8",
          eventData: { type: "event_8" },
        }),
      ];

      const result = filterConsecutiveEvents(events, 5);

      expect(result).toHaveLength(3);
      expect(result.map((e) => e.sequenceNumber)).toEqual([6, 7, 8]);
    });

    it("should return empty for empty input", () => {
      const result = filterConsecutiveEvents([], -1);

      expect(result).toHaveLength(0);
    });

    it("should handle gap in middle of continuation", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 11,
          eventType: "event_11",
          eventData: { type: "event_11" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 12,
          eventType: "event_12",
          eventData: { type: "event_12" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 14,
          eventType: "event_14",
          eventData: { type: "event_14" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 15,
          eventType: "event_15",
          eventData: { type: "event_15" },
        }),
      ];

      const result = filterConsecutiveEvents(events, 10);

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.sequenceNumber)).toEqual([11, 12]);
    });

    it("should handle single event with correct sequence", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "event_0",
          eventData: { type: "event_0" },
        }),
      ];

      const result = filterConsecutiveEvents(events, -1);

      expect(result).toHaveLength(1);
      expect(result[0]!.sequenceNumber).toBe(0);
    });

    it("should handle single event with gap", () => {
      const events = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 5,
          eventType: "event_5",
          eventData: { type: "event_5" },
        }),
      ];

      const result = filterConsecutiveEvents(events, -1);

      expect(result).toHaveLength(0);
    });
  });

  // ============================================
  // Integration: Gap Handling in API Response
  // ============================================

  describe("Gap Handling in API Response", () => {
    it("should set hasMore=true when events are truncated due to gap", async () => {
      const testEvents = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "tool_use",
          eventData: { type: "tool_use", tool: "Bash" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "tool_result",
          eventData: { type: "tool_result" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "tool_use",
          eventData: { type: "tool_use", tool: "Read" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 4,
          eventType: "tool_result",
          eventData: { type: "tool_result" },
        }),
      ];

      context.mocks.axiom.queryAxiom.mockResolvedValue(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.events).toHaveLength(2);
      expect(
        data.events.map((e: { sequenceNumber: number }) => e.sequenceNumber),
      ).toEqual([0, 1]);
      expect(data.hasMore).toBe(true);
      expect(data.nextSequence).toBe(1);
    });

    it("should allow client to retry and receive missing event after it becomes available", async () => {
      // First request: Axiom returns events 0, 1, 3 (missing 2)
      const firstQueryEvents = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 0,
          eventType: "event_0",
          eventData: { type: "event_0" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "event_1",
          eventData: { type: "event_1" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "event_3",
          eventData: { type: "event_3" },
        }),
      ];

      context.mocks.axiom.queryAxiom.mockResolvedValue(firstQueryEvents);

      const firstRequest = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const firstResponse = await GET(firstRequest);
      const firstData = await firstResponse.json();

      expect(firstData.events).toHaveLength(2);
      expect(firstData.nextSequence).toBe(1);
      expect(firstData.hasMore).toBe(true);

      // Second request: Now event 2 is available
      const secondQueryEvents = [
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "event_2",
          eventData: { type: "event_2" },
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "event_3",
          eventData: { type: "event_3" },
        }),
      ];

      context.mocks.axiom.queryAxiom.mockResolvedValue(secondQueryEvents);

      const secondRequest = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=1`,
      );

      const secondResponse = await GET(secondRequest);
      const secondData = await secondResponse.json();

      expect(secondData.events).toHaveLength(2);
      expect(
        secondData.events.map(
          (e: { sequenceNumber: number }) => e.sequenceNumber,
        ),
      ).toEqual([2, 3]);
      expect(secondData.nextSequence).toBe(3);
    });
  });

  // ============================================
  // CLI Token Authentication Tests
  // ============================================

  describe("CLI Token Authentication", () => {
    let testCliToken: string;

    beforeEach(async () => {
      testCliToken = await createTestCliToken(user.userId);
    });

    afterEach(async () => {
      await deleteTestCliToken(testCliToken);
    });

    it("should accept request with valid CLI token", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
        {
          headers: {
            Authorization: `Bearer ${testCliToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toBeDefined();
    });

    it("should reject expired CLI token", async () => {
      // Create expired token
      const expiredToken = await createTestCliToken(
        user.userId,
        new Date(Date.now() - 1000), // Expired 1 second ago
      );

      // Mock Clerk to return null (unauthenticated)
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
        {
          headers: {
            Authorization: `Bearer ${expiredToken}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);

      // Clean up expired token
      await deleteTestCliToken(expiredToken);
    });
  });

  // ============================================
  // DB Fallback Tests (Axiom not configured)
  // ============================================

  describe("DB fallback (Axiom not configured)", () => {
    it("should return empty events from DB fallback when Axiom is not configured", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("running");
    });
  });
});
