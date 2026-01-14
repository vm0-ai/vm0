import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createTestSandboxToken } from "../../../../../../src/test/api-test-helpers";

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
  ingestRequestLog: vi.fn(),
  ingestSandboxOpLog: vi.fn(),
  getDatasetName: vi.fn((base: string) => `vm0-${base}-dev`),
  DATASETS: {
    SANDBOX_TELEMETRY_SYSTEM: "sandbox-telemetry-system",
    SANDBOX_TELEMETRY_METRICS: "sandbox-telemetry-metrics",
    SANDBOX_TELEMETRY_NETWORK: "sandbox-telemetry-network",
    AGENT_RUN_EVENTS: "agent-run-events",
    WEB_LOGS: "web-logs",
    REQUEST_LOG: "request-log",
    SANDBOX_OP_LOG: "sandbox-op-log",
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
  const testScopeId = randomUUID();
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

    it("should send systemLog to Axiom", async () => {
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
    });

    it("should send metrics to Axiom", async () => {
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

      // Verify Axiom was called with metrics
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-metrics-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            userId: testUserId,
            cpu: 25.5,
            mem_used: 167190528,
            mem_total: 1033142272,
            disk_used: 1556893696,
            disk_total: 22797680640,
          }),
        ]),
      );
    });

    it("should send network logs to Axiom", async () => {
      const testNetworkLogs = [
        {
          timestamp: "2025-12-09T10:00:00Z",
          method: "GET",
          url: "https://api.example.com/data",
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
            networkLogs: testNetworkLogs,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify Axiom was called with network logs
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-network-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            userId: testUserId,
            method: "GET",
            url: "https://api.example.com/data",
            status: 200,
            latency_ms: 150,
            request_size: 0,
            response_size: 1024,
          }),
        ]),
      );
    });

    it("should send systemLog and metrics to Axiom", async () => {
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

      // Verify Axiom was called with metrics
      expect(mockIngestToAxiom).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-metrics-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            userId: testUserId,
            cpu: 25.5,
          }),
        ]),
      );
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

  // NOTE: Server-side secrets masking has been removed.
  // Secrets are now masked client-side in the sandbox before being sent to the server.
  // The server never has access to secret values (only secret names for validation).
  // See: feat: separate secrets from vars in checkpoint/session system
});
