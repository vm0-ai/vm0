import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCommand } from "../run";
import { apiClient } from "../../lib/api-client";

// Mock dependencies
vi.mock("../../lib/api-client");

describe("run command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("configId validation", () => {
    it("should accept valid UUID format", async () => {
      const validUuid = "550e8400-e29b-41d4-a716-446655440000";
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync(["node", "cli", validUuid, "test prompt"]);

      expect(apiClient.createRun).toHaveBeenCalled();
    });

    it("should accept configId starting with cfg-", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(apiClient.createRun).toHaveBeenCalled();
    });

    it("should reject invalid configId format", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "invalid-id",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid config ID format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("environment variables", () => {
    beforeEach(() => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });
    });

    it("should parse single environment variable", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        "cfg-123",
        "test prompt",
        "-e",
        "KEY1=value1",
      ]);

      expect(apiClient.createRun).toHaveBeenCalledWith({
        agentConfigId: "cfg-123",
        prompt: "test prompt",
        dynamicVars: { KEY1: "value1" },
      });
    });

    it("should parse multiple environment variables", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        "cfg-123",
        "test prompt",
        "-e",
        "KEY1=value1",
        "-e",
        "KEY2=value2",
      ]);

      expect(apiClient.createRun).toHaveBeenCalledWith({
        agentConfigId: "cfg-123",
        prompt: "test prompt",
        dynamicVars: { KEY1: "value1", KEY2: "value2" },
      });
    });

    it("should handle values containing equals signs", async () => {
      await runCommand.parseAsync([
        "node",
        "cli",
        "cfg-123",
        "test prompt",
        "-e",
        "URL=https://example.com?foo=bar",
      ]);

      expect(apiClient.createRun).toHaveBeenCalledWith({
        agentConfigId: "cfg-123",
        prompt: "test prompt",
        dynamicVars: { URL: "https://example.com?foo=bar" },
      });
    });

    it("should reject empty environment variable values", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "cfg-123",
          "test prompt",
          "-e",
          "EMPTY=",
        ]);
      }).rejects.toThrow("Invalid env var format: EMPTY=");
    });

    it("should reject invalid environment variable format (missing value)", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "cfg-123",
          "test prompt",
          "-e",
          "INVALID",
        ]);
      }).rejects.toThrow();
    });

    it("should reject invalid environment variable format (missing key)", async () => {
      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "cfg-123",
          "test prompt",
          "-e",
          "=value",
        ]);
      }).rejects.toThrow();
    });

    it("should omit dynamicVars when no env vars provided", async () => {
      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(apiClient.createRun).toHaveBeenCalledWith({
        agentConfigId: "cfg-123",
        prompt: "test prompt",
        dynamicVars: undefined,
      });
    });
  });

  describe("API interaction", () => {
    it("should display starting messages", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Creating agent run"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Config: cfg-123"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Prompt: test prompt"),
      );
    });

    it("should display env vars when provided", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync([
        "node",
        "cli",
        "cfg-123",
        "test prompt",
        "-e",
        "KEY=value",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Variables:"),
      );
    });

    it("should display completion message", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Run completed: run-123"),
      );
    });

    it("should display output when present", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Test output from agent",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(mockConsoleLog).toHaveBeenCalledWith("Output:");
      expect(mockConsoleLog).toHaveBeenCalledWith("Test output from agent");
    });

    it("should display error when present", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "failed",
        sandboxId: "sbx-456",
        output: "",
        error: "Execution failed due to error",
        executionTimeMs: 1000,
        createdAt: "2025-01-01T00:00:00Z",
      });

      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Error:"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        "Execution failed due to error",
      );
    });

    it("should display execution time", async () => {
      vi.mocked(apiClient.createRun).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        sandboxId: "sbx-456",
        output: "Success",
        executionTimeMs: 5432,
        createdAt: "2025-01-01T00:00:00Z",
      });

      // Mock Date.now to control duration calculation
      const originalNow = Date.now;
      let callCount = 0;
      vi.spyOn(Date, "now").mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 0 : 5432; // Start at 0, end at 5432
      });

      await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Execution time: 5s"),
      );

      Date.now = originalNow;
    });
  });

  describe("error handling", () => {
    it("should handle authentication errors", async () => {
      vi.mocked(apiClient.createRun).mockRejectedValue(
        new Error("Not authenticated"),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle config not found errors", async () => {
      vi.mocked(apiClient.createRun).mockRejectedValue(
        new Error("Config not found"),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Config not found: cfg-123"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API errors with message", async () => {
      vi.mocked(apiClient.createRun).mockRejectedValue(
        new Error("Execution failed"),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      vi.mocked(apiClient.createRun).mockRejectedValue("Non-error object");

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", "cfg-123", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
