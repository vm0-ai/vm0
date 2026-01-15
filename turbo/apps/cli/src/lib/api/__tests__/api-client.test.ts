import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiClient } from "../api-client";
import * as config from "../config";

// Mock the config module
vi.mock("../config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

describe("ApiClient", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    global.fetch = originalFetch;
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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.createOrUpdateCompose({
        content: mockConfig,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: mockConfig }),
        },
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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

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
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "Invalid compose", code: "INVALID_COMPOSE" },
        }),
      });

      await expect(
        apiClient.createOrUpdateCompose({
          content: { version: "1", agents: { main: { provider: "claude" } } },
        }),
      ).rejects.toThrow("Invalid compose");
    });

    it("should throw default error message when API error has no message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "", code: "ERROR" },
        }),
      });

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
        status: "completed" as const,
        sandboxId: "sbx-789",
        output: "test output",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.createRun(mockRequest);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(mockRequest),
        },
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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          runId: "run-456",
          status: "completed",
          sandboxId: "sbx-789",
          output: "output",
          executionTimeMs: 1000,
          createdAt: "2025-01-01T00:00:00Z",
        }),
      });

      await apiClient.createRun(mockRequest);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(mockRequest),
        }),
      );
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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

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
        sandboxId: "sbx-789",
        output: "",
        error: "Execution failed",
        executionTimeMs: 2000,
        createdAt: "2025-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

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
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "Compose not found", code: "NOT_FOUND" },
        }),
      });

      await expect(
        apiClient.createRun({
          agentComposeId: "cmp-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("Compose not found");
    });

    it("should throw default error message when API error has no message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "", code: "ERROR" },
        }),
      });

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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.getEvents("run-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/runs/run-123/events?since=0&limit=100",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
        },
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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.getEvents("run-123", { since: 4 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/runs/run-123/events?since=4&limit=100",
        expect.any(Object),
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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      await apiClient.getEvents("run-123", { limit: 50 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/runs/run-123/events?since=0&limit=50",
        expect.any(Object),
      );
    });

    it("should support both since and limit parameters", async () => {
      const mockResponse = {
        events: [],
        hasMore: true,
        nextSequence: 150,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.getEvents("run-123", {
        since: 100,
        limit: 50,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/runs/run-123/events?since=100&limit=50",
        expect.any(Object),
      );

      expect(result.hasMore).toBe(true);
      expect(result.nextSequence).toBe(150);
    });

    it("should return events with all fields", async () => {
      const mockResponse = {
        events: [
          {
            sequenceNumber: 1,
            eventType: "init",
            eventData: { sessionId: "session-123" },
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            sequenceNumber: 2,
            eventType: "text",
            eventData: { text: "Processing..." },
            createdAt: "2025-01-01T00:00:01Z",
          },
        ],
        hasMore: false,
        nextSequence: 2,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.getEvents("run-123");

      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({
        sequenceNumber: 1,
        eventType: "init",
        eventData: { sessionId: "session-123" },
        createdAt: "2025-01-01T00:00:00Z",
      });
      expect(result.events[1]).toEqual({
        sequenceNumber: 2,
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
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "Run not found", code: "NOT_FOUND" },
        }),
      });

      await expect(apiClient.getEvents("run-123")).rejects.toThrow(
        "Run not found",
      );
    });

    it("should throw default error message when API error has no message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "", code: "ERROR" },
        }),
      });

      await expect(apiClient.getEvents("run-123")).rejects.toThrow(
        "Failed to fetch events",
      );
    });
  });

  describe("getComposeVersion", () => {
    it("should quote version parameter to prevent scientific notation parsing", async () => {
      // Version strings like "52999e37" look like scientific notation to JSON.parse
      // They must be quoted as JSON strings so the server receives the correct value
      const scientificNotationVersion = "52999e37";

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ versionId: "full-hash-123" }),
      });

      await apiClient.getComposeVersion(
        "compose-123",
        scientificNotationVersion,
      );

      // Verify the version is quoted (becomes "52999e37" with quotes)
      const expectedUrl = `http://localhost:3000/api/agent/composes/versions?composeId=compose-123&version=${encodeURIComponent(JSON.stringify(scientificNotationVersion))}`;
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
    });

    it("should also quote normal hex versions for consistency", async () => {
      const normalVersion = "a1b2c3d4";

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ versionId: "full-hash-456" }),
      });

      await apiClient.getComposeVersion("compose-123", normalVersion);

      const expectedUrl = `http://localhost:3000/api/agent/composes/versions?composeId=compose-123&version=${encodeURIComponent(JSON.stringify(normalVersion))}`;
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
    });

    it("should quote 'latest' tag", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ versionId: "head-version-id", tag: "latest" }),
      });

      await apiClient.getComposeVersion("compose-123", "latest");

      const expectedUrl = `http://localhost:3000/api/agent/composes/versions?composeId=compose-123&version=${encodeURIComponent(JSON.stringify("latest"))}`;
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(
        apiClient.getComposeVersion("compose-123", "version-123"),
      ).rejects.toThrow("Not authenticated");
    });

    it("should throw error on version not found", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "Version not found: abc123", code: "NOT_FOUND" },
        }),
      });

      await expect(
        apiClient.getComposeVersion("compose-123", "abc123"),
      ).rejects.toThrow("Version not found: abc123");
    });
  });
});
