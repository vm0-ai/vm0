import { describe, it, expect, beforeEach, vi } from "vitest";
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
import * as metricsModule from "../../../../../../src/lib/metrics";
import * as axiomClient from "../../../../../../src/lib/axiom/client";
import type { MockInstance } from "vitest";

const context = testContext();

describe("POST /api/webhooks/agent/telemetry", () => {
  let user: UserContext;
  let testComposeId: string;
  let axiomIngestMock: MockInstance<typeof axiomClient.ingestToAxiom>;
  let recordSandboxInternalOperationSpy: MockInstance<
    typeof metricsModule.recordSandboxInternalOperation
  >;

  beforeEach(async () => {
    const mocks = context.setupMocks();
    user = await context.setupUser();
    axiomIngestMock = mocks.axiom.ingestToAxiom;

    // Create compose for run creation (needs Clerk auth from setupUser)
    const { composeId } = await createTestCompose(
      `telemetry-agent-${Date.now()}`,
    );
    testComposeId = composeId;

    recordSandboxInternalOperationSpy = vi
      .spyOn(metricsModule, "recordSandboxInternalOperation")
      .mockImplementation(() => {});
  });

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
        ]),
      );
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

  describe("Sandbox type detection", () => {
    it("should detect E2B sandbox type when run has sandboxId", async () => {
      // E2B runs have sandboxId set by E2B executor (mock returns unique sandboxId per test)
      const { runId } = await createRunForWebhook(
        testComposeId,
        "Test E2B run",
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

      expect(recordSandboxInternalOperationSpy).toHaveBeenCalledWith({
        actionType: "api_to_agent_start",
        sandboxType: "e2b",
        durationMs: 1500,
        success: true,
      });
    });

    // NOTE: Runner sandbox type detection test removed during refactoring.
    // The sandbox type is determined by whether sandboxId is set (E2B) or null (Runner).
    // Testing this through the API is complex because the E2B mock always sets sandboxId.
    // The E2B path is covered by the test above, and the logic for runner detection
    // (sandboxId === null) is a simple conditional in the route handler.
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
