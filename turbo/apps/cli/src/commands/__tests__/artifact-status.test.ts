import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statusCommand } from "../artifact/status";
import * as storageUtils from "../../lib/storage-utils";
import { apiClient } from "../../lib/api-client";

// Mock dependencies
vi.mock("../../lib/storage-utils");
vi.mock("../../lib/api-client");

describe("artifact status command", () => {
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

  describe("local config validation", () => {
    it("should exit with error if no config exists", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No artifact initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if config type is volume", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "test-volume",
        type: "volume",
      });

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as a volume"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume status"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("remote status check", () => {
    beforeEach(() => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "test-artifact",
        type: "artifact",
      });
    });

    it("should show start message", async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4",
            fileCount: 100,
            size: 1024000,
          }),
      } as Response);

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Checking artifact: test-artifact"),
      );
    });

    it("should exit with error if remote returns 404", async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({
            error: { message: "Storage not found" },
          }),
      } as Response);

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not found on remote"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact push"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should display version info when remote exists", async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4",
            fileCount: 100,
            size: 1024000,
          }),
      } as Response);

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Found"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Version: a1b2c3d4"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Files: 100"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Size:"),
      );
    });

    it("should display empty indicator for empty storage", async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4",
            fileCount: 0,
            size: 0,
            empty: true,
          }),
      } as Response);

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Found (empty)"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Version: a1b2c3d4"),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "test-artifact",
        type: "artifact",
      });
    });

    it("should handle API errors", async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve({
            error: { message: "Internal server error" },
          }),
      } as Response);

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Status check failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle network errors", async () => {
      vi.mocked(apiClient.get).mockRejectedValue(new Error("Network error"));

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Status check failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Network error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
