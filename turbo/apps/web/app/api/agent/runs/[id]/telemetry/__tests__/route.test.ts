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
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../../../src/db/schema/sandbox-telemetry";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../../src/__tests__/clerk-mock";

/**
 * Helper to create a NextRequest for testing.
 * Uses actual NextRequest constructor so ts-rest handler gets nextUrl property.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/agent/runs/:id/telemetry", () => {
  // Generate unique IDs for this test run to avoid conflicts
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
  const testRunId = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Mock Clerk auth to return the test user ID by default
    mockClerk({ userId: testUserId });

    // Clean up any existing test data
    await globalThis.services.db
      .delete(sandboxTelemetry)
      .where(eq(sandboxTelemetry.runId, testRunId));

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

    // Create test agent config
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
    // Clean up test data after each test
    await globalThis.services.db
      .delete(sandboxTelemetry)
      .where(eq(sandboxTelemetry.runId, testRunId));

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

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      // Mock auth to return null
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry`,
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
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry`,
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
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry`,
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
      await globalThis.services.db
        .delete(scopes)
        .where(eq(scopes.id, otherScopeId));
    });
  });

  // ============================================
  // Success - Basic Retrieval Tests
  // ============================================

  describe("Success - Basic Retrieval", () => {
    it("should return empty telemetry when no records exist", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.metrics).toEqual([]);
    });

    it("should return telemetry data when records exist", async () => {
      // Insert test telemetry
      await globalThis.services.db.insert(sandboxTelemetry).values({
        id: randomUUID(),
        runId: testRunId,
        data: {
          systemLog: "Test log entry\n",
          metrics: [
            {
              ts: "2024-01-01T00:00:00Z",
              cpu: 50,
              mem_used: 1000,
              mem_total: 2000,
              disk_used: 5000,
              disk_total: 10000,
            },
          ],
        },
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("Test log entry\n");
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].cpu).toBe(50);
    });
  });

  // ============================================
  // Aggregation Tests
  // ============================================

  describe("Aggregation", () => {
    it("should aggregate multiple telemetry records", async () => {
      // Insert multiple telemetry records
      await globalThis.services.db.insert(sandboxTelemetry).values([
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "First log entry\n",
            metrics: [
              {
                ts: "2024-01-01T00:00:00Z",
                cpu: 10,
                mem_used: 100,
                mem_total: 1000,
                disk_used: 500,
                disk_total: 5000,
              },
            ],
          },
          createdAt: new Date(Date.now() - 2000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "Second log entry\n",
            metrics: [
              {
                ts: "2024-01-01T00:00:10Z",
                cpu: 20,
                mem_used: 200,
                mem_total: 1000,
                disk_used: 600,
                disk_total: 5000,
              },
            ],
          },
          createdAt: new Date(Date.now() - 1000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "Third log entry\n",
            metrics: [
              {
                ts: "2024-01-01T00:00:20Z",
                cpu: 30,
                mem_used: 300,
                mem_total: 1000,
                disk_used: 700,
                disk_total: 5000,
              },
            ],
          },
          createdAt: new Date(),
        },
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // System log should be concatenated
      expect(data.systemLog).toBe(
        "First log entry\nSecond log entry\nThird log entry\n",
      );

      // Metrics should be aggregated
      expect(data.metrics).toHaveLength(3);
      expect(data.metrics[0].cpu).toBe(10);
      expect(data.metrics[1].cpu).toBe(20);
      expect(data.metrics[2].cpu).toBe(30);
    });

    it("should handle records with only systemLog", async () => {
      await globalThis.services.db.insert(sandboxTelemetry).values({
        id: randomUUID(),
        runId: testRunId,
        data: {
          systemLog: "Log only entry\n",
        },
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("Log only entry\n");
      expect(data.metrics).toEqual([]);
    });

    it("should handle records with only metrics", async () => {
      await globalThis.services.db.insert(sandboxTelemetry).values({
        id: randomUUID(),
        runId: testRunId,
        data: {
          metrics: [
            {
              ts: "2024-01-01T00:00:00Z",
              cpu: 75,
              mem_used: 500,
              mem_total: 1000,
              disk_used: 2500,
              disk_total: 5000,
            },
          ],
        },
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].cpu).toBe(75);
    });
  });
});
