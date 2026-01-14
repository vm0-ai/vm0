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
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../../src/db/schema/agent-compose";
import { cliTokens } from "../../../../../../../src/db/schema/cli-tokens";
import { scopes } from "../../../../../../../src/db/schema/scope";
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

// Mock Axiom module
vi.mock("../../../../../../../src/lib/axiom", () => ({
  queryAxiom: vi.fn(),
  ingestRequestLog: vi.fn(),
  ingestSandboxOpLog: vi.fn(),
  getDatasetName: vi.fn((base: string) => `vm0-${base}-dev`),
  DATASETS: {
    AGENT_RUN_EVENTS: "agent-run-events",
    WEB_LOGS: "web-logs",
    REQUEST_LOG: "request-log",
    SANDBOX_OP_LOG: "sandbox-op-log",
  },
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { queryAxiom } from "../../../../../../../src/lib/axiom";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);
const mockQueryAxiom = vi.mocked(queryAxiom);

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
  // Generate unique IDs for this test run to avoid conflicts
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
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

    // Default: return empty events
    mockQueryAxiom.mockResolvedValue([]);

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

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope for the user (required for compose creation)
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

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
      const otherScopeId = randomUUID();
      const otherVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

      // Create scope for other user
      await globalThis.services.db.insert(scopes).values({
        id: otherScopeId,
        slug: `test-${otherScopeId.slice(0, 8)}`,
        type: "personal",
        ownerId: otherUserId,
      });

      // Create config for other user
      await globalThis.services.db.insert(agentComposes).values({
        id: otherComposeId,
        userId: otherUserId,
        scopeId: otherScopeId,
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
      mockQueryAxiom.mockResolvedValue([]);

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

    it("should return empty events when Axiom is not configured", async () => {
      mockQueryAxiom.mockResolvedValue(null);

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
          sequenceNumber: 1,
          eventType: "system",
          eventData: {
            type: "system",
            subtype: "init",
            sessionId: "session-123",
          },
        }),
        createAxiomAgentEvent({
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
        }),
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "result",
          eventData: {
            type: "result",
            subtype: "success",
            is_error: false,
          },
        }),
      ];

      mockQueryAxiom.mockResolvedValue(testEvents);

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
    it("should verify APL query includes 'since' parameter", async () => {
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=2`,
      );

      await GET(request);

      // Verify the APL query includes the since filter
      expect(mockQueryAxiom).toHaveBeenCalledTimes(1);
      const apl = mockQueryAxiom.mock.calls[0]![0];
      expect(apl).toContain("sequenceNumber > 2");
    });

    it("should verify APL query includes 'limit' parameter", async () => {
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=3`,
      );

      await GET(request);

      // Verify the APL query includes the limit
      expect(mockQueryAxiom).toHaveBeenCalledTimes(1);
      const apl = mockQueryAxiom.mock.calls[0]![0];
      expect(apl).toContain("limit 3");
    });

    it("should set hasMore to true when results equal limit", async () => {
      // Return exactly 3 events (equal to limit)
      const testEvents = Array.from({ length: 3 }, (_, i) =>
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: i + 1,
          eventType: `event_${i + 1}`,
          eventData: { type: `event_${i + 1}` },
        }),
      );

      mockQueryAxiom.mockResolvedValue(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.hasMore).toBe(true);
      expect(data.nextSequence).toBe(3);
    });

    it("should set hasMore to false when results less than limit", async () => {
      // Return only 2 events (less than limit of 10)
      const testEvents = Array.from({ length: 2 }, (_, i) =>
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: i + 1,
          eventType: `event_${i + 1}`,
          eventData: { type: `event_${i + 1}` },
        }),
      );

      mockQueryAxiom.mockResolvedValue(testEvents);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(2);
      expect(data.hasMore).toBe(false);
      expect(data.nextSequence).toBe(2);
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

      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
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

      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent({
          runId: testRunId,
          sequenceNumber: 1,
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
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events?since=0`,
      );

      await GET(request);

      // Verify the APL query uses since=0
      expect(mockQueryAxiom).toHaveBeenCalledTimes(1);
      const apl = mockQueryAxiom.mock.calls[0]![0];
      expect(apl).toContain("sequenceNumber > 0");
    });

    it("should return nextSequence as 'since' value when no events returned", async () => {
      mockQueryAxiom.mockResolvedValue([]);

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
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      await GET(request);

      // Verify the APL query uses default limit of 100
      expect(mockQueryAxiom).toHaveBeenCalledTimes(1);
      const apl = mockQueryAxiom.mock.calls[0]![0];
      expect(apl).toContain("limit 100");
    });
  });

  // ============================================
  // Run State Tests
  // ============================================

  describe("Run State", () => {
    it("should return run state with status 'running' for running run", async () => {
      mockQueryAxiom.mockResolvedValue([]);

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

      mockQueryAxiom.mockResolvedValue([]);

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

      mockQueryAxiom.mockResolvedValue([]);

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

  // ============================================
  // Provider Field Tests
  // ============================================

  describe("Provider Field", () => {
    it("should return default provider 'claude-code' for compose without provider", async () => {
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.provider).toBe("claude-code");
    });

    it("should return 'codex' provider when compose has codex provider", async () => {
      // Create a compose with codex provider
      const codexComposeId = randomUUID();
      const codexVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const codexRunId = randomUUID();

      await globalThis.services.db.insert(agentComposes).values({
        id: codexComposeId,
        userId: testUserId,
        scopeId: testScopeId,
        name: "codex-agent",
        headVersionId: codexVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await globalThis.services.db.insert(agentComposeVersions).values({
        id: codexVersionId,
        composeId: codexComposeId,
        content: {
          agent: {
            provider: "codex",
            model: "codex",
          },
        },
        createdBy: testUserId,
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: codexRunId,
        userId: testUserId,
        agentComposeVersionId: codexVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${codexRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.provider).toBe("codex");

      // Clean up
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, codexRunId));
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, codexVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, codexComposeId));
    });

    it("should return explicit provider from compose configuration", async () => {
      // Create a compose with explicit claude-code provider
      const explicitComposeId = randomUUID();
      const explicitVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const explicitRunId = randomUUID();

      await globalThis.services.db.insert(agentComposes).values({
        id: explicitComposeId,
        userId: testUserId,
        scopeId: testScopeId,
        name: "explicit-agent",
        headVersionId: explicitVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await globalThis.services.db.insert(agentComposeVersions).values({
        id: explicitVersionId,
        composeId: explicitComposeId,
        content: {
          agent: {
            provider: "claude-code",
            model: "claude-3-5-sonnet-20241022",
          },
        },
        createdBy: testUserId,
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: explicitRunId,
        userId: testUserId,
        agentComposeVersionId: explicitVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${explicitRunId}/events`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.provider).toBe("claude-code");

      // Clean up
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, explicitRunId));
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, explicitVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, explicitComposeId));
    });
  });
});
