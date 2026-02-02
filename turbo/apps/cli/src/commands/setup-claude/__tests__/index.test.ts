import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { createMockChildProcessWithOutput } from "../../../mocks/spawn-helpers";
import { setupClaudeCommand } from "../index";

// Mock child_process for Claude CLI commands
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";

describe("setup-claude command", () => {
  let tempDir: string;
  let originalCwd: string;
  const originalExit = process.exit;
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-setup-claude-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Mock process.exit to throw (simulates process termination)
    mockExit = vi.fn().mockImplementation(() => {
      throw new Error("process.exit called");
    });
    process.exit = mockExit as unknown as typeof process.exit;

    // Mock console
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default: all commands succeed, marketplace already installed
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      const argsArray = args as string[];
      if (argsArray.includes("list")) {
        const output = JSON.stringify([
          { name: "vm0-skills", source: "github", repo: "vm0-ai/vm0-skills" },
        ]);
        return createMockChildProcessWithOutput(0, output) as ReturnType<
          typeof spawn
        >;
      }
      return createMockChildProcessWithOutput(0, "Success") as ReturnType<
        typeof spawn
      >;
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe("plugin installation", () => {
    it("should install VM0 plugin with default project scope", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "project"],
        expect.any(Object),
      );
    });

    it("should install with user scope when specified", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli", "--scope", "user"]);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "user"],
        expect.any(Object),
      );
    });

    it("should run in specified agent directory", async () => {
      await setupClaudeCommand.parseAsync([
        "node",
        "cli",
        "--agent-dir",
        "/some/agent/dir",
      ]);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "project"],
        expect.objectContaining({ cwd: "/some/agent/dir" }),
      );
    });

    it("should display success message and next steps", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Installed vm0@vm0-skills"),
      );
      expect(console.log).toHaveBeenCalledWith("Next step:");
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("/vm0-agent"),
      );
    });

    it("should include agent-dir in next steps when provided", async () => {
      await setupClaudeCommand.parseAsync([
        "node",
        "cli",
        "--agent-dir",
        "my-agent",
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("cd my-agent"),
      );
    });
  });

  describe("error handling", () => {
    it("should exit with error when plugin install fails", async () => {
      vi.mocked(spawn).mockImplementation((cmd, args) => {
        const argsArray = args as string[];
        if (argsArray.includes("list")) {
          const output = JSON.stringify([
            { name: "vm0-skills", source: "github", repo: "vm0-ai/vm0-skills" },
          ]);
          return createMockChildProcessWithOutput(0, output) as ReturnType<
            typeof spawn
          >;
        }
        if (argsArray.includes("install")) {
          return createMockChildProcessWithOutput(
            1,
            "",
            "Install failed",
          ) as ReturnType<typeof spawn>;
        }
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      await expect(
        setupClaudeCommand.parseAsync(["node", "cli"]),
      ).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to install"),
      );
    });

    it("should show Claude CLI hint when command fails", async () => {
      // Mock all spawn calls to emit error (Claude CLI not available)
      vi.mocked(spawn).mockImplementation(() => {
        const mockProcess = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
        };
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();

        setImmediate(() => {
          mockProcess.emit("error", new Error("spawn ENOENT"));
        });

        return mockProcess as ReturnType<typeof spawn>;
      });

      await expect(
        setupClaudeCommand.parseAsync(["node", "cli"]),
      ).rejects.toThrow("process.exit called");

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Claude CLI"),
      );
    });
  });

  describe("marketplace management", () => {
    it("should update marketplace when already installed", async () => {
      // Default mock: marketplace is installed
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "marketplace", "update", "vm0-skills"],
        expect.any(Object),
      );
    });

    it("should add marketplace when not installed", async () => {
      vi.mocked(spawn).mockImplementation((cmd, args) => {
        const argsArray = args as string[];
        if (argsArray.includes("list")) {
          // Empty marketplace list
          return createMockChildProcessWithOutput(0, "[]") as ReturnType<
            typeof spawn
          >;
        }
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "marketplace", "add", "vm0-ai/vm0-skills"],
        expect.any(Object),
      );
    });

    it("should continue with install even if marketplace update fails", async () => {
      vi.mocked(spawn).mockImplementation((cmd, args) => {
        const argsArray = args as string[];
        if (argsArray.includes("list")) {
          const output = JSON.stringify([
            { name: "vm0-skills", source: "github", repo: "vm0-ai/vm0-skills" },
          ]);
          return createMockChildProcessWithOutput(0, output) as ReturnType<
            typeof spawn
          >;
        }
        if (argsArray.includes("update")) {
          // Marketplace update fails
          return createMockChildProcessWithOutput(
            1,
            "",
            "Network error",
          ) as ReturnType<typeof spawn>;
        }
        // Plugin install succeeds
        return createMockChildProcessWithOutput(0, "Success") as ReturnType<
          typeof spawn
        >;
      });

      vi.spyOn(console, "warn").mockImplementation(() => {});

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      // Should warn but not fail
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not update marketplace"),
      );
      // Should still install plugin
      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "project"],
        expect.any(Object),
      );
    });
  });
});
