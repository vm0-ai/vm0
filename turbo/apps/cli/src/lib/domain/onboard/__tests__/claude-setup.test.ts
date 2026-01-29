import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import {
  SKILL_DIR,
  SKILL_FILE,
  SKILL_NAME,
  PRIMARY_SKILL_NAME,
  installVm0Plugin,
  handlePluginError,
} from "../claude-setup.js";

// Mock child_process at module level
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";

// Helper to create a mock child process
function createMockChildProcess(exitCode: number, stdout = "", stderr = "") {
  const mockProcess = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();

  // Emit data and close in next tick to allow event handlers to be set up
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

describe("claude-setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constants", () => {
    it("should have correct SKILL_DIR (legacy)", () => {
      expect(SKILL_DIR).toBe(".claude/skills/vm0-cli");
    });

    it("should have correct SKILL_FILE", () => {
      expect(SKILL_FILE).toBe("SKILL.md");
    });

    it("should have correct SKILL_NAME (legacy)", () => {
      expect(SKILL_NAME).toBe("vm0-cli");
    });

    it("should have correct PRIMARY_SKILL_NAME", () => {
      expect(PRIMARY_SKILL_NAME).toBe("vm0-agent");
    });
  });

  describe("handlePluginError", () => {
    const originalExit = process.exit;
    let mockExit: ReturnType<typeof vi.fn>;
    let mockConsoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockExit = vi.fn();
      process.exit = mockExit as unknown as typeof process.exit;
      mockConsoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
    });

    afterEach(() => {
      process.exit = originalExit;
    });

    it("should log error message with default context", () => {
      handlePluginError(new Error("test"));
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Claude plugin"),
      );
    });

    it("should log error message with custom context", () => {
      const context = "vm0 plugin";
      handlePluginError(new Error("test"), context);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(context),
      );
    });

    it("should log error message when error is Error instance", () => {
      handlePluginError(new Error("Installation failed"));
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Installation failed"),
      );
    });

    it("should log Claude CLI hint", () => {
      handlePluginError(new Error("test"));
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Claude CLI"),
      );
    });

    it("should exit with code 1", () => {
      handlePluginError(new Error("test"));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle non-Error objects", () => {
      handlePluginError("string error");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("installVm0Plugin", () => {
    beforeEach(() => {
      // Default: all commands succeed, marketplace already installed
      vi.mocked(spawn).mockImplementation((cmd, args) => {
        const argsArray = args as string[];
        if (argsArray.includes("list")) {
          const output = JSON.stringify([
            { name: "vm0-skills", source: "github", repo: "vm0-ai/vm0-skills" },
          ]);
          return createMockChildProcess(0, output) as ReturnType<typeof spawn>;
        }
        return createMockChildProcess(0, "Success") as ReturnType<typeof spawn>;
      });
    });

    it("should install plugin with user scope", async () => {
      const result = await installVm0Plugin("user");

      expect(result.pluginId).toBe("vm0@vm0-skills");
      expect(result.scope).toBe("user");
      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "user"],
        expect.any(Object),
      );
    });

    it("should install plugin with project scope", async () => {
      const result = await installVm0Plugin("project", "/some/dir");

      expect(result.pluginId).toBe("vm0@vm0-skills");
      expect(result.scope).toBe("project");
      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "project"],
        expect.objectContaining({ cwd: "/some/dir" }),
      );
    });

    it("should throw error when plugin install fails", async () => {
      vi.mocked(spawn).mockImplementation((cmd, args) => {
        const argsArray = args as string[];
        if (argsArray.includes("list")) {
          const output = JSON.stringify([
            { name: "vm0-skills", source: "github", repo: "vm0-ai/vm0-skills" },
          ]);
          return createMockChildProcess(0, output) as ReturnType<typeof spawn>;
        }
        if (argsArray.includes("install")) {
          return createMockChildProcess(1, "", "Install failed") as ReturnType<
            typeof spawn
          >;
        }
        return createMockChildProcess(0, "Success") as ReturnType<typeof spawn>;
      });

      await expect(installVm0Plugin("user")).rejects.toThrow(
        "Failed to install plugin",
      );
    });

    it("should handle spawn error event", async () => {
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

      // When list fails, isMarketplaceInstalled returns false
      // Then addMarketplace is called, which also fails
      await expect(installVm0Plugin("user")).rejects.toThrow(
        "Failed to add marketplace",
      );
    });
  });
});
