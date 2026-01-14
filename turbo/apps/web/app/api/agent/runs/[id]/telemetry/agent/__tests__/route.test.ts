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
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock Axiom module
vi.mock("../../../../../../../../src/lib/axiom", () => ({
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
import { queryAxiom } from "../../../../../../../../src/lib/axiom";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);
const mockQueryAxiom = vi.mocked(queryAxiom);

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

/**
 * Create a test Axiom agent event
 */
function createAxiomAgentEvent(
  timestamp: string,
  sequenceNumber: number,
  eventType: string,
  eventData: Record<string, unknown>,
  runId: string,
  userId: string,
): {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
} {
  return {
    _time: timestamp,
    runId,
    userId,
    sequenceNumber,
    eventType,
    eventData,
  };
}

describe("GET /api/agent/runs/:id/telemetry/agent", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
  const testRunId = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Default: Axiom returns empty array
    mockQueryAxiom.mockResolvedValue([]);

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test agent compose
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      userId: testUserId,
      scopeId: testScopeId,
      name: "test-agent",
      headVersionId: testVersionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create test agent version
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: testVersionId,
      composeId: testComposeId,
      content: {
        agents: {
          "test-agent": {
            name: "test-agent",
            model: "claude-3-5-sonnet-20241022",
            working_dir: "/workspace",
          },
        },
      },
      createdBy: testUserId,
      createdAt: new Date(),
    });

    // Create test agent run
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
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));
  });

  afterAll(async () => {
    // Clean up database connections
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockAuth.mockResolvedValue({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

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
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;
      const otherScopeId = randomUUID();
      const otherRunId = randomUUID();
      const otherComposeId = randomUUID();
      const otherVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

      await globalThis.services.db.insert(scopes).values({
        id: otherScopeId,
        slug: `test-${otherScopeId.slice(0, 8)}`,
        type: "personal",
        ownerId: otherUserId,
      });

      await globalThis.services.db.insert(agentComposes).values({
        id: otherComposeId,
        userId: otherUserId,
        scopeId: otherScopeId,
        name: "other-agent",
        headVersionId: otherVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

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

      await globalThis.services.db.insert(agentRuns).values({
        id: otherRunId,
        userId: otherUserId,
        agentComposeVersionId: otherVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
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
      await globalThis.services.db
        .delete(scopes)
        .where(eq(scopes.id, otherScopeId));
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty events when Axiom returns empty", async () => {
      mockQueryAxiom.mockResolvedValue([]);

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
      mockQueryAxiom.mockResolvedValue(null);

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
      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          1,
          "init",
          { type: "init", model: "claude-3" },
          testRunId,
          testUserId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[0].eventType).toBe("init");
      expect(data.events[0].eventData).toEqual({
        type: "init",
        model: "claude-3",
      });
      expect(data.events[0].createdAt).toBe("2024-01-01T00:00:00Z");
      expect(data.hasMore).toBe(false);

      // Verify Axiom was queried with correct APL
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining(`where runId == "${testRunId}"`),
      );
    });
  });

  describe("Multiple Events", () => {
    it("should return events in chronological order", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          1,
          "init",
          { type: "init" },
          testRunId,
          testUserId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:01Z",
          2,
          "text",
          { type: "text", content: "Hello" },
          testRunId,
          testUserId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:02Z",
          3,
          "tool_use",
          { type: "tool_use", name: "bash" },
          testRunId,
          testUserId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:03Z",
          4,
          "result",
          { type: "result", success: true },
          testRunId,
          testUserId,
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
      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          1,
          "event1",
          { type: "event1" },
          testRunId,
          testUserId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:01Z",
          2,
          "event2",
          { type: "event2" },
          testRunId,
          testUserId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:02Z",
          3,
          "event3",
          { type: "event3" },
          testRunId,
          testUserId,
        ),
        createAxiomAgentEvent(
          "2024-01-01T00:00:03Z",
          4,
          "event4",
          { type: "event4" },
          testRunId,
          testUserId,
        ), // Extra record
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[1].sequenceNumber).toBe(2);
      expect(data.events[2].sequenceNumber).toBe(3);
      expect(data.hasMore).toBe(true);

      // Verify limit+1 was requested
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("limit 4"),
      );
    });

    it("should include since filter in Axiom query", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:10Z",
          2,
          "recent_event",
          { type: "recent" },
          testRunId,
          testUserId,
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
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time > datetime"),
      );
    });
  });

  describe("Event Data", () => {
    it("should include createdAt as ISO string", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-15T10:30:00.000Z",
          1,
          "test",
          { type: "test" },
          testRunId,
          testUserId,
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

      mockQueryAxiom.mockResolvedValue([
        createAxiomAgentEvent(
          "2024-01-01T00:00:00Z",
          1,
          "tool_result",
          complexEventData,
          testRunId,
          testUserId,
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

  describe("Provider Field", () => {
    it("should return default provider 'claude-code' for compose without provider", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
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

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${codexRunId}/telemetry/agent`,
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

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${explicitRunId}/telemetry/agent`,
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
