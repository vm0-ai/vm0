import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onboardCommand } from "../onboard";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";

// Only mock authenticate - it opens a browser which is impossible to test
vi.mock("../../lib/api/auth", () => ({
  authenticate: vi.fn().mockResolvedValue(undefined),
}));

import { authenticate } from "../../lib/api/auth";

describe("onboard command", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-onboard-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Use env vars for auth and API URL (follows project patterns)
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");

    // Default MSW handler for model providers
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
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
      expect(authenticate).not.toHaveBeenCalled();
    });

    it("should trigger authentication when no token exists", async () => {
      vi.stubEnv("VM0_TOKEN", "");

      await onboardCommand.parseAsync([
        "node",
        "cli",
        "-y",
        "--method",
        "manual",
      ]);

      expect(authenticate).toHaveBeenCalled();
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

    it("should show warning when no model providers configured", async () => {
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
        expect.stringContaining("No model provider configured"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 model-provider setup"),
      );
    });

    it("should continue even if model provider check fails", async () => {
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
        expect.stringContaining("Could not check model provider status"),
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
