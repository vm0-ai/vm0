/**
 * Tests for onboard command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, child_process (Claude CLI)
 * - Real (internal): All CLI code, filesystem, config, validators
 *
 * All tests use non-interactive mode (-y flag) per CLI testing guidelines.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.js";

// Mock os.homedir to isolate config files in temp directory
// This is acceptable per CLI testing patterns (similar to auth tests)
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: vi.fn(),
  };
});

// Mock child_process for Claude CLI commands (external third-party tool)
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";
import { onboardCommand } from "../index";

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

describe("onboard command", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalIsTTY: boolean | undefined;
  const originalExit = process.exit;
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock process.exit to throw (simulates process termination)
    mockExit = vi.fn().mockImplementation(() => {
      throw new Error("process.exit called");
    });
    process.exit = mockExit as unknown as typeof process.exit;

    // Mock console
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "clear").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-onboard-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Mock spawn for Claude CLI commands - marketplace already installed
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

    // Mock homedir to return temp directory for config isolation
    vi.mocked(os.homedir).mockReturnValue(tempDir);

    // Save and mock TTY state for interactive mode
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    // Use env vars for auth and API URL (follows project patterns)
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");

    // Default MSW handler for model providers (provider exists)
    server.use(
      http.get("http://localhost:3000/api/model-providers", () => {
        return HttpResponse.json({
          modelProviders: [
            {
              id: "test-provider-id",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        });
      }),
    );

    // Default MSW handlers for auth flow (device code + token exchange)
    server.use(
      http.post("http://localhost:3000/api/cli/auth/device", () => {
        return HttpResponse.json({
          device_code: "test-device-code",
          user_code: "TEST-CODE",
          verification_path: "/cli-auth",
          expires_in: 900,
          interval: 1,
        });
      }),
      http.post("http://localhost:3000/api/cli/auth/token", () => {
        return HttpResponse.json({
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );

    // Default MSW handlers for model provider setup
    server.use(
      http.get("http://localhost:3000/api/model-providers/check/:type", () => {
        return HttpResponse.json({ exists: false });
      }),
      http.put("http://localhost:3000/api/model-providers", () => {
        return HttpResponse.json({
          provider: {
            id: "new-provider-id",
            type: "anthropic-api-key",
            framework: "claude-code",
            credentialName: "ANTHROPIC_API_KEY",
            isDefault: true,
          },
          created: true,
        });
      }),
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit = originalExit;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();

    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe("welcome screen", () => {
    it("should display welcome box in non-interactive mode", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Welcome to VM0!");
    });
  });

  describe("progress indicator", () => {
    it("should display progress line with steps", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Authenticate to vm0.ai");
      expect(logCalls).toContain("Set Up Model Provider");
      expect(logCalls).toContain("Create New Project");
      expect(logCalls).toContain("Install Claude Plugin");
    });
  });

  describe("authentication check", () => {
    it("should proceed when token exists", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      // Should not show auth required message
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Authentication required"),
      );
    });

    it("should show error in non-interactive mode when no token", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      delete process.env.VM0_TOKEN;

      // Set non-interactive mode
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });

      await expect(
        onboardCommand.parseAsync(["node", "cli", "-y"]),
      ).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });
  });

  describe("model provider check", () => {
    it("should proceed when model providers exist", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      // Should not show model provider setup required message
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Model provider setup required"),
      );
    });

    it("should show error in non-interactive mode when no providers", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

      // Set non-interactive mode
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });

      await expect(
        onboardCommand.parseAsync(["node", "cli", "-y"]),
      ).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("No model provider configured"),
      );
    });
  });

  describe("agent directory creation", () => {
    it("should create agent directory with default name", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      expect(existsSync(path.join(tempDir, "my-vm0-agent"))).toBe(true);
    });

    it("should create agent directory with custom name via --name flag", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--name",
        "custom-agent",
      ]);

      expect(existsSync(path.join(tempDir, "custom-agent"))).toBe(true);
    });

    it("should exit with error if directory already exists", async () => {
      const { mkdir } = await import("fs/promises");
      await mkdir(path.join(tempDir, "my-vm0-agent"));

      await expect(
        onboardCommand.parseAsync(["node", "cli", "-y"]),
      ).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("my-vm0-agent/ already exists"),
      );
    });

    it("should exit with error for invalid agent name", async () => {
      await expect(
        onboardCommand.parseAsync([
          "node",
          "cli",
          "-y",
          "--name",
          "ab", // Too short
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
    });
  });

  describe("plugin installation", () => {
    it("should install VM0 plugin with project scope", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      // Verify plugin install was called with project scope
      expect(spawn).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "vm0@vm0-skills", "--scope", "project"],
        expect.any(Object),
      );
    });

    it("should show success message for plugin installation", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Installed vm0@vm0-skills");
    });
  });

  describe("does NOT create vm0.yaml or AGENTS.md", () => {
    it("should not create vm0.yaml in agent directory", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const yamlPath = path.join(tempDir, "my-vm0-agent/vm0.yaml");
      expect(existsSync(yamlPath)).toBe(false);
    });

    it("should not create AGENTS.md in agent directory", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const mdPath = path.join(tempDir, "my-vm0-agent/AGENTS.md");
      expect(existsSync(mdPath)).toBe(false);
    });
  });

  describe("next steps output", () => {
    it("should display next steps after completion", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Next step:");
      expect(logCalls).toContain("cd my-vm0-agent");
      expect(logCalls).toContain("claude");
      expect(logCalls).toContain("/vm0-agent");
      expect(logCalls).toContain("let's build a workflow");
    });

    it("should show custom agent name in next steps", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--name",
        "custom-agent",
      ]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("cd custom-agent");
    });
  });

  describe("--yes flag", () => {
    it("should skip prompts with -y short option", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      expect(existsSync(path.join(tempDir, "my-vm0-agent"))).toBe(true);
    });

    it("should skip prompts with --yes long option", async () => {
      await onboardCommand.parseAsync(["node", "cli", "--yes"]);

      expect(existsSync(path.join(tempDir, "my-vm0-agent"))).toBe(true);
    });
  });

  describe("output messages", () => {
    it("should display success messages for creation", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Created my-vm0-agent/");
      expect(logCalls).toContain("Installed vm0@vm0-skills");
    });
  });
});
