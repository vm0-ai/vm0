import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statusCommand } from "../status";
import { apiClient } from "../../../lib/api/api-client";

// Mock dependencies
vi.mock("../../../lib/api/api-client");

describe("scope status command", () => {
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

  describe("authentication", () => {
    it("should exit with error if not authenticated", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("Not authenticated"),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("no scope configured", () => {
    it("should show helpful message when user has no scope", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("No scope configured"),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No scope configured"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 scope set"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("scope display", () => {
    it("should display scope information", async () => {
      vi.mocked(apiClient.getScope).mockResolvedValue({
        id: "test-id",
        slug: "testuser",
        type: "personal",
        displayName: "Test User",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Scope Information"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("testuser"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("personal"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Test User"),
      );
    });

    it("should handle scope without display name", async () => {
      vi.mocked(apiClient.getScope).mockResolvedValue({
        id: "test-id",
        slug: "testuser",
        type: "personal",
        displayName: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("testuser"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle unexpected errors", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue(
        new Error("Network error"),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Network error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle non-Error exceptions", async () => {
      vi.mocked(apiClient.getScope).mockRejectedValue("Unknown error");

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
