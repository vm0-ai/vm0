/**
 * Tests for volume pull command
 *
 * Covers:
 * - Config validation (no config)
 * - Successful pull scenarios (normal, empty volume, specific version)
 * - Error handling (not found, API errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { pullCommand } from "../pull";
import { mkdtempSync, rmSync, existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import chalk from "chalk";

describe("volume pull", () => {
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-volume-pull-"));
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

  /**
   * Helper to create a tar.gz buffer for mocking S3 response
   */
  async function createTarGzBuffer(
    files: Array<{ name: string; content: string }>,
  ): Promise<Buffer> {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "test-tar-"));
    const tarPath = path.join(tmpDir, "archive.tar.gz");

    try {
      // Create files in temp directory
      for (const file of files) {
        const filePath = path.join(tmpDir, file.name);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.content);
      }

      // Create tar.gz
      await tar.create(
        {
          gzip: true,
          file: tarPath,
          cwd: tmpDir,
        },
        files.map((f) => f.name),
      );

      return await fs.readFile(tarPath);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  describe("config validation", () => {
    it("should fail if no config exists", async () => {
      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli"]);
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

  describe("pull operation", () => {
    beforeEach(async () => {
      // Create volume config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
    });

    it("should show pulling message", async () => {
      const tarBuffer = await createTarGzBuffer([
        { name: "test.txt", content: "hello" },
      ]);

      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "a1b2c3d4e5f6g7h8",
            fileCount: 1,
            size: 5,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(tarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Pulling volume: test-volume"),
      );
    });

    it("should extract files from downloaded archive", async () => {
      const tarBuffer = await createTarGzBuffer([
        { name: "file1.txt", content: "content1" },
        { name: "subdir/file2.txt", content: "content2" },
      ]);

      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "a1b2c3d4e5f6g7h8",
            fileCount: 2,
            size: 16,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(tarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli"]);

      // Verify files were extracted
      expect(existsSync(path.join(tempDir, "file1.txt"))).toBe(true);
      expect(existsSync(path.join(tempDir, "subdir/file2.txt"))).toBe(true);

      const content1 = await fs.readFile(
        path.join(tempDir, "file1.txt"),
        "utf8",
      );
      expect(content1).toBe("content1");
    });

    it("should show extracted files count", async () => {
      const tarBuffer = await createTarGzBuffer([
        { name: "test.txt", content: "hello" },
      ]);

      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "a1b2c3d4e5f6g7h8",
            fileCount: 1,
            size: 5,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(tarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Extracted 1 files"),
      );
    });

    it("should handle empty volume", async () => {
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

      await pullCommand.parseAsync(["node", "cli"]);

      // Empty volume syncs to 0 files
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Synced (0 files)"),
      );
    });

    it("should support version argument", async () => {
      const tarBuffer = await createTarGzBuffer([
        { name: "test.txt", content: "hello" },
      ]);

      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "specific12",
            fileCount: 1,
            size: 5,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(tarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli", "specific12"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("version: specific12"),
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

    it("should fail if volume not found", async () => {
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
        await pullCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail with error when pulling non-existent version", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: `Version "00000000" not found for storage "test-volume"`,
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli", "00000000"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle S3 download errors", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "a1b2c3d4e5f6g7h8",
            fileCount: 1,
            size: 5,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("S3 download failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
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
        await pullCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
