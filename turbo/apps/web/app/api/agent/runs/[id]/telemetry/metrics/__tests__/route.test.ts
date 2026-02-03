import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

interface AxiomMetricEvent {
  _time: string;
  runId: string;
  userId: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

function createAxiomMetricEvent(
  ts: string,
  cpu: number,
  runId: string,
  userId: string,
): AxiomMetricEvent {
  return {
    _time: ts,
    runId,
    userId,
    cpu,
    mem_used: 1000000000,
    mem_total: 2000000000,
    disk_used: 5000000000,
    disk_total: 10000000000,
  };
}

describe("GET /api/agent/runs/:id/telemetry/metrics", () => {
  let user: UserContext;
  let testRunId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose and run
    const { composeId } = await createTestCompose(
      `metrics-${randomUUID().slice(0, 8)}`,
    );

    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
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
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/metrics`,
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
        `other-metrics-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user run",
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty metrics when Axiom returns empty", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return empty metrics when Axiom is not configured", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return metrics from Axiom", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:00Z",
          50,
          testRunId,
          user.userId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].cpu).toBe(50);
      expect(data.metrics[0].mem_used).toBe(1000000000);
      expect(data.metrics[0].ts).toBe("2024-01-01T00:00:00Z");
      expect(data.hasMore).toBe(false);

      // Verify Axiom was queried with correct APL
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining(`where runId == "${testRunId}"`),
      );
    });
  });

  describe("Retrieval from Axiom", () => {
    it("should return multiple metrics in order", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:00Z",
          10,
          testRunId,
          user.userId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:05Z",
          15,
          testRunId,
          user.userId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:10Z",
          20,
          testRunId,
          user.userId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:15Z",
          25,
          testRunId,
          user.userId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(4);
      expect(data.metrics[0].cpu).toBe(10);
      expect(data.metrics[1].cpu).toBe(15);
      expect(data.metrics[2].cpu).toBe(20);
      expect(data.metrics[3].cpu).toBe(25);
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter and indicate hasMore", async () => {
      // Mock Axiom returning limit+1 records (indicating more data exists)
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:00Z",
          10,
          testRunId,
          user.userId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:05Z",
          20,
          testRunId,
          user.userId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:10Z",
          30,
          testRunId,
          user.userId,
        ),
        createAxiomMetricEvent(
          "2024-01-01T00:00:15Z",
          40,
          testRunId,
          user.userId,
        ), // Extra record
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(3);
      expect(data.metrics[0].cpu).toBe(10);
      expect(data.metrics[1].cpu).toBe(20);
      expect(data.metrics[2].cpu).toBe(30);
      expect(data.hasMore).toBe(true);

      // Verify limit+1 was requested
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("limit 4"),
      );
    });

    it("should include since filter in Axiom query", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomMetricEvent(
          "2024-01-01T00:00:10Z",
          50,
          testRunId,
          user.userId,
        ),
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/metrics?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].cpu).toBe(50);

      // Verify since filter was included in APL query
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time > datetime"),
      );
    });
  });
});
