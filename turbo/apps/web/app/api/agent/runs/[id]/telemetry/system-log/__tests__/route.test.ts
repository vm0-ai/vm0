import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { NextRequest } from "next/server";
import { POST as TelemetryWebhook } from "../../../../../../../../app/api/webhooks/agent/telemetry/route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import * as metricsModule from "../../../../../../../../src/lib/metrics";

const context = testContext();

describe("GET /api/agent/runs/:id/telemetry/system-log", () => {
  let user: UserContext;
  let testRunId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose and run
    const { composeId } = await createTestCompose(uniqueId("system-log"));

    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;

    vi.spyOn(
      metricsModule,
      "recordSandboxInternalOperation",
    ).mockImplementation(() => {});
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

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
      // Create another user with their own compose and run
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-system-log-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user run",
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/system-log`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty system log when no telemetry exists", async () => {
      // Default context.mocks.axiom.queryAxiom returns empty array
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.hasMore).toBe(false);
    });

    it("should return system log from Axiom", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        {
          _time: new Date().toISOString(),
          runId: testRunId,
          log: "[INFO] Test log entry\n",
        },
      ]);

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
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        {
          _time: new Date(Date.now() - 2000).toISOString(),
          runId: testRunId,
          log: "[INFO] First entry\n",
        },
        {
          _time: new Date(Date.now() - 1000).toISOString(),
          runId: testRunId,
          log: "[INFO] Second entry\n",
        },
        {
          _time: new Date().toISOString(),
          runId: testRunId,
          log: "[INFO] Third entry\n",
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

    it("should return empty when Axiom returns null and no DB data exists", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("");
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter", async () => {
      // Mock Axiom returning 3 records (more than limit of 2)
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        {
          _time: new Date(Date.now() - 3000).toISOString(),
          runId: testRunId,
          log: "[INFO] Entry 1\n",
        },
        {
          _time: new Date(Date.now() - 2000).toISOString(),
          runId: testRunId,
          log: "[INFO] Entry 2\n",
        },
        {
          _time: new Date(Date.now() - 1000).toISOString(),
          runId: testRunId,
          log: "[INFO] Entry 3\n",
        },
      ]);

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

    it("should pass since parameter to Axiom query", async () => {
      // Mock Axiom returning only recent entry (since filter applied by Axiom)
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        {
          _time: new Date(Date.now() - 1000).toISOString(),
          runId: testRunId,
          log: "[INFO] Recent entry\n",
        },
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.systemLog).toBe("[INFO] Recent entry\n");

      // Verify queryAxiom was called with a query containing the since filter
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time >"),
      );
    });
  });

  describe("DB fallback (Axiom not configured)", () => {
    it("should return system log from DB when Axiom is not configured", async () => {
      // 1. Send telemetry via webhook with Axiom disabled
      context.mocks.axiom.ingestToAxiom.mockResolvedValue(false);
      mockClerk({ userId: user.userId });

      const testToken = await createTestSandboxToken(user.userId, testRunId);
      mockClerk({ userId: null });

      const webhookRequest = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            systemLog: "[INFO] DB fallback round-trip test\n",
          }),
        },
      );

      const webhookResponse = await TelemetryWebhook(webhookRequest);
      expect(webhookResponse.status).toBe(200);

      // 2. Query system-log with Axiom returning null (triggers DB fallback)
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);
      mockClerk({ userId: user.userId });

      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/system-log`,
      );

      const getResponse = await GET(getRequest);

      expect(getResponse.status).toBe(200);
      const data = await getResponse.json();
      expect(data.systemLog).toContain("[INFO] DB fallback round-trip test");
      expect(data.hasMore).toBe(false);
    });
  });
});
