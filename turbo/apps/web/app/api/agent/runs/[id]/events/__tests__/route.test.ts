/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { GET } from "../route";
import { POST as createCompose } from "../../../../composes/route";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../../../src/db/schema/agent-run-event";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../../src/db/schema/agent-compose";
import { cliTokens } from "../../../../../../../src/db/schema/cli-tokens";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../../../../../src/test/api-test-helpers";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("GET /api/agent/runs/:id/events", () => {
  // Generate unique IDs for this test run to avoid conflicts
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-run-events-${Date.now()}`;
  const testRunId = randomUUID(); // UUID for agent run
  let testVersionId: string;
  const testToken = `vm0_live_test_${Date.now()}_${process.pid}`;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Mock Clerk auth to return the test user ID
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Mock headers() - not needed for this endpoint since we use Clerk auth
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Clean up any existing test data
    // Delete agent_runs first - CASCADE will delete related events
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    // Create test compose via API endpoint
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testVersionId = data.versionId;

    // Create test agent run (still using DB since runs API would execute sandbox)
    await globalThis.services.db.insert(agentRuns).values({
      id: testRunId,
      userId: testUserId,
      agentComposeVersionId: testVersionId,
      status: "running",
      prompt: "Test prompt",
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up test data after each test
    // Delete agent_runs first - CASCADE will delete related events
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });

  afterAll(async () => {
    // Clean up database connections
  });

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      // Mock auth to return null
      mockAuth.mockResolvedValue({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

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
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;
      const otherRunId = randomUUID();
      const otherComposeId = randomUUID();
      const otherVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

      // Create config for other user
      await globalThis.services.db.insert(agentComposes).values({
        id: otherComposeId,
        userId: otherUserId,
        name: "other-agent",
        headVersionId: otherVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create version for other user
      await globalThis.services.db.insert(agentComposeVersions).values({
        id: otherVersionId,
        composeId: otherComposeId,
        content: {
          agents: {
            "other-agent": {
              name: "other-agent",
              model: "claude-3-5-sonnet-20241022",
              working_dir: "/workspace",
            },
          },
        },
        createdBy: otherUserId,
        createdAt: new Date(),
      });

      // Create run owned by different user
      await globalThis.services.db.insert(agentRuns).values({
        id: otherRunId,
        userId: otherUserId,
        agentComposeVersionId: otherVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404); // 404 for security (not 403)
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");

      // Clean up
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, otherRunId));
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, otherVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, otherComposeId));
    });
  });

  // ============================================
  // Success - Basic Retrieval Tests
  // ============================================

  describe("Success - Basic Retrieval", () => {
    it("should return empty events list when no events exist", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(0);
      // Verify run state is included
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("running");
    });

    it("should return all events when they exist", async () => {
      // Insert test events
      const testEvents = [
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "system",
          eventData: {
            type: "system",
            subtype: "init",
            sessionId: "session-123",
          },
          createdAt: new Date(),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "assistant",
          eventData: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello" }],
            },
          },
          createdAt: new Date(),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "result",
          eventData: {
            type: "result",
            subtype: "success",
            is_error: false,
          },
          createdAt: new Date(),
        },
      ];

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[1].sequenceNumber).toBe(2);
      expect(data.events[2].sequenceNumber).toBe(3);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(3);
    });
  });

  // ============================================
  // Pagination Tests
  // ============================================

  describe("Pagination", () => {
    it("should filter events by 'since' parameter", async () => {
      // Insert 5 test events
      const testEvents = Array.from({ length: 5 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}`, data: { index: i + 1 } },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      // Request events since sequence 2
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=2`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3); // Only events 3, 4, 5
      expect(data.events[0].sequenceNumber).toBe(3);
      expect(data.events[1].sequenceNumber).toBe(4);
      expect(data.events[2].sequenceNumber).toBe(5);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(5);
    });

    it("should respect 'limit' parameter", async () => {
      // Insert 10 test events
      const testEvents = Array.from({ length: 10 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}`, data: { index: i + 1 } },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      // Request with limit=3
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[1].sequenceNumber).toBe(2);
      expect(data.events[2].sequenceNumber).toBe(3);
      expect(data.hasMore).toBe(true);
      expect(data.nextSequence).toBe(3);
    });

    it("should combine 'since' and 'limit' parameters", async () => {
      // Insert 10 test events
      const testEvents = Array.from({ length: 10 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}`, data: { index: i + 1 } },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      // Request events since=3 with limit=2
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=3&limit=2`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(2); // Events 4 and 5
      expect(data.events[0].sequenceNumber).toBe(4);
      expect(data.events[1].sequenceNumber).toBe(5);
      expect(data.hasMore).toBe(true);
      expect(data.nextSequence).toBe(5);
    });

    it("should set hasMore to false when no more events exist", async () => {
      // Insert 5 events
      const testEvents = Array.from({ length: 5 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}`, data: { index: i + 1 } },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      // Request with limit=10 (more than available)
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(5);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(5);
    });
  });

  // ============================================
  // Data Integrity Tests
  // ============================================

  describe("Data Integrity", () => {
    it("should return events in correct order (by sequenceNumber)", async () => {
      // Insert events in random order
      const testEvents = [
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "event_3",
          eventData: { type: "event_3" },
          createdAt: new Date(),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "event_1",
          eventData: { type: "event_1" },
          createdAt: new Date(),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "event_2",
          eventData: { type: "event_2" },
          createdAt: new Date(),
        },
      ];

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      // Should be returned in order: 1, 2, 3
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[1].sequenceNumber).toBe(2);
      expect(data.events[2].sequenceNumber).toBe(3);
    });

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

      await globalThis.services.db.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: complexEventData,
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].eventData).toEqual(complexEventData);
    });

    it("should return createdAt as ISO string", async () => {
      const now = new Date();

      await globalThis.services.db.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: 1,
        eventType: "test",
        eventData: { type: "test" },
        createdAt: now,
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(typeof data.events[0].createdAt).toBe("string");
      // Verify it's a valid ISO string
      expect(new Date(data.events[0].createdAt).toISOString()).toBe(
        now.toISOString(),
      );
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe("Edge Cases", () => {
    it("should handle since parameter with value 0", async () => {
      // Insert 3 events
      const testEvents = Array.from({ length: 3 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}` },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=0`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3); // All events
    });

    it("should return empty list when since is greater than max sequence", async () => {
      // Insert 3 events
      const testEvents = Array.from({ length: 3 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}` },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=100`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(100); // Should return the 'since' value when no events
    });

    it("should use default limit of 100 when not specified", async () => {
      // Insert 150 events
      const testEvents = Array.from({ length: 150 }, (_, i) => ({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: i + 1,
        eventType: `event_${i + 1}`,
        eventData: { type: `event_${i + 1}` },
        createdAt: new Date(),
      }));

      await globalThis.services.db.insert(agentRunEvents).values(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(100); // Default limit
      expect(data.hasMore).toBe(true);
      expect(data.nextSequence).toBe(100);
    });
  });

  // ============================================
  // Run State Tests
  // ============================================

  describe("Run State", () => {
    it("should return run state with status 'running' for running run", async () => {
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
      // Update run to completed with result
      const result = {
        checkpointId: "checkpoint-123",
        agentSessionId: "session-456",
        conversationId: "conversation-789",
        artifact: { "test-artifact": "v1" },
        volumes: { "test-volume": "v2" },
      };

      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "completed",
          result,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, testRunId));

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("completed");
      expect(data.run.result).toEqual(result);
      expect(data.run.error).toBeUndefined();
    });

    it("should return run state with error for failed run", async () => {
      // Update run to failed with error
      const errorMessage = "Agent exited with code 1";

      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, testRunId));

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.run).toBeDefined();
      expect(data.run.status).toBe("failed");
      expect(data.run.error).toBe(errorMessage);
      expect(data.run.result).toBeUndefined();
    });
  });
});
