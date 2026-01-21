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

// Mock Axiom module
vi.mock("../../../../../../../../src/lib/axiom", () => ({
  queryAxiom: vi.fn(),
  ingestRequestLog: vi.fn(),
  ingestSandboxOpLog: vi.fn(),
  getDatasetName: vi.fn((base: string) => `vm0-${base}-dev`),
  DATASETS: {
    SANDBOX_TELEMETRY_NETWORK: "sandbox-telemetry-network",
    AGENT_RUN_EVENTS: "agent-run-events",
    WEB_LOGS: "web-logs",
    REQUEST_LOG: "request-log",
    SANDBOX_OP_LOG: "sandbox-op-log",
  },
}));

import { headers } from "next/headers";
import { queryAxiom } from "../../../../../../../../src/lib/axiom";
import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../../../src/__tests__/clerk-mock";

const mockHeaders = vi.mocked(headers);
const mockQueryAxiom = vi.mocked(queryAxiom);

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

/**
 * Create a test Axiom network event
 */
function createAxiomNetworkEvent(
  timestamp: string,
  method: string,
  url: string,
  status: number,
  runId: string,
  userId: string,
): {
  _time: string;
  runId: string;
  userId: string;
  method: string;
  url: string;
  status: number;
  latency_ms: number;
  request_size: number;
  response_size: number;
} {
  return {
    _time: timestamp,
    runId,
    userId,
    method,
    url,
    status,
    latency_ms: 150,
    request_size: 100,
    response_size: 1024,
  };
}

describe("GET /api/agent/runs/:id/telemetry/network", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
  const testRunId = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    mockClerk({ userId: testUserId });

    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Setup mockQueryAxiom - returns empty array by default
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
    clearClerkMock();

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
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
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
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/network`,
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
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/network`,
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
    it("should return empty network logs when Axiom returns empty", async () => {
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return empty network logs when Axiom is not configured", async () => {
      mockQueryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return network logs from Axiom", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:00Z",
          "GET",
          "https://api.example.com/data",
          200,
          testRunId,
          testUserId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(1);
      expect(data.networkLogs[0].method).toBe("GET");
      expect(data.networkLogs[0].url).toBe("https://api.example.com/data");
      expect(data.networkLogs[0].status).toBe(200);
      expect(data.networkLogs[0].timestamp).toBe("2024-01-01T00:00:00Z");
      expect(data.hasMore).toBe(false);

      // Verify Axiom was queried with correct APL
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining(`where runId == "${testRunId}"`),
      );
    });
  });

  describe("Retrieval from Axiom", () => {
    it("should return multiple network logs in order", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:00Z",
          "GET",
          "https://api.example.com/users",
          200,
          testRunId,
          testUserId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:05Z",
          "POST",
          "https://api.example.com/data",
          201,
          testRunId,
          testUserId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:10Z",
          "PUT",
          "https://api.example.com/users/1",
          200,
          testRunId,
          testUserId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:15Z",
          "DELETE",
          "https://api.example.com/users/2",
          404,
          testRunId,
          testUserId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(4);
      expect(data.networkLogs[0].method).toBe("GET");
      expect(data.networkLogs[1].method).toBe("POST");
      expect(data.networkLogs[2].method).toBe("PUT");
      expect(data.networkLogs[3].method).toBe("DELETE");
      expect(data.networkLogs[3].status).toBe(404);
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter and indicate hasMore", async () => {
      // Mock Axiom returning limit+1 records (indicating more data exists)
      mockQueryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:00Z",
          "GET",
          "https://api.example.com/1",
          200,
          testRunId,
          testUserId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:05Z",
          "GET",
          "https://api.example.com/2",
          200,
          testRunId,
          testUserId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:10Z",
          "GET",
          "https://api.example.com/3",
          200,
          testRunId,
          testUserId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:15Z",
          "GET",
          "https://api.example.com/4",
          200,
          testRunId,
          testUserId,
        ), // Extra record
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(3);
      expect(data.networkLogs[0].url).toBe("https://api.example.com/1");
      expect(data.networkLogs[1].url).toBe("https://api.example.com/2");
      expect(data.networkLogs[2].url).toBe("https://api.example.com/3");
      expect(data.hasMore).toBe(true);

      // Verify limit+1 was requested
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("limit 4"),
      );
    });

    it("should include since filter in Axiom query", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:10Z",
          "GET",
          "https://api.example.com/recent",
          200,
          testRunId,
          testUserId,
        ),
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(1);
      expect(data.networkLogs[0].url).toBe("https://api.example.com/recent");

      // Verify since filter was included in APL query
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time > datetime"),
      );
    });
  });
});
