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

  describe("createOrUpdateConfig", () => {
    it("should call correct endpoint with auth headers", async () => {
      const mockConfig = { version: "1.0", agent: { name: "test" } };
      const mockResponse = {
        configId: "cfg-123",
        name: "test",
        action: "created" as const,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.createOrUpdateConfig({
        config: mockConfig,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/agent/configs",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ config: mockConfig }),
        },
      );

      expect(result).toEqual(mockResponse);
    });

    it("should return created response", async () => {
      const mockResponse = {
        configId: "cfg-123",
        name: "test-agent",
        action: "created" as const,
        createdAt: "2025-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.createOrUpdateConfig({
        config: {},
      });

      expect(result.action).toBe("created");
      expect(result.configId).toBe("cfg-123");
      expect(result.name).toBe("test-agent");
    });

    it("should return updated response", async () => {
      const mockResponse = {
        configId: "cfg-123",
        name: "test-agent",
        action: "updated" as const,
        updatedAt: "2025-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.createOrUpdateConfig({
        config: {},
      });

      expect(result.action).toBe("updated");
    });

    it("should throw error when not authenticated", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(
        apiClient.createOrUpdateConfig({ config: {} }),
      ).rejects.toThrow("Not authenticated");
    });

    it("should throw error when API URL not configured", async () => {
      vi.mocked(config.getApiUrl).mockResolvedValue("");

      await expect(
        apiClient.createOrUpdateConfig({ config: {} }),
      ).rejects.toThrow("API URL not configured");
    });

    it("should throw error on HTTP error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "Invalid config", code: "INVALID_CONFIG" },
        }),
      });

      await expect(
        apiClient.createOrUpdateConfig({ config: {} }),
      ).rejects.toThrow("Invalid config");
    });

    it("should throw default error message when API error has no message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "", code: "ERROR" },
        }),
      });

      await expect(
        apiClient.createOrUpdateConfig({ config: {} }),
      ).rejects.toThrow("Failed to create config");
    });
  });

  describe("createRun", () => {
    it("should call correct endpoint with auth headers", async () => {
      const mockRequest = {
        agentConfigId: "cfg-123",
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
        agentConfigId: "cfg-123",
        prompt: "test prompt",
        templateVars: { key1: "value1", key2: "value2" },
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
        agentConfigId: "cfg-123",
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
        agentConfigId: "cfg-123",
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
          agentConfigId: "cfg-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("Not authenticated");
    });

    it("should throw error when API URL not configured", async () => {
      vi.mocked(config.getApiUrl).mockResolvedValue("");

      await expect(
        apiClient.createRun({
          agentConfigId: "cfg-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("API URL not configured");
    });

    it("should throw error on HTTP error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "Config not found", code: "NOT_FOUND" },
        }),
      });

      await expect(
        apiClient.createRun({
          agentConfigId: "cfg-123",
          prompt: "test",
          artifactName: "my-artifact",
        }),
      ).rejects.toThrow("Config not found");
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
          agentConfigId: "cfg-123",
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
});
