import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { setupClaudeCommand } from "../setup-claude";

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

    // Mock fetch at system boundary - handle both skill URLs
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes("vm0-cli")) {
        return {
          ok: true,
          text: () => Promise.resolve(MOCK_CLI_SKILL_CONTENT),
        } as Response;
      }
      if (urlStr.includes("vm0-agent")) {
        return {
          ok: true,
          text: () => Promise.resolve(MOCK_AGENT_SKILL_CONTENT),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as Response;
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe("skill installation", () => {
    it("should create skill directories for both skills", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(existsSync(path.join(tempDir, ".claude/skills/vm0-cli"))).toBe(
        true,
      );
      expect(existsSync(path.join(tempDir, ".claude/skills/vm0-agent"))).toBe(
        true,
      );
    });

    it("should create SKILL.md with fetched content for both skills", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const cliSkillPath = path.join(
        tempDir,
        ".claude/skills/vm0-cli/SKILL.md",
      );
      const agentSkillPath = path.join(
        tempDir,
        ".claude/skills/vm0-agent/SKILL.md",
      );

      expect(existsSync(cliSkillPath)).toBe(true);
      expect(existsSync(agentSkillPath)).toBe(true);

      const cliContent = await fs.readFile(cliSkillPath, "utf8");
      expect(cliContent).toContain("name: vm0-cli");

      const agentContent = await fs.readFile(agentSkillPath, "utf8");
      expect(agentContent).toContain("name: vm0-agent");
    });

    it("should overwrite existing files (idempotent)", async () => {
      // Create existing skill directory with old content
      await fs.mkdir(path.join(tempDir, ".claude/skills/vm0-cli"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tempDir, ".claude/skills/vm0-cli/SKILL.md"),
        "old content",
      );

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const content = await fs.readFile(
        path.join(tempDir, ".claude/skills/vm0-cli/SKILL.md"),
        "utf8",
      );
      expect(content).toContain("# VM0 CLI");
      expect(content).not.toContain("old content");
    });

    it("should display success message and next steps", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Installed vm0-cli skill"),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Installed vm0-agent skill"),
      );
      expect(console.log).toHaveBeenCalledWith("Next step:");
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("/vm0-agent"),
      );
    });

    it("should fetch skill content from GitHub for both skills", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-cli/SKILL.md",
      );
      expect(global.fetch).toHaveBeenCalledWith(
        "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-agent/SKILL.md",
      );
    });
  });

  describe("error handling", () => {
    it("should exit with error when fetch fails", async () => {
      vi.spyOn(global, "fetch").mockRejectedValueOnce(
        new Error("Network error"),
      );

      await expect(
        setupClaudeCommand.parseAsync(["node", "cli"]),
      ).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch skill from GitHub"),
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Network error"),
      );
    });
  });
});
