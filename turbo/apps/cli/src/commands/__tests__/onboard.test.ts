import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { onboardCommand } from "../onboard.js";

const MOCK_CLI_SKILL_CONTENT = `---
name: vm0-cli
description: VM0 CLI for building and running AI agents in secure sandboxes.
vm0_secrets:
  - VM0_TOKEN
---

# VM0 CLI

Build and run AI agents in secure sandboxed environments.

## When to Use

Use this skill when you need to install and set up the VM0 CLI.
`;

const MOCK_AGENT_SKILL_CONTENT = `---
name: vm0-agent
description: VM0 Agent skill for building workflows.
---

# VM0 Agent

Build AI agent workflows.
`;

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

    // Mock fetch for GitHub skill content only, let MSW handle API calls
    const originalFetch = global.fetch;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("raw.githubusercontent.com")) {
        if (url.includes("vm0-cli")) {
          return {
            ok: true,
            text: () => Promise.resolve(MOCK_CLI_SKILL_CONTENT),
          } as Response;
        }
        if (url.includes("vm0-agent")) {
          return {
            ok: true,
            text: () => Promise.resolve(MOCK_AGENT_SKILL_CONTENT),
          } as Response;
        }
      }
      return originalFetch(input, init);
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
    it("should display welcome box in interactive mode", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Welcome to VM0!");
    });
  });

  describe("progress indicator", () => {
    it("should display progress line with steps", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(logCalls).toContain("Authentication");
      expect(logCalls).toContain("Model Provider Setup");
      expect(logCalls).toContain("Create Agent");
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

  describe("skill installation", () => {
    it("should install both skills in agent directory", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const cliSkillPath = path.join(
        tempDir,
        "my-vm0-agent/.claude/skills/vm0-cli/SKILL.md",
      );
      const agentSkillPath = path.join(
        tempDir,
        "my-vm0-agent/.claude/skills/vm0-agent/SKILL.md",
      );
      expect(existsSync(cliSkillPath)).toBe(true);
      expect(existsSync(agentSkillPath)).toBe(true);
    });

    it("should write correct skill content for both skills", async () => {
      await onboardCommand.parseAsync(["node", "cli", "-y"]);

      const cliSkillPath = path.join(
        tempDir,
        "my-vm0-agent/.claude/skills/vm0-cli/SKILL.md",
      );
      const agentSkillPath = path.join(
        tempDir,
        "my-vm0-agent/.claude/skills/vm0-agent/SKILL.md",
      );

      const cliContent = await readFile(cliSkillPath, "utf-8");
      expect(cliContent).toContain("name: vm0-cli");

      const agentContent = await readFile(agentSkillPath, "utf-8");
      expect(agentContent).toContain("name: vm0-agent");
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
      expect(logCalls).toContain("Installed vm0-cli skill");
      expect(logCalls).toContain("Installed vm0-agent skill");
    });
  });
});
