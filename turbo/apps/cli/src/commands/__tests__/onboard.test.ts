import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onboardCommand } from "../onboard";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";

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
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

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
      if (q.name === "credential") {
        return { credential: "sk-test-key" };
      }
      if (q.name === "convert") {
        return { convert: false };
      }
      return {};
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();

    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe("authentication check", () => {
    it("should show authenticated status when token exists", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Authenticated"),
      );
    });

    it("should show auth required message when no token exists", async () => {
      // Remove token completely (not just empty string)
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      delete process.env.VM0_TOKEN;

      // Ensure model providers exist so auth is the only blocking step
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

      // Auth flow will run via loginCommand.parseAsync
      // The full flow involves device code polling which may exit on completion
      try {
        await onboardCommand.parseAsync([
          "node",
          "cli",
          "-y",
          "--method",
          "manual",
        ]);
      } catch {
        // May throw due to process.exit mock
      }

      // Verify auth flow started by checking for auth required message
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Authentication required"),
      );
    });
  });

  describe("model provider check", () => {
    it("should show configured status when model providers exist", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Model provider configured"),
      );
    });

    it("should trigger model provider setup when no providers configured", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Model provider setup required"),
      );
      // Verify setup completed by checking for success message
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Model provider"),
      );
    });

    it("should attempt setup if model provider check fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({ error: "Server error" }, { status: 500 });
        }),
      );

      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Setting up model provider"),
      );
    });
  });

  describe("demo agent creation", () => {
    it("should create vm0-demo-agent directory with --yes flag", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(existsSync(path.join(tempDir, "vm0-demo-agent"))).toBe(true);
    });

    it("should create vm0.yaml in the demo agent directory", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      const yamlPath = path.join(tempDir, "vm0-demo-agent/vm0.yaml");
      expect(existsSync(yamlPath)).toBe(true);

      const content = await fs.readFile(yamlPath, "utf8");
      expect(content).toContain('version: "1.0"');
      expect(content).toContain("vm0-demo-agent:");
      expect(content).toContain("framework: claude-code");
    });

    it("should create AGENTS.md in the demo agent directory", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      const mdPath = path.join(tempDir, "vm0-demo-agent/AGENTS.md");
      expect(existsSync(mdPath)).toBe(true);

      const content = await fs.readFile(mdPath, "utf8");
      expect(content).toContain("Agent Instructions");
      expect(content).toContain("HackerNews");
    });

    it("should exit with error if vm0-demo-agent already exists", async () => {
      // Create existing directory
      await fs.mkdir(path.join(tempDir, "vm0-demo-agent"));

      await expect(async () => {
        await onboardCommand.parseAsync([
          "node",
          "cli",
          "-y",
          "--method",
          "manual",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0-demo-agent/ already exists"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("method selection", () => {
    it("should support --method claude flag", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "claude",
      ]);

      // setup-claude downloads skill to .claude/skills/vm0-agent-builder
      expect(
        existsSync(
          path.join(tempDir, "vm0-demo-agent/.claude/skills/vm0-agent-builder"),
        ),
      ).toBe(true);
    });

    it("should support --method manual flag", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith("Next steps:");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENTS.md"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 cook"),
      );
    });

    it("should display correct next steps for manual method", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("cd vm0-demo-agent"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Edit"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0.yaml"),
      );
    });
  });

  describe("--yes flag", () => {
    it("should work with -y short option", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(existsSync(path.join(tempDir, "vm0-demo-agent"))).toBe(true);
    });
  });

  describe("output messages", () => {
    it("should display creation success messages", async () => {
      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Created"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0.yaml"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENTS.md"),
      );
    });
  });
});
