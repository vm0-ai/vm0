/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

// Mock e2bService
vi.mock("../../../../../src/lib/e2b/e2b-service", () => ({
  e2bService: {
    killSandbox: vi.fn().mockResolvedValue(undefined),
  },
}));

import { e2bService } from "../../../../../src/lib/e2b/e2b-service";

const mockKillSandbox = vi.mocked(e2bService.killSandbox);

describe("GET /api/cron/cleanup-sandboxes", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId1 = randomUUID();
  const testRunId2 = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const cronSecret = "test-cron-secret";

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Set CRON_SECRET for tests
    process.env.VERCEL_CRON_SECRET = cronSecret;

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId1));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId2));

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
  });

  afterEach(async () => {
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId1));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId2));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));

    delete process.env.VERCEL_CRON_SECRET;
  });

  describe("Authentication", () => {
    it("should reject request without cron secret", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should reject request with invalid cron secret", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer invalid-secret",
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it("should accept request with valid cron secret", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Cleanup Logic", () => {
    it("should return empty results when no expired sandboxes exist", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(0);
      expect(data.errors).toBe(0);
      expect(data.results).toEqual([]);
    });

    it("should cleanup expired sandbox (heartbeat > 2 minutes ago)", async () => {
      // Create a run with expired heartbeat (3 minutes ago)
      const expiredTime = new Date(Date.now() - 3 * 60 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        sandboxId: "test-sandbox-123",
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(1);
      expect(data.errors).toBe(0);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].runId).toBe(testRunId1);
      expect(data.results[0].status).toBe("cleaned");

      // Verify sandbox was killed
      expect(mockKillSandbox).toHaveBeenCalledWith("test-sandbox-123");

      // Verify run status was updated to timeout
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId1));

      expect(updatedRun?.status).toBe("timeout");
      expect(updatedRun?.completedAt).toBeDefined();
    });

    it("should NOT cleanup sandbox with recent heartbeat", async () => {
      // Create a run with recent heartbeat (30 seconds ago)
      const recentTime = new Date(Date.now() - 30 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        sandboxId: "test-sandbox-123",
        createdAt: new Date(),
        lastHeartbeatAt: recentTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(0);
      expect(data.results).toEqual([]);

      // Verify sandbox was NOT killed
      expect(mockKillSandbox).not.toHaveBeenCalled();

      // Verify run status unchanged
      const [unchangedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId1));

      expect(unchangedRun?.status).toBe("running");
    });

    it("should NOT cleanup completed runs even with old heartbeat", async () => {
      // Create a completed run with old heartbeat
      const oldTime = new Date(Date.now() - 10 * 60 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "completed",
        prompt: "Test prompt",
        sandboxId: "test-sandbox-123",
        createdAt: new Date(),
        lastHeartbeatAt: oldTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(0);

      // Verify sandbox was NOT killed
      expect(mockKillSandbox).not.toHaveBeenCalled();
    });

    it("should cleanup multiple expired sandboxes", async () => {
      const expiredTime = new Date(Date.now() - 5 * 60 * 1000);

      // Create two runs with expired heartbeats
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt 1",
        sandboxId: "test-sandbox-1",
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId2,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt 2",
        sandboxId: "test-sandbox-2",
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(2);
      expect(data.errors).toBe(0);
      expect(data.results).toHaveLength(2);

      // Verify both sandboxes were killed
      expect(mockKillSandbox).toHaveBeenCalledTimes(2);
    });

    it("should handle sandbox without sandboxId gracefully", async () => {
      const expiredTime = new Date(Date.now() - 3 * 60 * 1000);
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId1,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        sandboxId: null, // No sandbox ID
        createdAt: new Date(),
        lastHeartbeatAt: expiredTime,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/cron/cleanup-sandboxes",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
          },
        },
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.cleaned).toBe(1);

      // Verify killSandbox was NOT called (no sandboxId)
      expect(mockKillSandbox).not.toHaveBeenCalled();

      // Verify run status was still updated
      const [updatedRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId1));

      expect(updatedRun?.status).toBe("timeout");
    });
  });
});
