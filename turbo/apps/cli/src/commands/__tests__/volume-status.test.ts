import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { statusCommand } from "../volume/status";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("volume status command", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Setup temp directory
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-volume-status-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("local config validation", () => {
    it("should exit with error if no config exists", async () => {
      // No .vm0/storage.yaml file - just use empty temp directory

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No volume initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if config type is artifact", async () => {
      // Create .vm0/storage.yaml with type: artifact
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-artifact\ntype: artifact",
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as an artifact"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact status"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("remote status check", () => {
    beforeEach(async () => {
      // Create .vm0/storage.yaml with type: volume
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
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
        expect.stringContaining("Checking volume: test-volume"),
      );
    });

    it("should exit with error if remote returns 404", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Storage "test-volume" not found',
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
        expect.stringContaining("vm0 volume push"),
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
    beforeEach(async () => {
      // Create .vm0/storage.yaml with type: volume
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
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
