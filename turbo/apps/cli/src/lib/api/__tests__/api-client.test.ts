import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { apiClient } from "../api-client";
import * as config from "../config";

// Mock the config module
vi.mock("../config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

describe("ApiClient", () => {
  beforeEach(() => {
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createOrUpdateCompose", () => {
    it("should call correct endpoint with auth headers", async () => {
      const mockConfig = { version: "1.0", agent: { name: "test" } };
      const mockResponse = {
        composeId: "cmp-123",
        name: "test",
        action: "created" as const,
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/composes",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockResponse, { status: 201 });
          },
        ),
      );

      const result = await apiClient.createOrUpdateCompose({
        content: mockConfig,
      });

      expect(capturedRequest?.url).toBe(
        "http://localhost:3000/api/agent/composes",
      );
      expect(capturedRequest?.method).toBe("POST");
      expect(capturedRequest?.headers.get("authorization")).toBe(
        "Bearer test-token",
      );

      expect(result).toEqual(mockResponse);
    });

    it("should return created response", async () => {
      const mockResponse = {
        composeId: "cmp-123",
        name: "test-agent",
        action: "created" as const,
        createdAt: "2025-01-01T00:00:00Z",
      };

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockResponse, { status: 201 });
        }),
      );

      const result = await apiClient.createOrUpdateCompose({
        content: { version: "1", agents: { main: { provider: "claude" } } },
      });

      expect(result.action).toBe("created");
      expect(result.composeId).toBe("cmp-123");
      expect(result.name).toBe("test-agent");
    });

    it("should return updated response", async () => {
      const mockResponse = {
        composeId: "cmp-123",
        name: "test-agent",
        action: "updated" as const,
        updatedAt: "2025-01-01T00:00:00Z",
      };

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockResponse, { status: 200 });
        }),
      );

      const result = await apiClient.createOrUpdateCompose({
        content: { version: "1", agents: { main: { provider: "claude" } } },
      });

      expect(result.action).toBe("updated");
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(
        apiClient.createOrUpdateCompose({
          content: { version: "1", agents: { main: { provider: "claude" } } },
        }),
      ).rejects.toThrow("Not authenticated");
    });

    it("should throw error when API URL not configured", async () => {
      vi.mocked(config.getApiUrl).mockResolvedValue("");

      await expect(
        apiClient.createOrUpdateCompose({
          content: { version: "1", agents: { main: { provider: "claude" } } },
        }),
      ).rejects.toThrow("API URL not configured");
    });

    it("should throw error on HTTP error response", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: { message: "Invalid compose", code: "INVALID_COMPOSE" },
            },
            { status: 400 },
          );
        }),
      );

      await expect(
        apiClient.createOrUpdateCompose({
          content: { version: "1", agents: { main: { provider: "claude" } } },
        }),
      ).rejects.toThrow("Invalid compose");
    });

    it("should throw default error message when API error has no message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: { message: "", code: "ERROR" },
            },
            { status: 400 },
          );
        }),
      );

      await expect(
        apiClient.createOrUpdateCompose({
          content: { version: "1", agents: { main: { provider: "claude" } } },
        }),
      ).rejects.toThrow("Failed to create compose");
    });
  });

  describe("createRun", () => {
    it("should call correct endpoint with auth headers", async () => {
      const mockRequest = {
        agentComposeId: "cmp-123",
        prompt: "test prompt",
        artifactName: "my-artifact",
      };
      const mockResponse = {
        runId: "run-456",
        status: "pending" as const,
        createdAt: "2025-01-01T00:00:00Z",
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockResponse, { status: 201 });
          },
        ),
      );

      const result = await apiClient.createRun(mockRequest);

      expect(capturedRequest?.url).toBe("http://localhost:3000/api/agent/runs");
      expect(capturedRequest?.method).toBe("POST");
      expect(capturedRequest?.headers.get("authorization")).toBe(
        "Bearer test-token",
      );
      expect(capturedRequest?.headers.get("content-type")).toBe(
        "application/json",
      );

      expect(result).toEqual(mockResponse);
    });

    it("should support template variables", async () => {
      const mockRequest = {
        agentComposeId: "cmp-123",
        prompt: "test prompt",
        vars: { key1: "value1", key2: "value2" },
        artifactName: "my-artifact",
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(
              {
                runId: "run-456",
                status: "pending",
                createdAt: "2025-01-01T00:00:00Z",
              },
              { status: 201 },
            );
          },
        ),
      );

      await apiClient.createRun(mockRequest);

      const body = await capturedRequest?.text();
      expect(body).toBe(JSON.stringify(mockRequest));
    });

    it("should return completed run response", async () => {
      const mockResponse = {
        runId: "run-456",
        status: "completed" as const,
        sandboxId: "sbx-789",
        output: "Success!",
        executionTimeMs: 5000,
        createdAt: "2025-01-01T00:00:00Z",
      };

      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(mockResponse, { status: 201 });
        }),
      );

      const result = await apiClient.createRun({
        agentComposeId: "cmp-123",
        prompt: "test",
        artifactName: "my-artifact",
      });

      expect(result.status).toBe("completed");
      expect(result.output).toBe("Success!");
      expect(result.runId).toBe("run-456");
    });

    it("should return failed run response with error", async () => {
      const mockResponse = {
        runId: "run-456",
        status: "failed" as const,
        error: "Execution failed",
        createdAt: "2025-01-01T00:00:00Z",
      };

      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(mockResponse, { status: 201 });
        }),
      );

      const result = await apiClient.createRun({
        agentComposeId: "cmp-123",
        prompt: "test",
        artifactName: "my-artifact",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Execution failed");
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(
        apiClient.createRun({
          agentComposeId: "cmp-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("Not authenticated");
    });

    it("should throw error when API URL not configured", async () => {
      vi.mocked(config.getApiUrl).mockResolvedValue("");

      await expect(
        apiClient.createRun({
          agentComposeId: "cmp-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("API URL not configured");
    });

    it("should throw error on HTTP error response", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "Compose not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(
        apiClient.createRun({
          agentComposeId: "cmp-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("Compose not found");
    });

    it("should throw default error message when API error has no message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            { error: { message: "", code: "ERROR" } },
            { status: 400 },
          );
        }),
      );

      await expect(
        apiClient.createRun({
          agentComposeId: "cmp-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("Failed to create run");
    });
  });

  describe("getEvents", () => {
    it("should call correct endpoint with auth headers and default params", async () => {
      const mockResponse = {
        events: [],
        hasMore: false,
        nextSequence: 0,
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/events",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockResponse, { status: 200 });
          },
        ),
      );

      const result = await apiClient.getEvents("run-123");

      expect(capturedRequest?.url).toBe(
        "http://localhost:3000/api/agent/runs/run-123/events?since=-1&limit=100",
      );
      expect(capturedRequest?.method).toBe("GET");
      expect(capturedRequest?.headers.get("authorization")).toBe(
        "Bearer test-token",
      );

      expect(result).toEqual(mockResponse);
    });

    it("should support custom since parameter", async () => {
      const mockResponse = {
        events: [
          {
            sequenceNumber: 5,
            eventType: "text",
            eventData: { text: "hello" },
            createdAt: "2025-01-01T00:00:00Z",
          },
        ],
        hasMore: false,
        nextSequence: 5,
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/events",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockResponse, { status: 200 });
          },
        ),
      );

      const result = await apiClient.getEvents("run-123", { since: 4 });

      expect(capturedRequest?.url).toBe(
        "http://localhost:3000/api/agent/runs/run-123/events?since=4&limit=100",
      );

      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.sequenceNumber).toBe(5);
    });

    it("should support custom limit parameter", async () => {
      const mockResponse = {
        events: [],
        hasMore: false,
        nextSequence: 0,
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/events",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockResponse, { status: 200 });
          },
        ),
      );

      await apiClient.getEvents("run-123", { limit: 50 });

      expect(capturedRequest?.url).toBe(
        "http://localhost:3000/api/agent/runs/run-123/events?since=-1&limit=50",
      );
    });

    it("should support both since and limit parameters", async () => {
      const mockResponse = {
        events: [],
        hasMore: true,
        nextSequence: 150,
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/events",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockResponse, { status: 200 });
          },
        ),
      );

      const result = await apiClient.getEvents("run-123", {
        since: 100,
        limit: 50,
      });

      expect(capturedRequest?.url).toBe(
        "http://localhost:3000/api/agent/runs/run-123/events?since=100&limit=50",
      );

      expect(result.hasMore).toBe(true);
      expect(result.nextSequence).toBe(150);
    });

    it("should return events with all fields", async () => {
      const mockResponse = {
        events: [
          {
            sequenceNumber: 0,
            eventType: "init",
            eventData: { sessionId: "session-123" },
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            sequenceNumber: 1,
            eventType: "text",
            eventData: { text: "Processing..." },
            createdAt: "2025-01-01T00:00:01Z",
          },
        ],
        hasMore: false,
        nextSequence: 1,
      };

      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json(mockResponse, { status: 200 });
        }),
      );

      const result = await apiClient.getEvents("run-123");

      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        sequenceNumber: 0,
        eventType: "init",
        eventData: { sessionId: "session-123" },
        createdAt: "2025-01-01T00:00:00Z",
      });
      expect(result.events[1]).toEqual({
        sequenceNumber: 1,
        eventType: "text",
        eventData: { text: "Processing..." },
        createdAt: "2025-01-01T00:00:01Z",
      });
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(apiClient.getEvents("run-123")).rejects.toThrow(
        "Not authenticated",
      );
    });

    it("should throw error when API URL not configured", async () => {
      vi.mocked(config.getApiUrl).mockResolvedValue("");

      await expect(apiClient.getEvents("run-123")).rejects.toThrow(
        "API URL not configured",
      );
    });

    it("should throw error on HTTP error response", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json(
            {
              error: { message: "Run not found", code: "NOT_FOUND" },
            },
            { status: 404 },
          );
        }),
      );

      await expect(apiClient.getEvents("run-123")).rejects.toThrow(
        "Run not found",
      );
    });

    it("should throw default error message when API error has no message", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json(
            {
              error: { message: "", code: "ERROR" },
            },
            { status: 500 },
          );
        }),
      );

      await expect(apiClient.getEvents("run-123")).rejects.toThrow(
        "Failed to fetch events",
      );
    });
  });

  describe("getComposeVersion", () => {
    it("should handle version parameter with scientific notation correctly", async () => {
      // Version strings like "52999e37" look like scientific notation
      // ts-rest with jsonQuery automatically quotes these to prevent misinterpretation
      const scientificNotationVersion = "52999e37";

      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(
              { versionId: "full-hash-123" },
              { status: 200 },
            );
          },
        ),
      );

      await apiClient.getComposeVersion(
        "compose-123",
        scientificNotationVersion,
      );

      // ts-rest quotes the value to prevent scientific notation parsing
      const expectedUrl = `http://localhost:3000/api/agent/composes/versions?composeId=compose-123&version=${encodeURIComponent(JSON.stringify(scientificNotationVersion))}`;
      expect(capturedRequest?.url).toBe(expectedUrl);
    });

    it("should handle normal hex versions", async () => {
      const normalVersion = "a1b2c3d4";

      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(
              { versionId: "full-hash-456" },
              { status: 200 },
            );
          },
        ),
      );

      await apiClient.getComposeVersion("compose-123", normalVersion);

      const expectedUrl = `http://localhost:3000/api/agent/composes/versions?composeId=compose-123&version=${normalVersion}`;
      expect(capturedRequest?.url).toBe(expectedUrl);
    });

    it("should handle 'latest' tag", async () => {
      let capturedRequest: Request | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/composes/versions",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(
              { versionId: "head-version-id", tag: "latest" },
              { status: 200 },
            );
          },
        ),
      );

      await apiClient.getComposeVersion("compose-123", "latest");

      const expectedUrl = `http://localhost:3000/api/agent/composes/versions?composeId=compose-123&version=latest`;
      expect(capturedRequest?.url).toBe(expectedUrl);
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(
        apiClient.getComposeVersion("compose-123", "version-123"),
      ).rejects.toThrow("Not authenticated");
    });

    it("should throw error on version not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Version not found: abc123",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(
        apiClient.getComposeVersion("compose-123", "abc123"),
      ).rejects.toThrow("Version not found: abc123");
    });
  });

  describe("getRealtimeToken", () => {
    it("should call correct endpoint with auth headers", async () => {
      const mockToken = {
        keyName: "test-key",
        timestamp: 1234567890,
        capability: '{"run:run-123":["subscribe"]}',
        nonce: "test-nonce",
        mac: "test-mac",
      };

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/realtime/token",
          async ({ request }) => {
            capturedRequest = request;
            return HttpResponse.json(mockToken, { status: 200 });
          },
        ),
      );

      const result = await apiClient.getRealtimeToken("run-123");

      expect(capturedRequest?.url).toBe(
        "http://localhost:3000/api/realtime/token",
      );
      expect(capturedRequest?.method).toBe("POST");
      expect(capturedRequest?.headers.get("authorization")).toBe(
        "Bearer test-token",
      );

      const body = await capturedRequest?.json();
      expect(body).toEqual({ runId: "run-123" });

      expect(result).toEqual(mockToken);
    });

    it("should return token with all fields", async () => {
      const mockToken = {
        keyName: "ably-key.name",
        timestamp: Date.now(),
        capability: '{"run:test-run":["subscribe"]}',
        nonce: "unique-nonce-123",
        mac: "hmac-signature",
        ttl: 3600000,
        clientId: "client-123",
      };

      server.use(
        http.post("http://localhost:3000/api/realtime/token", () => {
          return HttpResponse.json(mockToken, { status: 200 });
        }),
      );

      const result = await apiClient.getRealtimeToken("test-run");

      expect(result.keyName).toBe("ably-key.name");
      expect(result.nonce).toBe("unique-nonce-123");
      expect(result.mac).toBe("hmac-signature");
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(apiClient.getRealtimeToken("run-123")).rejects.toThrow(
        "Not authenticated",
      );
    });

    it("should throw error when API URL not configured", async () => {
      vi.mocked(config.getApiUrl).mockResolvedValue("");

      await expect(apiClient.getRealtimeToken("run-123")).rejects.toThrow(
        "API URL not configured",
      );
    });

    it("should throw error when run not found", async () => {
      server.use(
        http.post("http://localhost:3000/api/realtime/token", () => {
          return HttpResponse.json(
            { error: { message: "Run not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(apiClient.getRealtimeToken("run-123")).rejects.toThrow(
        "Run not found",
      );
    });

    it("should throw error when user does not own run", async () => {
      server.use(
        http.post("http://localhost:3000/api/realtime/token", () => {
          return HttpResponse.json(
            {
              error: {
                message: "You do not have access to this run",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        }),
      );

      await expect(apiClient.getRealtimeToken("run-123")).rejects.toThrow(
        "You do not have access to this run",
      );
    });

    it("should throw error when realtime service unavailable", async () => {
      server.use(
        http.post("http://localhost:3000/api/realtime/token", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Realtime service unavailable",
                code: "INTERNAL_SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(apiClient.getRealtimeToken("run-123")).rejects.toThrow(
        "Realtime service unavailable",
      );
    });
  });
});
