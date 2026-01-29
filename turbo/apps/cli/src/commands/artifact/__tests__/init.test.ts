/**
 * Tests for artifact init command
 *
 * Covers:
 * - Name validation (format rules)
 * - Existing config handling (artifact vs volume)
 * - Successful initialization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../init";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("artifact init", () => {
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-artifact-init-"));
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
        expect.stringContaining("Invalid artifact name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names with underscores", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "invalid_name"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid artifact name"),
      );
    });

    it("should reject names shorter than 3 characters", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid artifact name"),
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
        expect.stringContaining("Invalid artifact name"),
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
        expect.stringContaining("my-project"),
      );
    });
  });

  describe("existing config", () => {
    it("should show already initialized message for existing artifact", async () => {
      // Create existing artifact config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: existing-artifact\ntype: artifact",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-name"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Artifact already initialized"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("existing-artifact"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should warn if directory is initialized as volume", async () => {
      // Create existing volume config
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-volume\ntype: volume",
      );

      await initCommand.parseAsync(["node", "cli", "--name", "new-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("initialized as volume"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("delete .vm0/storage.yaml"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should show config file path for existing config", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: existing\ntype: artifact",
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
      await initCommand.parseAsync(["node", "cli", "--name", "my-artifact"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");

      expect(content).toContain("name: my-artifact");
      expect(content).toContain("type: artifact");
    });

    it("should show success message", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-artifact"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initialized artifact"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-artifact"),
      );
    });

    it("should show config file location", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-artifact"]);

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
        "my-super-artifact-2024",
      ]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: my-super-artifact-2024");
    });

    it("should accept valid names with numbers", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "artifact123"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: artifact123");
    });

    it("should work with -n short option", async () => {
      await initCommand.parseAsync(["node", "cli", "-n", "short-name"]);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = await fs.readFile(configPath, "utf8");
      expect(content).toContain("name: short-name");
    });
  });
});
