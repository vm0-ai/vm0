/**
 * Tests for memory init command
 *
 * Covers:
 * - Name validation (format rules)
 * - Existing config handling (memory vs volume vs artifact)
 * - Successful initialization
 *
 * Memory init opts out of the storage-utils memory→artifact normalisation so
 * legacy dirs it wrote itself are still recognised as memory. Normalisation
 * on the artifact read path is exercised in storage-utils.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../init";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("memory init", () => {
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

    // Setup temp directory
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-memory-init-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("name validation", () => {
    it("should reject uppercase names", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "INVALID_NAME"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid memory name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names with underscores", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "invalid_name"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid memory name"),
      );
    });

    it("should reject names shorter than 3 characters", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid memory name"),
      );
    });

    it("should reject names longer than 64 characters", async () => {
      const longName = "a".repeat(65);
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", longName]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid memory name"),
      );
    });

    it("should show format requirements on validation error", async () => {
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

  describe("existing config", () => {
    it("should show already initialized message for existing memory", async () => {
      // `memory init` opts out of the memory→artifact normalisation so it can
      // still recognise dirs it previously wrote itself.
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: existing-memory\ntype: memory",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-name"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Memory already initialized"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("existing-memory"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should warn if directory is initialized as volume", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-volume\ntype: volume",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-memory"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("initialized as volume"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("delete .vm0/storage.yaml"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should warn if directory is initialized as artifact", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-artifact\ntype: artifact",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-memory"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("initialized as artifact"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should show config file path for existing config", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: existing\ntype: memory",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-name"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Config file:"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(".vm0/storage.yaml"),
      );
    });
  });

  describe("successful initialization", () => {
    it("should create config file with correct content", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-memory"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");

      expect(content).toContain("name: my-memory");
      expect(content).toContain("type: memory");
    });

    it("should show success message", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-memory"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initialized memory"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-memory"),
      );
    });

    it("should show config file location", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-memory"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Config saved to"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining(".vm0/storage.yaml"),
      );
    });

    it("should accept valid names with hyphens", async () => {
      await initCommand.parseAsync([
        "node",
        "cli",
        "--name",
        "my-agent-memory-2024",
      ]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: my-agent-memory-2024");
    });

    it("should work with -n short option", async () => {
      await initCommand.parseAsync(["node", "cli", "-n", "short-name"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: short-name");
    });
  });
});
