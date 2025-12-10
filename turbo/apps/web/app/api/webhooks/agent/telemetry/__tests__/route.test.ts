/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../../src/db/schema/sandbox-telemetry";
import { cliTokens } from "../../../../../../src/db/schema/cli-tokens";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
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

describe("POST /api/webhooks/agent/telemetry", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const testToken = `vm0_live_test_${Date.now()}_${process.pid}`;

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    mockAuth.mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);

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
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

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
      .delete(sandboxTelemetry)
      .where(eq(sandboxTelemetry.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));
  });

  describe("Authentication", () => {
    it("should reject telemetry without authentication", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "test log",
            metrics: [],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe("Validation", () => {
    beforeEach(async () => {
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject telemetry without runId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            systemLog: "test log",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });
  });

  describe("Authorization", () => {
    beforeEach(async () => {
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject telemetry for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            systemLog: "test log",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject telemetry for run owned by different user", async () => {
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: otherUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "test log",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("Success", () => {
    beforeEach(async () => {
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });
    });

    it("should store telemetry with systemLog only", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "[2025-12-09T10:00:00Z] [INFO] Test log message",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.id).toBeDefined();

      // Verify database entry
      const [telemetry] = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.id, data.id));

      expect(telemetry).toBeDefined();
      expect(telemetry?.runId).toBe(testRunId);
      const telemetryData = telemetry?.data as {
        systemLog: string;
        metrics: unknown[];
      };
      expect(telemetryData.systemLog).toBe(
        "[2025-12-09T10:00:00Z] [INFO] Test log message",
      );
      expect(telemetryData.metrics).toEqual([]);
    });

    it("should store telemetry with metrics only", async () => {
      const testMetrics = [
        {
          ts: "2025-12-09T10:00:00Z",
          cpu: 25.5,
          mem_used: 167190528,
          mem_total: 1033142272,
          disk_used: 1556893696,
          disk_total: 22797680640,
        },
      ];

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            metrics: testMetrics,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify database entry
      const [telemetry] = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.id, data.id));

      expect(telemetry).toBeDefined();
      const telemetryData = telemetry?.data as {
        systemLog: string;
        metrics: unknown[];
      };
      expect(telemetryData.systemLog).toBe("");
      expect(telemetryData.metrics).toEqual(testMetrics);
    });

    it("should store telemetry with both systemLog and metrics", async () => {
      const testMetrics = [
        {
          ts: "2025-12-09T10:00:00Z",
          cpu: 25.5,
          mem_used: 167190528,
          mem_total: 1033142272,
          disk_used: 1556893696,
          disk_total: 22797680640,
        },
        {
          ts: "2025-12-09T10:00:05Z",
          cpu: 30.2,
          mem_used: 168000000,
          mem_total: 1033142272,
          disk_used: 1556900000,
          disk_total: 22797680640,
        },
      ];

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "[2025-12-09T10:00:00Z] [INFO] Agent started\n",
            metrics: testMetrics,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify database entry
      const [telemetry] = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.id, data.id));

      expect(telemetry).toBeDefined();
      const telemetryData = telemetry?.data as {
        systemLog: string;
        metrics: unknown[];
      };
      expect(telemetryData.systemLog).toBe(
        "[2025-12-09T10:00:00Z] [INFO] Agent started\n",
      );
      expect(telemetryData.metrics).toEqual(testMetrics);
    });

    it("should allow multiple telemetry uploads for the same run", async () => {
      // First upload
      const request1 = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "First batch",
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second upload
      const request2 = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "Second batch",
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);

      // Verify both entries exist
      const telemetries = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.runId, testRunId));

      expect(telemetries.length).toBe(2);
    });
  });
});
