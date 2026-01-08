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
  getDatasetName: vi.fn((base: string) => `vm0-${base}-dev`),
  DATASETS: {
    SANDBOX_TELEMETRY_SYSTEM: "sandbox-telemetry-system",
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

describe("GET /api/agent/runs/:id/telemetry/system-log", () => {
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

    // Default: queryAxiom returns empty array (no logs)
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
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log`,
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
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/system-log`,
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
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/system-log`,
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
    it("should return empty system log when no telemetry exists", async () => {
      // Default mockQueryAxiom returns empty array
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.hasMore).toBe(false);
    });

    it("should return system log from Axiom", async () => {
      mockQueryAxiom.mockResolvedValue([
        {
          _time: new Date().toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Test log entry\n",
        },
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("[INFO] Test log entry\n");
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Aggregation", () => {
    it("should aggregate system logs from multiple records", async () => {
      mockQueryAxiom.mockResolvedValue([
        {
          _time: new Date(Date.now() - 2000).toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] First entry\n",
        },
        {
          _time: new Date(Date.now() - 1000).toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Second entry\n",
        },
        {
          _time: new Date().toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Third entry\n",
        },
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe(
        "[INFO] First entry\n[INFO] Second entry\n[INFO] Third entry\n",
      );
      expect(data.hasMore).toBe(false);
    });

    it("should handle Axiom returning null (not configured)", async () => {
      mockQueryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter", async () => {
      // Mock Axiom returning 3 records (more than limit of 2)
      mockQueryAxiom.mockResolvedValue([
        {
          _time: new Date(Date.now() - 3000).toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Entry 1\n",
        },
        {
          _time: new Date(Date.now() - 2000).toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Entry 2\n",
        },
        {
          _time: new Date(Date.now() - 1000).toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Entry 3\n",
        },
      ]);

      // Request with limit=2
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?limit=2`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      // First 2 records
      expect(data.systemLog).toBe("[INFO] Entry 1\n[INFO] Entry 2\n");
      expect(data.hasMore).toBe(true);
    });

    it("should pass since parameter to Axiom query", async () => {
      // Mock Axiom returning only recent entry (since filter applied by Axiom)
      mockQueryAxiom.mockResolvedValue([
        {
          _time: new Date(Date.now() - 1000).toISOString(),
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Recent entry\n",
        },
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("[INFO] Recent entry\n");

      // Verify queryAxiom was called with a query containing the since filter
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time >"),
      );
    });
  });
});
