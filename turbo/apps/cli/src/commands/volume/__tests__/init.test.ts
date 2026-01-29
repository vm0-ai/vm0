/**
 * Tests for volume init command
 *
 * Covers:
 * - Name validation (format rules)
 * - Existing config handling
 * - Successful initialization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../init";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("volume init", () => {
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

    // Setup temp directory
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-volume-init-"));
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
        expect.stringContaining("Invalid volume name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names with underscores", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "invalid_name"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
      );
    });

    it("should reject names shorter than 3 characters", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
      );
    });

    it("should reject names with consecutive hyphens", async () => {
      await expect(async () => {
        await initCommand.parseAsync([
          "node",
          "cli",
          "--name",
          "invalid--name",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
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

    it("should show example valid names on error", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "X"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("my-dataset"),
      );
    });
  });

  describe("existing config", () => {
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
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should show already initialized for any existing storage config", async () => {
      // Create existing artifact config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-artifact\ntype: artifact",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-volume"]);

      // Volume init treats any config as "already initialized"
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Volume already initialized"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-artifact"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should show config file path for existing config", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: existing\ntype: volume",
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
      await initCommand.parseAsync(["node", "cli", "--name", "my-volume"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");

      expect(content).toContain("name: my-volume");
      expect(content).toContain("type: volume");
    });

    it("should show success message", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-volume"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initialized volume"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-volume"),
      );
    });

    it("should show config file location", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-volume"]);

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
        "my-super-volume-2024",
      ]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: my-super-volume-2024");
    });

    it("should accept valid names with numbers", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "volume123"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: volume123");
    });

    it("should work with -n short option", async () => {
      await initCommand.parseAsync(["node", "cli", "-n", "short-name"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: short-name");
    });
  });
});
