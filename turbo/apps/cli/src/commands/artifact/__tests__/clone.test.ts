/**
 * Tests for artifact clone command
 *
 * Covers:
 * - Argument validation (name required)
 * - Destination directory handling
 * - Error handling (not found, auth, existing directory)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { cloneCommand } from "../clone";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("artifact clone", () => {
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-artifact-clone-"));
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

  describe("argument handling", () => {
    it("should require name argument", async () => {
      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow();
    });

    it("should use artifact name as default destination", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      await cloneCommand.parseAsync(["node", "cli", "my-artifact"]);

      // Should create directory with artifact name
      expect(existsSync(path.join(tempDir, "my-artifact"))).toBe(true);
    });

    it("should use custom destination when provided", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      await cloneCommand.parseAsync([
        "node",
        "cli",
        "my-artifact",
        "custom-dir",
      ]);

      // Should create directory with custom name
      expect(existsSync(path.join(tempDir, "custom-dir"))).toBe(true);
    });
  });

  describe("successful clone", () => {
    it("should show cloning message", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      await cloneCommand.parseAsync(["node", "cli", "my-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Cloning artifact: my-artifact"),
      );
    });

    it("should show success message", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4e5f6g7h8",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      await cloneCommand.parseAsync(["node", "cli", "my-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Successfully cloned artifact"),
      );
    });

    it("should show version info", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4e5f6g7h8",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      await cloneCommand.parseAsync(["node", "cli", "my-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Version: a1b2c3d4"),
      );
    });

    it("should show location info", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      await cloneCommand.parseAsync(["node", "cli", "my-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Location: my-artifact/"),
      );
    });
  });

  describe("error handling", () => {
    it("should fail if artifact not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Storage "nonexistent" not found',
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli", "nonexistent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Clone failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail if destination is not empty", async () => {
      // Create existing directory with a file inside
      const existingDir = path.join(tempDir, "existing-dir");
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(path.join(existingDir, "file.txt"), "content");

      await expect(async () => {
        await cloneCommand.parseAsync([
          "node",
          "cli",
          "my-artifact",
          "existing-dir",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Clone failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("is not empty"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should succeed if destination is empty directory", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            empty: true,
            versionId: "a1b2c3d4",
            fileCount: 0,
            size: 0,
          });
        }),
      );

      // Create empty directory
      const emptyDir = path.join(tempDir, "empty-dir");
      mkdirSync(emptyDir, { recursive: true });

      await cloneCommand.parseAsync([
        "node",
        "cli",
        "my-artifact",
        "empty-dir",
      ]);

      // Should succeed
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Successfully cloned artifact"),
      );
    });

    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await cloneCommand.parseAsync(["node", "cli", "my-artifact"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Clone failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
