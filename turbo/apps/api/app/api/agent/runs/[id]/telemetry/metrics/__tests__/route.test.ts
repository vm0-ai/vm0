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
    SANDBOX_TELEMETRY_METRICS: "sandbox-telemetry-metrics",
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
 * Create a test Axiom metric event
 */
function createAxiomMetricEvent(
  ts: string,
  cpu: number,
  runId: string,
  userId: string,
): {
  _time: string;
  runId: string;
  userId: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
} {
  return {
    _time: ts,
    runId,
    userId,
    cpu,
    mem_used: 1000000000,
    mem_total: 2000000000,
    disk_used: 5000000000,
    disk_total: 10000000000,
  };
}

describe("GET /api/agent/runs/:id/telemetry/metrics", () => {
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
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
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
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/metrics`,
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
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/metrics`,
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
    it("should return empty metrics when Axiom returns empty", async () => {
      mockQueryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return empty metrics when Axiom is not configured", async () => {
      mockQueryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return metrics from Axiom", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:00Z",
          50,
          testRunId,
          testUserId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].cpu).toBe(50);
      expect(data.metrics[0].mem_used).toBe(1000000000);
      expect(data.metrics[0].ts).toBe("2024-01-01T00:00:00Z");
      expect(data.hasMore).toBe(false);

      // Verify Axiom was queried with correct APL
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining(`where runId == "${testRunId}"`),
      );
    });
  });

  describe("Retrieval from Axiom", () => {
    it("should return multiple metrics in order", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:00Z",
          10,
          testRunId,
          testUserId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:05Z",
          15,
          testRunId,
          testUserId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:10Z",
          20,
          testRunId,
          testUserId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:15Z",
          25,
          testRunId,
          testUserId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(4);
      expect(data.metrics[0].cpu).toBe(10);
      expect(data.metrics[1].cpu).toBe(15);
      expect(data.metrics[2].cpu).toBe(20);
      expect(data.metrics[3].cpu).toBe(25);
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter and indicate hasMore", async () => {
      // Mock Axiom returning limit+1 records (indicating more data exists)
      mockQueryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:00Z",
          10,
          testRunId,
          testUserId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:05Z",
          20,
          testRunId,
          testUserId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:10Z",
          30,
          testRunId,
          testUserId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:15Z",
          40,
          testRunId,
          testUserId,
        ), // Extra record
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(3);
      expect(data.metrics[0].cpu).toBe(10);
      expect(data.metrics[1].cpu).toBe(20);
      expect(data.metrics[2].cpu).toBe(30);
      expect(data.hasMore).toBe(true);

      // Verify limit+1 was requested
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("limit 4"),
      );
    });

    it("should include since filter in Axiom query", async () => {
      mockQueryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:10Z",
          50,
          testRunId,
          testUserId,
        ),
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].cpu).toBe(50);

      // Verify since filter was included in APL query
      expect(mockQueryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time > datetime"),
      );
    });
  });
});
