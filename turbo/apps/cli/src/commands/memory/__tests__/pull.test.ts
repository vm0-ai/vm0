/**
 * Tests for memory pull command
 *
 * Covers:
 * - Successful pull with default name ("memory")
 * - Successful pull with custom name
 * - Custom destination directory
 * - Error handling (storage not found, S3 download errors, API errors)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { pullCommand } from "../pull";
import { mkdtempSync, rmSync, existsSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import chalk from "chalk";

describe("memory pull", () => {
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
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-memory-pull-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
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
      for (const file of files) {
        const filePath = path.join(tmpDir, file.name);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.content);
      }

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

  describe("successful pull", () => {
    let defaultTarBuffer: Buffer;

    beforeAll(async () => {
      defaultTarBuffer = await createTarGzBuffer([
        { name: "file.txt", content: "hello" },
      ]);
    });

    it("should pull with default name 'memory'", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/storages/download",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("name")).toBe("memory");
            expect(url.searchParams.get("type")).toBe("memory");
            return HttpResponse.json({
              url: "https://s3.example.com/download",
              versionId: "a1b2c3d4e5f6g7h8",
              fileCount: 1,
              size: 7,
            });
          },
        ),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(defaultTarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Pulling memory: memory"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Successfully pulled memory: memory"),
      );
    });

    it("should pull with custom name", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/storages/download",
          ({ request }) => {
            const url = new URL(request.url);
            expect(url.searchParams.get("name")).toBe("my-memory");
            return HttpResponse.json({
              url: "https://s3.example.com/download",
              versionId: "b2c3d4e5f6g7h8i9",
              fileCount: 1,
              size: 16,
            });
          },
        ),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(defaultTarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli", "my-memory"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Pulling memory: my-memory"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Successfully pulled memory: my-memory"),
      );
    });

    it("should pull to custom destination directory", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "c3d4e5f6g7h8i9j0",
            fileCount: 1,
            size: 5,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(defaultTarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli", "memory", "my-output-dir"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Location: my-output-dir/"),
      );
    });

    it("should display version info after pull", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "abcdef12345678",
            fileCount: 1,
            size: 5,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(defaultTarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Version: abcdef12"),
      );
    });

    it("should extract files to destination directory", async () => {
      const tarBuffer = await createTarGzBuffer([
        { name: "notes.md", content: "# Memory notes" },
        { name: "subdir/data.json", content: '{"key": "value"}' },
      ]);

      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json({
            url: "https://s3.example.com/download",
            versionId: "d4e5f6g7h8i9j0k1",
            fileCount: 2,
            size: 30,
          });
        }),
        http.get("https://s3.example.com/download", () => {
          return new HttpResponse(tarBuffer, {
            headers: { "Content-Type": "application/gzip" },
          });
        }),
      );

      await pullCommand.parseAsync(["node", "cli"]);

      const destDir = path.join(tempDir, "memory");
      expect(existsSync(path.join(destDir, "notes.md"))).toBe(true);
      expect(existsSync(path.join(destDir, "subdir/data.json"))).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should handle storage not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Storage "my-memory" not found',
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli", "my-memory"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("404:"),
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
        expect.stringContaining("500: Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
