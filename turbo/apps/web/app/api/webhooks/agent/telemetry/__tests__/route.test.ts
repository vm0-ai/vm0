import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { POST as createRun } from "../../../../agent/runs/route";
import { POST as createCompose } from "../../../../agent/composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../../../src/db/schema/scope";
import { runnerJobQueue } from "../../../../../../src/db/schema/runner-job-queue";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestSandboxToken,
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../../../../src/__tests__/api-test-helpers";
import { Sandbox } from "@e2b/code-interpreter";
import * as s3Client from "../../../../../../src/lib/s3/s3-client";

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock Axiom SDK (external)
vi.mock("@axiomhq/js");

// Mock E2B SDK (external)
vi.mock("@e2b/code-interpreter");

// Mock AWS SDK (external) for S3 operations
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../src/__tests__/clerk-mock";
import { Axiom } from "@axiomhq/js";
import * as axiomModule from "../../../../../../src/lib/axiom";
import * as metricsModule from "../../../../../../src/lib/metrics";
import type { MockInstance } from "vitest";

// Spy for ingestToAxiom - will be set up in beforeEach
let ingestToAxiomSpy: MockInstance<typeof axiomModule.ingestToAxiom>;

// Spy for recordSandboxInternalOperation - will be set up in beforeEach
let recordSandboxInternalOperationSpy: MockInstance<
  typeof metricsModule.recordSandboxInternalOperation
>;

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

    mockClerk({ userId: null });

    // Setup Axiom SDK mock
    const mockAxiomClient = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Axiom).mockImplementation(
      () => mockAxiomClient as unknown as Axiom,
    );

    // Setup spy on ingestToAxiom - returns true by default
    ingestToAxiomSpy = vi
      .spyOn(axiomModule, "ingestToAxiom")
      .mockResolvedValue(true);

    // Setup spy on recordSandboxInternalOperation
    recordSandboxInternalOperationSpy = vi
      .spyOn(metricsModule, "recordSandboxInternalOperation")
      .mockImplementation(() => {});

    // Setup E2B SDK mock - create sandbox
    const mockSandbox = {
      sandboxId: "test-sandbox-123",
      getHostname: () => "test-sandbox.e2b.dev",
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
      commands: {
        run: vi.fn().mockResolvedValue({
          stdout: "Mock output",
          stderr: "",
          exitCode: 0,
        }),
      },
      kill: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Sandbox.create).mockResolvedValue(
      mockSandbox as unknown as Sandbox,
    );

    // Setup S3 mocks
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

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
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
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
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
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
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
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
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            log: "[2025-12-09T10:00:00Z] [INFO] Agent started\n",
          }),
        ]),
      );

      // Verify Axiom was called with metrics
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
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
      expect(ingestToAxiomSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("Sandbox type detection", () => {
    // These tests create runs via the runs API to verify sandbox type detection
    // E2B runs have sandboxId set by E2B executor, Runner runs do not

    it("should detect E2B sandbox type when run is created via E2B executor", async () => {
      // Mock Clerk to return test user for runs API
      mockClerk({ userId: testUserId });

      // Create compose via API
      const config = createDefaultComposeConfig("test-agent-e2b");
      const composeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: config }),
        },
      );
      const composeResponse = await createCompose(composeRequest);
      const composeData = await composeResponse.json();
      const e2bComposeId = composeData.composeId;

      // Create run via runs API (E2B path - no experimental_runner)
      const runRequest = new NextRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: e2bComposeId,
            prompt: "Test E2B run",
          }),
        },
      );
      const runResponse = await createRun(runRequest);
      expect(runResponse.status).toBe(201);
      const runData = await runResponse.json();
      const e2bRunId = runData.runId;

      // Generate token for the new run
      const e2bToken = await createTestSandboxToken(testUserId, e2bRunId);

      // Verify run has sandboxId (set by E2B executor)
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, e2bRunId))
        .limit(1);
      expect(run?.sandboxId).toBe("test-sandbox-123");

      // Send telemetry with sandboxOperations
      const telemetryRequest = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${e2bToken}`,
          },
          body: JSON.stringify({
            runId: e2bRunId,
            sandboxOperations: [
              {
                ts: "2026-01-29T10:00:00Z",
                action_type: "api_to_agent_start",
                duration_ms: 1500,
                success: true,
              },
            ],
          }),
        },
      );

      const telemetryResponse = await POST(telemetryRequest);
      expect(telemetryResponse.status).toBe(200);

      // Verify recordSandboxInternalOperation was called with sandboxType: "e2b"
      expect(recordSandboxInternalOperationSpy).toHaveBeenCalledWith({
        actionType: "api_to_agent_start",
        sandboxType: "e2b",
        durationMs: 1500,
        success: true,
      });

      // Cleanup
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, e2bRunId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, e2bComposeId));
    });

    it("should detect Runner sandbox type when run is created via Runner executor", async () => {
      // Mock Clerk to return test user for runs API
      mockClerk({ userId: testUserId });

      // Create compose with experimental_runner config via API
      // Runner group must be in scope/name format
      const runnerConfig = createDefaultComposeConfig("test-agent-runner", {
        experimental_runner: {
          group: `test-${testScopeId.slice(0, 8)}/runner`,
        },
      });
      const composeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: runnerConfig }),
        },
      );
      const composeResponse = await createCompose(composeRequest);
      const composeData = await composeResponse.json();
      const runnerComposeId = composeData.composeId;

      // Create run via runs API (Runner path - has experimental_runner)
      const runRequest = new NextRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: runnerComposeId,
            prompt: "Test Runner run",
          }),
        },
      );
      const runResponse = await createRun(runRequest);
      expect(runResponse.status).toBe(201);
      const runData = await runResponse.json();
      const runnerRunId = runData.runId;

      // Generate token for the new run
      const runnerToken = await createTestSandboxToken(testUserId, runnerRunId);

      // Verify run does NOT have sandboxId (Runner executor doesn't set it)
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runnerRunId))
        .limit(1);
      expect(run?.sandboxId).toBeNull();

      // Send telemetry with sandboxOperations
      const telemetryRequest = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${runnerToken}`,
          },
          body: JSON.stringify({
            runId: runnerRunId,
            sandboxOperations: [
              {
                ts: "2026-01-29T10:00:00Z",
                action_type: "api_to_agent_start",
                duration_ms: 800,
                success: true,
              },
            ],
          }),
        },
      );

      const telemetryResponse = await POST(telemetryRequest);
      expect(telemetryResponse.status).toBe(200);

      // Verify recordSandboxInternalOperation was called with sandboxType: "runner"
      expect(recordSandboxInternalOperationSpy).toHaveBeenCalledWith({
        actionType: "api_to_agent_start",
        sandboxType: "runner",
        durationMs: 800,
        success: true,
      });

      // Cleanup
      await globalThis.services.db
        .delete(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, runnerRunId));
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, runnerRunId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, runnerComposeId));
    });
  });

  // NOTE: Server-side secrets masking has been removed.
  // Secrets are now masked client-side in the sandbox before being sent to the server.
  // The server never has access to secret values (only secret names for validation).
  // See: feat: separate secrets from vars in checkpoint/session system
});
