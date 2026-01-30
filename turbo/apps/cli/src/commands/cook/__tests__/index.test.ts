/**
 * Tests for cook command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, child_process (pnpm/vm0 CLI)
 * - Real (internal): All CLI code, filesystem, config, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

// Mock child_process for pnpm/vm0 CLI commands (external tools)
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// Mock update-checker to skip upgrade checks in tests (external npm registry)
vi.mock("../../../lib/utils/update-checker", () => ({
  checkAndUpgrade: vi.fn().mockResolvedValue(false),
}));

import { spawn } from "child_process";
import { cookCommand } from "../index";

// Helper to create a mock child process
function createMockChildProcess(exitCode: number, stdout = "", stderr = "") {
  const mockProcess = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();

  setImmediate(() => {
    if (stdout) {
      mockProcess.stdout.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      mockProcess.stderr.emit("data", Buffer.from(stderr));
    }
    mockProcess.emit("close", exitCode);
  });

  return mockProcess;
}

// Mock os.homedir to isolate config files in temp directory
// This is acceptable per CLI testing patterns (similar to auth tests)
// Note: Must return a valid path initially for module-level homedir() calls
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: vi.fn(() => original.tmpdir()),
  };
});

describe("cook command", () => {
  let tempDir: string;
  let testHome: string;
  let originalCwd: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-cook-"));
    testHome = mkdtempSync(path.join(os.tmpdir(), "test-cook-home-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Mock homedir to return test home directory
    vi.mocked(os.homedir).mockReturnValue(testHome);

    // Mock spawn for pnpm/vm0 commands (external tools)
    // All commands succeed quickly so tests don't timeout
    vi.mocked(spawn).mockImplementation(() => {
      return createMockChildProcess(0, "Success") as ReturnType<typeof spawn>;
    });

    // Ensure clean config state
    const configDir = path.join(testHome, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("config file validation", () => {
    it("should exit with error when vm0.yaml is missing", async () => {
      // No vm0.yaml file exists
      expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(false);

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "test prompt",
          "--no-auto-update",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Config file not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error on invalid YAML", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        "invalid: yaml: content:",
      );

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "test prompt",
          "--no-auto-update",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid YAML"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error on invalid compose (missing agents)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\n# no agents defined`,
      );

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "test prompt",
          "--no-auto-update",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing agents"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error on invalid agent name", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  ab:\n    framework: claude-code\n    working_dir: /`,
      );

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "test prompt",
          "--no-auto-update",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("environment variable validation", () => {
    it("should exit with error when required variables are missing", async () => {
      // Use a unique timestamp to ensure variable doesn't exist in env
      const uniqueVar = `COOK_TEST_VAR_${Date.now()}`;

      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    working_dir: /workspace
    environment:
      MY_VAR: "\${{ vars.${uniqueVar} }}"
`,
      );

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "test prompt",
          "--no-auto-update",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required variables"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(uniqueVar),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error when --env-file does not exist", async () => {
      // Use a unique timestamp to ensure variable doesn't exist in env
      const uniqueVar = `COOK_TEST_VAR_${Date.now()}`;

      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    working_dir: /workspace
    environment:
      MY_VAR: "\${{ vars.${uniqueVar} }}"
`,
      );

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "test prompt",
          "--env-file",
          "nonexistent.env",
          "--no-auto-update",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Environment file not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("logs subcommand", () => {
    it("should exit with error when no previous run exists", async () => {
      // No cook.json file exists (no prior run)

      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", "logs"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No previous run found"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 cook"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("continue subcommand", () => {
    it("should exit with error when no previous session exists", async () => {
      // No cook.json file exists (no prior session)

      await expect(async () => {
        await cookCommand.parseAsync([
          "node",
          "cli",
          "continue",
          "next prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No previous session found"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 cook"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("resume subcommand", () => {
    it("should exit with error when no previous checkpoint exists", async () => {
      // No cook.json file exists (no prior checkpoint)

      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", "resume", "next prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No previous checkpoint found"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 cook"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
