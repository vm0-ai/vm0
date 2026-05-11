import { describe, it, expect, beforeEach, vi } from "vitest";
import { Axiom } from "@axiomhq/js";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import type { MockInstance } from "vitest";
import type {
  flushAxiom,
  ingestToAxiom,
} from "../../../../../../src/lib/shared/axiom/client";

const context = testContext();

// Persistent SDK-level `ingest` spy. `ingestSandboxOpLog` calls
// `client.ingest(dataset, [...])` on the @axiomhq/js SDK instance returned
// by the (globally mocked) Axiom constructor. We override that constructor
// per-test with a regular function returning a stable object containing
// this spy, so we can assert at the SDK boundary instead of mocking
// internal vm0 code (AP-4).
const mockSdkIngest = vi.fn();

describe("POST /api/webhooks/agent/telemetry", () => {
  let user: UserContext;
  let testComposeId: string;
  let axiomIngestMock: MockInstance<typeof ingestToAxiom>;
  let axiomFlushMock: MockInstance<typeof flushAxiom>;

  beforeEach(async () => {
    // Stub the telemetry token so ingestSandboxOpLog runs end-to-end into
    // the (mocked) Axiom SDK and we can assert at the SDK boundary.
    vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "test-telemetry-token");
    reloadEnv();

    const mocks = context.setupMocks();
    user = await context.setupUser();
    axiomIngestMock = mocks.axiom.ingestToAxiom;
    axiomFlushMock = mocks.axiom.flushAxiom;

    // setupMocks() installs an arrow-function impl on the global Axiom
    // constructor, which can't be `new`'d. Override it here with a regular
    // function so `new Axiom()` in instances.ts succeeds, and route the
    // resulting client's `ingest` to our persistent spy.
    mockSdkIngest.mockReset();
    vi.mocked(Axiom).mockImplementation(function MockAxiom(this: object) {
      return {
        ingest: mockSdkIngest,
        query: vi.fn().mockResolvedValue({ matches: [] }),
        flush: vi.fn().mockResolvedValue(undefined),
      } as unknown as Axiom;
    });

    // Create compose for run creation (needs Clerk auth from setupUser)
    const { composeId } = await createTestCompose(
      `telemetry-agent-${Date.now()}`,
    );
    testComposeId = composeId;
  });

  /**
   * Find the sandbox-sourced op event for a given runId in mockSdkIngest's
   * call history. Filters to `vm0-sandbox-op-log-*` dataset calls whose
   * event has `source: "sandbox"` and matching `run_id`. This separates
   * runner-uploaded ops (from the route under test) from `source: "web"`
   * ops emitted by upstream test setup paths.
   */
  function findSandboxOpEvent(runId: string): Record<string, unknown> {
    for (const call of mockSdkIngest.mock.calls) {
      const dataset = call[0];
      if (
        typeof dataset !== "string" ||
        !dataset.startsWith("vm0-sandbox-op-log-")
      ) {
        continue;
      }
      const events = call[1] as Array<Record<string, unknown>>;
      for (const event of events) {
        if (event.source === "sandbox" && event.run_id === runId) {
          return event;
        }
      }
    }
    throw new Error(
      `No sandbox-sourced op-log event found for runId=${runId}. ` +
        `Calls: ${JSON.stringify(mockSdkIngest.mock.calls)}`,
    );
  }

  /**
   * Helper to create a run and prepare it for webhook testing.
   * Creates run with Clerk auth, then clears auth for webhook call.
   */
  async function createRunForWebhook(composeId: string, prompt: string) {
    // Ensure Clerk auth is set for run creation
    mockClerk({ userId: user.userId });
    const { runId } = await createTestRun(composeId, prompt);
    // Clear Clerk auth for webhook (webhook uses sandbox token, not Clerk)
    mockClerk({ userId: null });
    return { runId };
  }

  describe("Authentication", () => {
    it("should reject telemetry without authentication", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
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
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

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
      const nonExistentRunId = "00000000-0000-0000-0000-000000000000";
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
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
      // Create a run with the current user
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");

      // Create a token for a different user but same runId
      const otherUserId = `other-user-${Date.now()}`;
      const tokenForOtherUser = await createTestSandboxToken(
        otherUserId,
        runId,
      );

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForOtherUser}`,
          },
          body: JSON.stringify({
            runId,
            systemLog: "test log",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("Success", () => {
    it("should send systemLog to Axiom", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId,
            systemLog: "[2025-12-09T10:00:00Z] [INFO] Test log message",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify Axiom ingest was called with correct dataset and events
      expect(axiomIngestMock).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            log: "[2025-12-09T10:00:00Z] [INFO] Test log message",
          }),
        ]),
      );
    });

    it("should send metrics to Axiom", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

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
            runId,
            metrics: testMetrics,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(axiomIngestMock).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-metrics-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            userId: user.userId,
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
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

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
        {
          timestamp: "2025-12-09T10:00:00.001Z",
          type: "dns",
          host: "api.github.com",
          port: 53,
          dns_event: "query",
          dns_query_type: "A",
          dns_serial: "42",
        },
        {
          timestamp: "2025-12-09T10:00:00.002Z",
          type: "dns",
          host: "api.github.com",
          port: 53,
          dns_event: "reply",
          dns_result: "140.82.121.4",
          dns_serial: "42",
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
            runId,
            networkLogs: testNetworkLogs,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(axiomIngestMock).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-network-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            userId: user.userId,
            method: "GET",
            url: "https://api.example.com/data",
            status: 200,
            latency_ms: 150,
            request_size: 0,
            response_size: 1024,
          }),
          expect.objectContaining({
            runId,
            userId: user.userId,
            type: "dns",
            host: "api.github.com",
            port: 53,
            dns_event: "query",
            dns_query_type: "A",
            dns_serial: "42",
          }),
          expect.objectContaining({
            runId,
            userId: user.userId,
            type: "dns",
            host: "api.github.com",
            port: 53,
            dns_event: "reply",
            dns_result: "140.82.121.4",
            dns_serial: "42",
          }),
        ]),
      );
      expect(axiomFlushMock).toHaveBeenCalledWith({
        client: "telemetry",
        throwOnError: true,
      });
    });

    it("should send systemLog and metrics to Axiom", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

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
            runId,
            systemLog: "[2025-12-09T10:00:00Z] [INFO] Agent started\n",
            metrics: testMetrics,
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      expect(axiomIngestMock).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-system-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            log: "[2025-12-09T10:00:00Z] [INFO] Agent started\n",
          }),
        ]),
      );

      expect(axiomIngestMock).toHaveBeenCalledWith(
        "vm0-sandbox-telemetry-metrics-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            userId: user.userId,
            cpu: 25.5,
          }),
        ]),
      );
    });

    it("should allow multiple telemetry uploads for the same run", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

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
            runId,
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
            runId,
            systemLog: "Second batch",
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);

      // Axiom ingest should be called twice (once per telemetry upload)
      expect(axiomIngestMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("Sandbox operations", () => {
    it("should record sandbox operations with runner type", async () => {
      const { runId } = await createRunForWebhook(
        testComposeId,
        "Test runner run",
      );
      const testToken = await createTestSandboxToken(user.userId, runId);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId,
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

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Successful op forwarded all the way to the Axiom SDK boundary with
      // success=true and no `error` key on the buffered event. `source:
      // "sandbox"` distinguishes runner-uploaded ops from `source: "web"`
      // ops emitted by upstream code paths during the same test (e.g.,
      // run creation in setupUser/createTestRun).
      const sandboxOpEvent = findSandboxOpEvent(runId);
      expect(sandboxOpEvent).toMatchObject({
        source: "sandbox",
        op_type: "api_to_agent_start",
        sandbox_type: "runner",
        duration_ms: 1500,
        success: true,
        run_id: runId,
      });
      expect(sandboxOpEvent).not.toHaveProperty("error");
    });

    it("should forward op.error and op.success through to axiom (#12077)", async () => {
      const { runId } = await createRunForWebhook(
        testComposeId,
        "Test runner run with stderr",
      );
      const testToken = await createTestSandboxToken(user.userId, runId);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId,
            sandboxOperations: [
              {
                ts: "2026-05-07T08:02:53.184Z",
                action_type: "cli_execution",
                duration_ms: 82,
                success: false,
                error: "codex exec exited with status 1",
              },
            ],
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Both success=false AND the underlying error string must reach the
      // Axiom SDK boundary in the `vm0-sandbox-op-log-*` dataset. Before
      // #12077 the route dropped op.error on the floor, leaving prod codex
      // failures un-debuggable from this dataset.
      const sandboxOpEvent = findSandboxOpEvent(runId);
      expect(sandboxOpEvent).toMatchObject({
        source: "sandbox",
        op_type: "cli_execution",
        sandbox_type: "runner",
        duration_ms: 82,
        success: false,
        run_id: runId,
        error: "codex exec exited with status 1",
      });
    });
  });

  describe("DB fallback (Axiom not configured)", () => {
    beforeEach(() => {
      // Simulate Axiom not configured
      axiomIngestMock.mockResolvedValue(false);
    });

    it("should store systemLog to DB when Axiom is not configured", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId,
            systemLog: "[2025-12-09T10:00:00Z] [INFO] DB fallback test\n",
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should store metrics to DB when Axiom is not configured", async () => {
      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId,
            metrics: [
              {
                ts: "2025-12-09T10:00:00Z",
                cpu: 42.5,
                mem_used: 100000000,
                mem_total: 200000000,
                disk_used: 500000000,
                disk_total: 1000000000,
              },
            ],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should not store to DB when Axiom ingest succeeds", async () => {
      axiomIngestMock.mockResolvedValue(true);

      const { runId } = await createRunForWebhook(testComposeId, "Test prompt");
      const testToken = await createTestSandboxToken(user.userId, runId);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId,
            systemLog: "[INFO] Axiom is configured\n",
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Axiom ingest was called and returned true, so DB fallback should NOT run
      expect(axiomIngestMock).toHaveBeenCalled();
    });
  });
});
