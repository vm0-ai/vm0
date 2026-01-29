/**
 * Tests for volume push command
 *
 * Covers:
 * - Config validation (no config)
 * - Successful push scenarios (normal, deduplicated, empty)
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { pushCommand } from "../push";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("volume push", () => {
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
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Setup temp directory
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-volume-push-"));
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

  describe("config validation", () => {
    it("should fail if no config exists", async () => {
      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No volume initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("push operation", () => {
    beforeEach(async () => {
      // Create volume config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
    });

    it("should show pushing message", async () => {
      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
          return HttpResponse.json({
            versionId: "a1b2c3d4e5f6g7h8",
            existing: true,
          });
        }),
        http.post("http://localhost:3000/api/storages/commit", () => {
          return HttpResponse.json({
            success: true,
            versionId: "a1b2c3d4e5f6g7h8",
            storageName: "test-volume",
            size: 0,
            fileCount: 0,
            deduplicated: true,
          });
        }),
      );

      await pushCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Pushing volume: test-volume"),
      );
    });

    it("should show deduplicated message when content unchanged", async () => {
      // Create a file so the volume is not empty
      await fs.writeFile(path.join(tempDir, "test-file.txt"), "test content");

      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
          return HttpResponse.json({
            versionId: "a1b2c3d4e5f6g7h8",
            existing: true,
          });
        }),
        http.post("http://localhost:3000/api/storages/commit", () => {
          return HttpResponse.json({
            success: true,
            versionId: "a1b2c3d4e5f6g7h8",
            storageName: "test-volume",
            size: 12,
            fileCount: 1,
            deduplicated: true,
          });
        }),
      );

      await pushCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Content unchanged"),
      );
    });

    it("should show version info after push", async () => {
      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
          return HttpResponse.json({
            versionId: "a1b2c3d4e5f6g7h8",
            existing: true,
          });
        }),
        http.post("http://localhost:3000/api/storages/commit", () => {
          return HttpResponse.json({
            success: true,
            versionId: "a1b2c3d4e5f6g7h8",
            storageName: "test-volume",
            size: 0,
            fileCount: 0,
            deduplicated: true,
          });
        }),
      );

      await pushCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Version: a1b2c3d4"),
      );
    });

    it("should show empty volume message when no files", async () => {
      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
          return HttpResponse.json({
            versionId: "a1b2c3d4e5f6g7h8",
            existing: true,
          });
        }),
        http.post("http://localhost:3000/api/storages/commit", () => {
          return HttpResponse.json({
            success: true,
            versionId: "a1b2c3d4e5f6g7h8",
            storageName: "test-volume",
            size: 0,
            fileCount: 0,
            deduplicated: true,
          });
        }),
      );

      await pushCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No files found"),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
    });

    it("should handle API errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
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
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Push failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("options", () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
    });

    it("should accept --force option", async () => {
      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
          return HttpResponse.json({
            versionId: "a1b2c3d4e5f6g7h8",
            existing: true,
          });
        }),
        http.post("http://localhost:3000/api/storages/commit", () => {
          return HttpResponse.json({
            success: true,
            versionId: "a1b2c3d4e5f6g7h8",
            storageName: "test-volume",
            size: 0,
            fileCount: 0,
            deduplicated: true,
          });
        }),
      );

      // Should not throw
      await pushCommand.parseAsync(["node", "cli", "--force"]);
    });

    it("should accept -f short option", async () => {
      server.use(
        http.post("http://localhost:3000/api/storages/prepare", () => {
          return HttpResponse.json({
            versionId: "a1b2c3d4e5f6g7h8",
            existing: true,
          });
        }),
        http.post("http://localhost:3000/api/storages/commit", () => {
          return HttpResponse.json({
            success: true,
            versionId: "a1b2c3d4e5f6g7h8",
            storageName: "test-volume",
            size: 0,
            fileCount: 0,
            deduplicated: true,
          });
        }),
      );

      // Should not throw
      await pushCommand.parseAsync(["node", "cli", "-f"]);
    });
  });
});
