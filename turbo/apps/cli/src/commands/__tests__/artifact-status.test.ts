import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { statusCommand } from "../artifact/status";
import * as storageUtils from "../../lib/storage/storage-utils";
import * as config from "../../lib/api/config";

// Mock dependencies
vi.mock("../../lib/storage/storage-utils");
vi.mock("../../lib/api/config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

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
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");
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
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4",
            url: "https://example.com/download",
            fileCount: 100,
            size: 1024000,
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Checking artifact: test-artifact"),
      );
    });

    it("should exit with error if remote returns 404", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Storage "test-artifact" not found',
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

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
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4",
            url: "https://example.com/download",
            fileCount: 100,
            size: 1024000,
          });
        }),
      );

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
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4",
            empty: true,
            fileCount: 0,
            size: 0,
          });
        }),
      );

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
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Status check failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle network errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            { error: { message: "Network error", code: "SERVER_ERROR" } },
            { status: 500 },
          );
        }),
      );

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
