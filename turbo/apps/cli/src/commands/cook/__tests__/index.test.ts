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
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import {
  createMockChildProcess,
  createMockChildProcessWithOutput,
} from "../../../mocks/spawn-helpers";

// Mock child_process for pnpm/vm0 CLI commands (external tools)
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";
import { cookCommand } from "../index";

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

    // Default npm registry handler - return same version to skip upgrade
    // This prevents checkAndUpgrade from attempting real upgrades
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Mock spawn for pnpm/vm0 commands (external tools)
    // All commands succeed quickly so tests don't timeout
    vi.mocked(spawn).mockImplementation(() => {
      return createMockChildProcessWithOutput(0, "Success") as ReturnType<
        typeof spawn
      >;
    });

    // Ensure clean config state
    const configDir = path.join(testHome, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
    // Clean up state file from default location (tmpdir/.vm0/cook.json)
    const defaultStateFile = path.join(os.tmpdir(), ".vm0", "cook.json");
    try {
      await fs.unlink(defaultStateFile);
    } catch {
      // File may not exist
    }
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

  describe("state persistence", () => {
    // Note: cook-state.ts computes CONFIG_DIR at module load time using homedir().
    // Since homedir() returns os.tmpdir() at module load, we write state files there.
    // We use a unique PPID in each test to avoid conflicts between tests.

    async function writeStateToDefaultLocation(
      ppid: string,
      state: {
        lastRunId?: string;
        lastSessionId?: string;
        lastCheckpointId?: string;
      },
    ): Promise<void> {
      // cook-state uses tmpdir()/.vm0/cook.json (since homedir mock returns tmpdir at load time)
      const configDir = path.join(os.tmpdir(), ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      const stateFile = path.join(configDir, "cook.json");

      // Read existing state to preserve other PPID entries
      let existingState: { ppid: Record<string, unknown> } = { ppid: {} };
      try {
        const content = await fs.readFile(stateFile, "utf8");
        existingState = JSON.parse(content);
      } catch {
        // File doesn't exist, use empty state
      }

      existingState.ppid[ppid] = {
        ...state,
        lastActiveAt: Date.now(),
      };

      await fs.writeFile(stateFile, JSON.stringify(existingState));
    }

    it("should load state for logs subcommand when previous run exists", async () => {
      const ppid = String(process.ppid);
      await writeStateToDefaultLocation(ppid, {
        lastRunId: "run-123-saved",
        lastSessionId: "session-456-saved",
        lastCheckpointId: "checkpoint-789-saved",
      });

      // Mock spawn to return success for logs command
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Logs output") as ReturnType<
          typeof spawn
        >;
      });

      // logs subcommand should use the saved run ID
      await cookCommand.parseAsync(["node", "cli", "logs"]);

      // Verify spawn was called with the saved run ID
      expect(spawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(["logs", "run-123-saved"]),
        expect.anything(),
      );
    });

    it("should load state for continue subcommand when previous session exists", async () => {
      const ppid = String(process.ppid);
      await writeStateToDefaultLocation(ppid, {
        lastRunId: "run-123",
        lastSessionId: "session-456-saved",
        lastCheckpointId: "checkpoint-789",
      });

      // Create minimal vm0.yaml for continue command
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    working_dir: /workspace
`,
      );

      // Mock spawn to return success
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(
          0,
          "Run ID: run-new\nSession ID: session-new",
        ) as ReturnType<typeof spawn>;
      });

      // continue subcommand should use the saved session ID
      await cookCommand.parseAsync([
        "node",
        "cli",
        "continue",
        "next prompt",
        "--no-auto-update",
      ]);

      // Verify spawn was called with session continuation args
      const spawnCalls = vi.mocked(spawn).mock.calls;
      const runCall = spawnCalls.find(
        (call) => Array.isArray(call[1]) && call[1].includes("run"),
      );
      expect(runCall).toBeDefined();
      expect(runCall![1]).toContain("continue");
      expect(runCall![1]).toContain("session-456-saved");
    });

    it("should load state for resume subcommand when previous checkpoint exists", async () => {
      const ppid = String(process.ppid);
      await writeStateToDefaultLocation(ppid, {
        lastRunId: "run-123",
        lastSessionId: "session-456",
        lastCheckpointId: "checkpoint-789-saved",
      });

      // Create minimal vm0.yaml for resume command
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    working_dir: /workspace
`,
      );

      // Mock spawn to return success
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(
          0,
          "Run ID: run-new\nCheckpoint ID: checkpoint-new",
        ) as ReturnType<typeof spawn>;
      });

      // resume subcommand should use the saved checkpoint ID
      await cookCommand.parseAsync([
        "node",
        "cli",
        "resume",
        "next prompt",
        "--no-auto-update",
      ]);

      // Verify spawn was called with checkpoint continuation args
      const spawnCalls = vi.mocked(spawn).mock.calls;
      const runCall = spawnCalls.find(
        (call) => Array.isArray(call[1]) && call[1].includes("run"),
      );
      expect(runCall).toBeDefined();
      expect(runCall![1]).toContain("resume");
      expect(runCall![1]).toContain("checkpoint-789-saved");
    });

    it("should isolate state by PPID (different terminal sessions)", async () => {
      // Write state for a different PPID
      await writeStateToDefaultLocation("99999", {
        lastRunId: "run-other-terminal",
        lastSessionId: "session-other-terminal",
        lastCheckpointId: "checkpoint-other-terminal",
      });

      // Current process should not see state from different PPID
      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", "logs"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No previous run found"),
      );
    });

    it("should migrate old format cook.json to new PPID-based format", async () => {
      // Create old format cook.json (without ppid field)
      const configDir = path.join(os.tmpdir(), ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      const stateFile = path.join(configDir, "cook.json");
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          lastRunId: "run-old-format",
          lastSessionId: "session-old-format",
          lastCheckpointId: "checkpoint-old-format",
        }),
      );

      // Mock spawn to return success for logs command
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Logs output") as ReturnType<
          typeof spawn
        >;
      });

      // logs subcommand should migrate and use the old run ID
      await cookCommand.parseAsync(["node", "cli", "logs"]);

      // Verify spawn was called with the migrated run ID
      expect(spawn).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(["logs", "run-old-format"]),
        expect.anything(),
      );
    });
  });

  describe("interactive auto-upgrade before cook", () => {
    const originalArgv = process.argv;

    beforeEach(async () => {
      // Set npm path by default
      process.argv = ["/usr/bin/node", "/usr/local/bin/vm0"];

      // Create valid vm0.yaml
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it("should call spawn with npm install when upgrade available", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(
        () => createMockChildProcess(0) as never,
      );

      // checkAndUpgrade returns true when upgrade happens, causing process.exit
      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(spawn).toHaveBeenCalledWith(
        "npm",
        ["install", "-g", "@vm0/cli@latest"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    });

    it("should call spawn with pnpm add when installed via pnpm", async () => {
      process.argv = [
        "/usr/bin/node",
        "/home/user/.local/share/pnpm/global/5/node_modules/.bin/vm0",
      ];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(
        () => createMockChildProcess(0) as never,
      );

      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      expect(spawn).toHaveBeenCalledWith(
        "pnpm",
        ["add", "-g", "@vm0/cli@latest"],
        expect.objectContaining({ stdio: "inherit" }),
      );
    });

    it("should show manual instructions when upgrade fails", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      // Mock spawn to return exit code 1 (failure)
      vi.mocked(spawn).mockImplementation(
        () => createMockChildProcess(1) as never,
      );

      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", "test prompt"]);
      }).rejects.toThrow("process.exit called");

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      // Should show upgrade failed message
      expect(allLogs.some((log) => log.includes("Upgrade failed"))).toBe(true);
      // Should show manual command
      expect(
        allLogs.some((log) => log.includes("npm install -g @vm0/cli@latest")),
      ).toBe(true);
      // Should show re-run command
      expect(allLogs.some((log) => log.includes("vm0 cook"))).toBe(true);
    });

    it("should escape special characters in rerun command", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(
        () => createMockChildProcess(0) as never,
      );

      await expect(async () => {
        await cookCommand.parseAsync(["node", "cli", 'say "hello"']);
      }).rejects.toThrow("process.exit called");

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      // Should show escaped rerun command
      expect(
        allLogs.some((log) => log.includes('vm0 cook "say \\"hello\\""')),
      ).toBe(true);
    });

    it("should show manual instructions for bun without spawning", async () => {
      process.argv = ["/usr/bin/node", "/home/user/.bun/bin/vm0"];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      // With bun, cook should continue (no process.exit from upgrade)
      await cookCommand.parseAsync(["node", "cli", "test prompt"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      // Should show unsupported message
      expect(
        allLogs.some((log) =>
          log.includes("Auto-upgrade is not supported for bun"),
        ),
      ).toBe(true);
      // Should show manual command
      expect(
        allLogs.some((log) => log.includes("bun add -g @vm0/cli@latest")),
      ).toBe(true);
      // spawn should only be called for the actual cook run, not for upgrade
      const upgradeCalls = vi
        .mocked(spawn)
        .mock.calls.filter(
          (call) =>
            Array.isArray(call[1]) &&
            (call[1].includes("install") || call[1].includes("add")),
        );
      expect(upgradeCalls.length).toBe(0);
    });

    it("should show manual instructions for yarn without spawning", async () => {
      process.argv = ["/usr/bin/node", "/home/user/.yarn/bin/vm0"];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      await cookCommand.parseAsync(["node", "cli", "test prompt"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      expect(
        allLogs.some((log) =>
          log.includes("Auto-upgrade is not supported for yarn"),
        ),
      ).toBe(true);
      expect(
        allLogs.some((log) => log.includes("yarn global add @vm0/cli@latest")),
      ).toBe(true);
    });

    it("should show fallback npm command for unknown package manager", async () => {
      process.argv = ["/usr/bin/node", "/some/random/path/vm0"];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      await cookCommand.parseAsync(["node", "cli", "test prompt"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      expect(
        allLogs.some((log) =>
          log.includes("Could not detect your package manager"),
        ),
      ).toBe(true);
      // Should show npm as fallback
      expect(
        allLogs.some((log) => log.includes("npm install -g @vm0/cli@latest")),
      ).toBe(true);
    });

    it("should warn and continue when version check fails", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.error();
        }),
      );
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      // Should continue cooking (not exit)
      await cookCommand.parseAsync(["node", "cli", "test prompt"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      expect(
        allLogs.some((log) =>
          log.includes("Warning: Could not check for updates"),
        ),
      ).toBe(true);
    });

    it("should not show upgrade message when already on latest version", async () => {
      // Default handler returns "0.0.0-test" which matches CLI_VERSION
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      await cookCommand.parseAsync(["node", "cli", "test prompt"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      // Should not show beta notice or upgrade messages
      expect(
        allLogs.some((log) => log.includes("vm0 is currently in beta")),
      ).toBe(false);
      expect(allLogs.some((log) => log.includes("Upgrading via"))).toBe(false);
    });

    it("should skip upgrade check with --no-auto-update flag", async () => {
      // Use a version that would trigger upgrade if checked
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );
      vi.mocked(spawn).mockImplementation(() => {
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      // Cook will proceed with the run (skipping upgrade check)
      await cookCommand.parseAsync([
        "node",
        "cli",
        "test prompt",
        "--no-auto-update",
      ]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      // Should not show upgrade messages (beta notice appears when upgrade is available)
      expect(
        allLogs.some((log) => log.includes("vm0 is currently in beta")),
      ).toBe(false);
      expect(allLogs.some((log) => log.includes("Upgrading via"))).toBe(false);
    });
  });
});
