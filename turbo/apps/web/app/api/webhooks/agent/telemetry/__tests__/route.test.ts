import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { POST as createCompose } from "../../../../agent/composes/route";
import { POST as createRun } from "../../../../agent/runs/route";
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

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock Axiom SDK (external)
vi.mock("@axiomhq/js");

// Mock E2B SDK (external)
vi.mock("@e2b/code-interpreter");

import { headers } from "next/headers";
import { Sandbox } from "@e2b/code-interpreter";
import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../src/__tests__/clerk-mock";
import { Axiom } from "@axiomhq/js";
import * as axiomModule from "../../../../../../src/lib/axiom";

const mockHeaders = vi.mocked(headers);

// Spy for ingestToAxiom - will be set up in beforeEach
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ingestToAxiomSpy: any;

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

    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

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

  // NOTE: Server-side secrets masking has been removed.
  // Secrets are now masked client-side in the sandbox before being sent to the server.
  // The server never has access to secret values (only secret names for validation).
  // See: feat: separate secrets from vars in checkpoint/session system
});

describe("POST /api/webhooks/agent/telemetry - Runner Integration", () => {
  const testUserId = `runner-user-${Date.now()}-${process.pid}`;
  const testScopeId = randomUUID();
  const testAgentName = `test-runner-telemetry-${Date.now()}`;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Mock Clerk auth
    mockClerk({ userId: testUserId });

    const mockHeaders = vi.mocked(headers);
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Setup E2B SDK mock
    const mockSandbox = {
      sandboxId: `test-sandbox-${Date.now()}`,
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

    // Setup Axiom SDK mock
    const mockAxiomClient = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Axiom).mockImplementation(
      () => mockAxiomClient as unknown as Axiom,
    );

    // Clean up test data from previous runs
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));

    // Create test scope (required for compose creation)
    await globalThis.services.db.insert(scopes).values({
      id: testScopeId,
      slug: `test-${testScopeId.slice(0, 8)}`,
      type: "personal",
      ownerId: testUserId,
    });

    // Create test compose via API
    const config = createDefaultComposeConfig(testAgentName);
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
    testComposeId = composeData.composeId;

    // Create test run via API (will create E2B sandbox)
    const runRequest = new NextRequest("http://localhost:3000/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentComposeId: testComposeId,
        prompt: "Test prompt for telemetry",
      }),
    });

    const runResponse = await createRun(runRequest);
    const runData = await runResponse.json();
    testRunId = runData.runId;

    // Generate sandbox token for this run
    testToken = await createTestSandboxToken(testUserId, testRunId);

    // Mock headers to use sandbox token for webhook requests
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
    } as unknown as Headers);

    // Add runner job queue entry to mark this as a runner sandbox
    // (This is the only direct DB operation, as there's no API to create runner jobs)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);
    await globalThis.services.db.insert(runnerJobQueue).values({
      runId: testRunId,
      runnerGroup: "test-group",
      claimedAt: new Date(),
      executionContext: {
        runId: testRunId,
        prompt: "Test prompt for telemetry",
        workingDir: "/workspace",
        cliAgentType: "claude-code",
        sandboxToken: testToken,
        apiStartTime: Date.now(),
      },
      createdAt: new Date(),
      expiresAt,
    });
  });

  afterEach(async () => {
    clearClerkMock();
    // Clean up test data (cascade deletes will handle related records)
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  it("should determine sandbox type as runner and record metrics", async () => {
    // Spy on ingestToAxiom
    const ingestToAxiomSpy = vi
      .spyOn(axiomModule, "ingestToAxiom")
      .mockResolvedValue(true);

    // Spy on recordSandboxInternalOperation to verify sandbox type
    const recordMetricsSpy = vi.spyOn(
      await import("../../../../../../src/lib/metrics"),
      "recordSandboxInternalOperation",
    );

    // Simulate telemetry from runner sandbox
    const sandboxOperations = [
      {
        ts: "2025-01-22T10:00:00Z",
        action_type: "init_total",
        duration_ms: 1500,
        success: true,
      },
      {
        ts: "2025-01-22T10:00:02Z",
        action_type: "cli_execution",
        duration_ms: 200,
        success: true,
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
          systemLog: "[INFO] Test log from runner\n",
          sandboxOperations,
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify system log was sent to Axiom
    expect(ingestToAxiomSpy).toHaveBeenCalledWith(
      "vm0-sandbox-telemetry-system-dev",
      expect.arrayContaining([
        expect.objectContaining({
          runId: testRunId,
          userId: testUserId,
          log: "[INFO] Test log from runner\n",
        }),
      ]),
    );

    // Verify sandbox operations were recorded with correct sandbox type
    expect(recordMetricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "init_total",
        sandboxType: "runner",
        durationMs: 1500,
        success: true,
      }),
    );

    expect(recordMetricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "cli_execution",
        sandboxType: "runner",
        durationMs: 200,
        success: true,
      }),
    );
  });

  it("should determine sandbox type as e2b when not in runner queue", async () => {
    // Temporarily reset headers mock to allow Clerk auth for run creation
    const mockHeaders = vi.mocked(headers);
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Create a separate E2B run via API (will not be in runner_job_queue)
    const e2bRunRequest = new NextRequest(
      "http://localhost:3000/api/agent/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          prompt: "E2B test prompt",
        }),
      },
    );

    const e2bRunResponse = await createRun(e2bRunRequest);
    const e2bRunData = await e2bRunResponse.json();
    const e2bRunId = e2bRunData.runId;

    const e2bToken = await createTestSandboxToken(testUserId, e2bRunId);

    // Restore headers mock to use e2b sandbox token for webhook requests
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(`Bearer ${e2bToken}`),
    } as unknown as Headers);

    // Spy on recordSandboxInternalOperation
    const recordMetricsSpy = vi.spyOn(
      await import("../../../../../../src/lib/metrics"),
      "recordSandboxInternalOperation",
    );

    const sandboxOperations = [
      {
        ts: "2025-01-22T10:00:00Z",
        action_type: "api_to_agent_start",
        duration_ms: 500,
        success: true,
      },
    ];

    const request = new NextRequest(
      "http://localhost:3000/api/webhooks/agent/telemetry",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${e2bToken}`,
        },
        body: JSON.stringify({
          runId: e2bRunId,
          sandboxOperations,
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    // Verify sandbox type was determined as e2b
    expect(recordMetricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "api_to_agent_start",
        sandboxType: "e2b",
        durationMs: 500,
        success: true,
      }),
    );

    // Cleanup
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, e2bRunId));
  });

  it("should upload complete telemetry with all data types", async () => {
    const ingestToAxiomSpy = vi
      .spyOn(axiomModule, "ingestToAxiom")
      .mockResolvedValue(true);

    const testMetrics = [
      {
        ts: "2025-01-22T10:00:00Z",
        cpu: 25.5,
        mem_used: 167190528,
        mem_total: 1033142272,
        disk_used: 1556893696,
        disk_total: 22797680640,
      },
    ];

    const testNetworkLogs = [
      {
        timestamp: "2025-01-22T10:00:00Z",
        mode: "sni" as const,
        action: "ALLOW" as const,
        host: "api.example.com",
        port: 443,
        rule_matched: "allow-all",
      },
    ];

    const sandboxOperations = [
      {
        ts: "2025-01-22T10:00:00Z",
        action_type: "storage_download",
        duration_ms: 1200,
        success: true,
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
          systemLog: "[INFO] Complete telemetry test\n",
          metrics: testMetrics,
          networkLogs: testNetworkLogs,
          sandboxOperations,
        }),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);

    // Verify system log ingestion
    expect(ingestToAxiomSpy).toHaveBeenCalledWith(
      "vm0-sandbox-telemetry-system-dev",
      expect.arrayContaining([
        expect.objectContaining({
          runId: testRunId,
          log: "[INFO] Complete telemetry test\n",
        }),
      ]),
    );

    // Verify metrics ingestion
    expect(ingestToAxiomSpy).toHaveBeenCalledWith(
      "vm0-sandbox-telemetry-metrics-dev",
      expect.arrayContaining([
        expect.objectContaining({
          runId: testRunId,
          cpu: 25.5,
          mem_used: 167190528,
        }),
      ]),
    );

    // Verify network logs ingestion
    expect(ingestToAxiomSpy).toHaveBeenCalledWith(
      "vm0-sandbox-telemetry-network-dev",
      expect.arrayContaining([
        expect.objectContaining({
          runId: testRunId,
          mode: "sni",
          action: "ALLOW",
          host: "api.example.com",
        }),
      ]),
    );
  });
});
