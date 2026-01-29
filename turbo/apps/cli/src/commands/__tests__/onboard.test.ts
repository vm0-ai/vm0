import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onboardCommand } from "../onboard.js";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.js";

// Mock prompts at system boundary (third-party library for user input)
vi.mock("prompts", () => ({
  default: vi.fn(),
}));

// Mock os.homedir at system boundary (Node.js built-in)
// This allows us to use real config files in a temp directory
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: vi.fn(),
  };
});

import prompts from "prompts";

describe("onboard command", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalIsTTY: boolean | undefined;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleClear = vi
    .spyOn(console, "clear")
    .mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockStdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-onboard-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

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

    // Default prompts mock - return values for interactive prompts
    vi.mocked(prompts).mockImplementation(async (questions) => {
      const q = Array.isArray(questions) ? questions[0] : questions;
      if (!q) return {};
      if (q.name === "type") {
        return { type: "anthropic-api-key" };
      }
      if (q.name === "credential" || q.name === "value") {
        return { [q.name]: "sk-test-key" };
      }
      if (q.name === "convert") {
        return { convert: false };
      }
      if (q.name === "value" && q.type === "text") {
        return { value: "my-vm0-agent" };
      }
      if (q.name === "value" && q.type === "confirm") {
        return { value: true };
      }
      return {};
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleClear.mockClear();
    mockConsoleError.mockClear();
    mockStdoutWrite.mockClear();
    vi.unstubAllEnvs();

    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe("welcome screen", () => {
    it("should display welcome box in interactive mode", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Welcome to VM0!");
    });
  });

  describe("progress indicator", () => {
    it("should display progress line with steps", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Authentication");
      expect(logCalls).toContain("Model Provider Setup");
      expect(logCalls).toContain("Create Agent");
    });
  });

  describe("authentication check", () => {
    it("should proceed when token exists", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      // Should not show auth required message
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
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

      await expect(async () => {
        await onboardCommand.parseAsync(["node", "cli", "-y"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });
  });

  describe("model provider check", () => {
    it("should proceed when model providers exist", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      // Should not show model provider setup required message
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
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

      await expect(async () => {
        await onboardCommand.parseAsync(["node", "cli", "-y"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
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

      await expect(async () => {
        await onboardCommand.parseAsync(["node", "cli", "-y"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("my-vm0-agent/ already exists"),
      );
    });

    it("should exit with error for invalid agent name", async () => {
      await expect(async () => {
        await onboardCommand.parseAsync([
          "node",
          "cli",
          "-y",
          "--name",
          "ab", // Too short
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
    });
  });

  describe("skill installation", () => {
    it("should install vm0-agent-builder skill in agent directory", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const skillPath = path.join(
        tempDir,
        "my-vm0-agent/.claude/skills/vm0-agent-builder/SKILL.md",
      );
      expect(existsSync(skillPath)).toBe(true);
    });

    it("should write correct skill content", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const skillPath = path.join(
        tempDir,
        "my-vm0-agent/.claude/skills/vm0-agent-builder/SKILL.md",
      );
      const content = await readFile(skillPath, "utf-8");

      expect(content).toContain("name: vm0-agent-builder");
      expect(content).toContain("## Workflow");
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

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Next step:");
      expect(logCalls).toContain("cd my-vm0-agent");
      expect(logCalls).toContain("claude");
      expect(logCalls).toContain("/vm0-agent-builder");
    });

    it("should show custom agent name in next steps", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--name",
        "custom-agent",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
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

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Created my-vm0-agent/");
      expect(logCalls).toContain("Installed vm0-agent-builder skill");
    });
  });
});
