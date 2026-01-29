/**
 * Unit tests for volume command validation and error handling
 *
 * These tests validate volume command behaviors that don't require full E2E testing.
 * They replace E2E tests that tested validation logic through the full stack.
 *
 * Key behaviors tested:
 * - Volume name validation on init command
 * - Pull command error handling for non-existent versions
 *
 * Note: Volume status validation tests are already covered in volume-status.test.ts
 * Note: Storage name validation is already covered in storage-utils.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { initCommand } from "../commands/volume/init";
import { pullCommand } from "../commands/volume/pull";
import { volumeCommand } from "../commands/volume/index";
// Import the actual isValidStorageName function for validation tests
import { isValidStorageName } from "../lib/storage/storage-utils";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("Volume Command", () => {
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-volume-cmd-"));
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

  describe("help text", () => {
    it("volume --help shows command description", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await volumeCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain(
        "Manage volumes (defined in compose, not versioned after run)",
      );
      expect(output).toContain("init");
      expect(output).toContain("push");
      expect(output).toContain("pull");
      expect(output).toContain("status");

      mockStdoutWrite.mockRestore();
    });

    it("volume init --help shows --name option", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await initCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Initialize a volume");
      expect(output).toContain("--name");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("volume name validation", () => {
    it("isValidStorageName rejects uppercase names", () => {
      expect(isValidStorageName("INVALID_NAME")).toBe(false);
    });

    it("isValidStorageName rejects names with underscores", () => {
      expect(isValidStorageName("invalid_name")).toBe(false);
    });

    it("isValidStorageName rejects names shorter than 3 characters", () => {
      expect(isValidStorageName("ab")).toBe(false);
    });

    it("isValidStorageName rejects names with consecutive hyphens", () => {
      expect(isValidStorageName("invalid--name")).toBe(false);
    });

    it("isValidStorageName accepts valid lowercase names with hyphens", () => {
      expect(isValidStorageName("my-volume")).toBe(true);
      expect(isValidStorageName("test-volume-123")).toBe(true);
    });

    it("volume init rejects invalid volume name", async () => {
      // No existing config in temp dir

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "INVALID_NAME"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("volume init shows format requirements on validation error", async () => {
      // Using "ab" which is too short (less than 3 chars) triggers validation error

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("3-64 characters"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("lowercase"),
      );
    });
  });

  describe("volume init", () => {
    it("should show already initialized message for existing volume", async () => {
      // Create existing volume config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: existing-volume\ntype: volume",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-name"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Volume already initialized"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("existing-volume"),
      );
    });

    it("should show already initialized for any existing storage config", async () => {
      // Create existing artifact config - volume init treats any config as "already initialized"
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-artifact\ntype: artifact",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-volume"]);

      // Volume init doesn't distinguish types - it just says "already initialized"
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Volume already initialized"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-artifact"),
      );
    });

    it("should successfully initialize new volume", async () => {
      // No existing config - fresh temp directory

      await initCommand.parseAsync(["node", "cli", "--name", "my-new-volume"]);

      // Verify the config file was created
      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: my-new-volume");
      expect(content).toContain("type: volume");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initialized volume"),
      );
    });
  });

  describe("volume pull config validation", () => {
    it("should fail if no volume initialized", async () => {
      // No .vm0/storage.yaml - fresh temp directory

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

  describe("volume pull - error handling", () => {
    beforeEach(async () => {
      // Create volume config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-volume\ntype: volume",
      );
    });

    it("should fail with error when pulling non-existent version", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          // Return 404 for non-existent version
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
      // The error message contains "not found" from the API response
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show helpful message when version not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: `Version "nonexistent" not found`,
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli", "nonexistent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
