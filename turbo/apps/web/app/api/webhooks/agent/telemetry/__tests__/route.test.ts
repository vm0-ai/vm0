/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../../src/db/schema/sandbox-telemetry";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createTestSandboxToken } from "../../../../../../src/test/api-test-helpers";
import { encryptSecrets } from "../../../../../../src/lib/crypto";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock Axiom module
vi.mock("../../../../../../src/lib/axiom", () => ({
  ingestToAxiom: vi.fn().mockResolvedValue(true),
  getDatasetName: vi.fn((base: string) => `vm0-${base}-dev`),
  DATASETS: {
    SANDBOX_TELEMETRY_SYSTEM: "sandbox-telemetry-system",
  },
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { ingestToAxiom } from "../../../../../../src/lib/axiom";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);
const mockIngestToAxiom = vi.mocked(ingestToAxiom);

describe("POST /api/webhooks/agent/telemetry", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  let testToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(testUserId, testRunId);

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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);
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
    it("should reject telemetry for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      // Generate JWT with the non-existent runId
      const tokenForNonExistentRun = await createTestSandboxToken(
        testUserId,
        nonExistentRunId,
      );

      // Mock headers() to return the token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${tokenForNonExistentRun}`),
      } as unknown as Headers);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
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

      // Mock headers() to return the test token (JWT with testUserId)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

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
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });
    });

    it("should send systemLog to Axiom (not PostgreSQL)", async () => {
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

      // Verify Axiom was called with the systemLog
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            log: "[2025-12-09T10:00:00Z] [INFO] Test log message",
          }),
        ]),
      );

      // No PostgreSQL entry should be created for systemLog-only requests
      const telemetries = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.runId, testRunId));

      expect(telemetries.length).toBe(0);
    });

    it("should store telemetry with metrics only in PostgreSQL", async () => {
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

      // Verify database entry (metrics only, no systemLog)
      const [telemetry] = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.id, data.id));

      expect(telemetry).toBeDefined();
      const telemetryData = telemetry?.data as {
        metrics: unknown[];
      };
      expect(telemetryData.metrics).toEqual(testMetrics);

      // Axiom should not be called (no systemLog)
      expect(mockIngestToAxiom).not.toHaveBeenCalled();
    });

    it("should send systemLog to Axiom and metrics to PostgreSQL", async () => {
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

      // Verify Axiom was called with systemLog
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            log: "[2025-12-09T10:00:00Z] [INFO] Agent started\n",
          }),
        ]),
      );

      // Verify PostgreSQL entry has metrics (but no systemLog)
      const [telemetry] = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.id, data.id));

      expect(telemetry).toBeDefined();
      const telemetryData = telemetry?.data as {
        metrics: unknown[];
      };
      expect(telemetryData.metrics).toEqual(testMetrics);
    });

    it("should allow multiple telemetry uploads for the same run", async () => {
      // First upload with systemLog
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

      // Second upload with systemLog
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

      // Verify Axiom was called twice (systemLog goes to Axiom)
      expect(mockIngestToAxiom).toHaveBeenCalledTimes(2);
    });
  });

  describe("Secrets Masking", () => {
    const secretValue = "super_secret_api_key_12345";
    const encryptedSecrets = encryptSecrets({ API_KEY: secretValue });

    beforeEach(async () => {
      // Mock headers() to return the test token (JWT)
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Create run with encrypted secrets
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        secrets: encryptedSecrets,
        createdAt: new Date(),
      });
    });

    it("should mask secrets in systemLog before sending to Axiom", async () => {
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
            systemLog: `[INFO] Using API key: ${secretValue} for authentication`,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify Axiom was called with masked secret
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            log: "[INFO] Using API key: *** for authentication",
          }),
        ]),
      );
    });

    it("should mask secrets in networkLogs URLs", async () => {
      const networkLogs = [
        {
          timestamp: "2025-12-19T10:00:00Z",
          method: "GET",
          url: `https://api.example.com/data?api_key=${secretValue}`,
          status: 200,
          latency_ms: 150,
          request_size: 0,
          response_size: 1024,
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
            networkLogs,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Verify database entry has masked secret in URL
      const [telemetry] = await globalThis.services.db
        .select()
        .from(sandboxTelemetry)
        .where(eq(sandboxTelemetry.id, data.id));

      const telemetryData = telemetry?.data as {
        networkLogs: Array<{ url: string }>;
      };
      const firstNetworkLog = telemetryData.networkLogs[0];
      if (!firstNetworkLog) {
        throw new Error("Expected networkLogs[0] to be defined");
      }

      // Secret should be masked in URL
      expect(firstNetworkLog.url).not.toContain(secretValue);
      expect(firstNetworkLog.url).toContain("***");
    });

    it("should not mask when run has no secrets", async () => {
      // Delete run with secrets and create one without
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        secrets: null,
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
            systemLog: "No secrets here, just regular text",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify Axiom was called with unchanged content
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            log: "No secrets here, just regular text",
          }),
        ]),
      );
    });
  });
});
