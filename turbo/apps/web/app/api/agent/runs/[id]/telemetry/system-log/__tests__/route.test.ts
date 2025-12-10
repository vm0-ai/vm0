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
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../../../../src/db/schema/sandbox-telemetry";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../../../src/db/schema/agent-compose";
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

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/agent/runs/:id/telemetry/system-log", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
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

    // Create test agent compose
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      userId: testUserId,
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
      const otherRunId = randomUUID();
      const otherComposeId = randomUUID();
      const otherVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

      await globalThis.services.db.insert(agentComposes).values({
        id: otherComposeId,
        userId: otherUserId,
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
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty system log when no telemetry exists", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.hasMore).toBe(false);
    });

    it("should return system log from telemetry record", async () => {
      await globalThis.services.db.insert(sandboxTelemetry).values({
        id: randomUUID(),
        runId: testRunId,
        data: {
          systemLog: "[INFO] Test log entry\n",
          metrics: [],
        },
        createdAt: new Date(),
      });

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
      await globalThis.services.db.insert(sandboxTelemetry).values([
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "[INFO] First entry\n",
          },
          createdAt: new Date(Date.now() - 2000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "[INFO] Second entry\n",
          },
          createdAt: new Date(Date.now() - 1000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "[INFO] Third entry\n",
          },
          createdAt: new Date(),
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

    it("should skip records without systemLog", async () => {
      await globalThis.services.db.insert(sandboxTelemetry).values([
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
            systemLog: "[INFO] Log entry\n",
          },
          createdAt: new Date(Date.now() - 1000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          data: {
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
        },
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("[INFO] Log entry\n");
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter", async () => {
      // Insert 5 records
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await globalThis.services.db.insert(sandboxTelemetry).values(
        ids.map((id, i) => ({
          id,
          runId: testRunId,
          data: {
            systemLog: `[INFO] Entry ${i + 1}\n`,
          },
          createdAt: new Date(Date.now() - (ids.length - i) * 1000),
        })),
      );

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

    it("should filter by since parameter", async () => {
      const now = Date.now();
      const oldTime = new Date(now - 10000);
      const recentTime = new Date(now - 1000);

      await globalThis.services.db.insert(sandboxTelemetry).values([
        {
          id: randomUUID(),
          runId: testRunId,
          data: { systemLog: "[INFO] Old entry\n" },
          createdAt: oldTime,
        },
        {
          id: randomUUID(),
          runId: testRunId,
          data: { systemLog: "[INFO] Recent entry\n" },
          createdAt: recentTime,
        },
      ]);

      // Request with since parameter that excludes the old entry
      const sinceTimestamp = now - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("[INFO] Recent entry\n");
    });
  });
});
