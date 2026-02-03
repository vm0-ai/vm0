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

describe("GET /api/agent/runs/:id/telemetry/system-log", () => {
  let user: UserContext;
  let testRunId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose and run
    const { composeId } = await createTestCompose(
      `system-log-${randomUUID().slice(0, 8)}`,
    );

    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
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

    it("should handle Axiom returning null (not configured)", async () => {
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
});
