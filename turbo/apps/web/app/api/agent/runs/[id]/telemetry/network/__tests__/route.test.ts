import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

interface AxiomNetworkEvent {
  _time: string;
  runId: string;
  userId: string;
  method: string;
  url: string;
  status: number;
  latency_ms: number;
  request_size: number;
  response_size: number;
}

function createAxiomNetworkEvent(
  timestamp: string,
  method: string,
  url: string,
  status: number,
  runId: string,
  userId: string,
): AxiomNetworkEvent {
  return {
    _time: timestamp,
    runId,
    userId,
    method,
    url,
    status,
    latency_ms: 150,
    request_size: 100,
    response_size: 1024,
  };
}

describe("GET /api/agent/runs/:id/telemetry/network", () => {
  let user: UserContext;
  let testRunId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose and run
    const { composeId } = await createTestCompose(uniqueId("network"));

    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
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
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/network`,
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
        `other-network-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user run",
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty network logs when Axiom returns empty", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return empty network logs when Axiom is not configured", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return network logs from Axiom", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:00Z",
          "GET",
          "https://api.example.com/data",
          200,
          testRunId,
          user.userId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(1);
      expect(data.networkLogs[0].method).toBe("GET");
      expect(data.networkLogs[0].url).toBe("https://api.example.com/data");
      expect(data.networkLogs[0].status).toBe(200);
      expect(data.networkLogs[0].timestamp).toBe("2024-01-01T00:00:00Z");
      expect(data.hasMore).toBe(false);

      // Verify Axiom was queried with correct APL
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining(`where runId == "${testRunId}"`),
      );
    });
  });

  describe("Retrieval from Axiom", () => {
    it("should return multiple network logs in order", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:00Z",
          "GET",
          "https://api.example.com/users",
          200,
          testRunId,
          user.userId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:05Z",
          "POST",
          "https://api.example.com/data",
          201,
          testRunId,
          user.userId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:10Z",
          "PUT",
          "https://api.example.com/users/1",
          200,
          testRunId,
          user.userId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:15Z",
          "DELETE",
          "https://api.example.com/users/2",
          404,
          testRunId,
          user.userId,
        ),
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(4);
      expect(data.networkLogs[0].method).toBe("GET");
      expect(data.networkLogs[1].method).toBe("POST");
      expect(data.networkLogs[2].method).toBe("PUT");
      expect(data.networkLogs[3].method).toBe("DELETE");
      expect(data.networkLogs[3].status).toBe(404);
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter and indicate hasMore", async () => {
      // Mock Axiom returning limit+1 records (indicating more data exists)
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:00Z",
          "GET",
          "https://api.example.com/1",
          200,
          testRunId,
          user.userId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:05Z",
          "GET",
          "https://api.example.com/2",
          200,
          testRunId,
          user.userId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:10Z",
          "GET",
          "https://api.example.com/3",
          200,
          testRunId,
          user.userId,
        ),
        createAxiomNetworkEvent(
          "2024-01-01T00:00:15Z",
          "GET",
          "https://api.example.com/4",
          200,
          testRunId,
          user.userId,
        ), // Extra record
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(3);
      expect(data.networkLogs[0].url).toBe("https://api.example.com/1");
      expect(data.networkLogs[1].url).toBe("https://api.example.com/2");
      expect(data.networkLogs[2].url).toBe("https://api.example.com/3");
      expect(data.hasMore).toBe(true);

      // Verify limit+1 was requested
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("limit 4"),
      );
    });

    it("should include since filter in Axiom query", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue([
        createAxiomNetworkEvent(
          "2024-01-01T00:00:10Z",
          "GET",
          "https://api.example.com/recent",
          200,
          testRunId,
          user.userId,
        ),
      ]);

      const sinceTimestamp = Date.now() - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toHaveLength(1);
      expect(data.networkLogs[0].url).toBe("https://api.example.com/recent");

      // Verify since filter was included in APL query
      expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledWith(
        expect.stringContaining("where _time > datetime"),
      );
    });
  });

  describe("DB fallback (Axiom not configured)", () => {
    it("should return empty network logs from DB fallback when Axiom is not configured", async () => {
      context.mocks.axiom.queryAxiom.mockResolvedValue(null);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/network`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.networkLogs).toEqual([]);
      expect(data.hasMore).toBe(false);
    });
  });
});
