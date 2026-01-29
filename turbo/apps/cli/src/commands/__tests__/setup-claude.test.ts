import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { setupClaudeCommand } from "../setup-claude";

const MOCK_SKILL_CONTENT = `---
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

    // Mock fetch at system boundary
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MOCK_SKILL_CONTENT),
    } as Response);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  describe("skill installation", () => {
    it("should create .claude/skills/vm0-cli directory", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(existsSync(path.join(tempDir, ".claude/skills/vm0-cli"))).toBe(
        true,
      );
    });

    it("should create SKILL.md with fetched content", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const skillPath = path.join(tempDir, ".claude/skills/vm0-cli/SKILL.md");
      expect(existsSync(skillPath)).toBe(true);

      const content = await fs.readFile(skillPath, "utf8");
      expect(content).toContain("name: vm0-cli");
      expect(content).toContain("# VM0 CLI");
      expect(content).toContain("## When to Use");
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
      expect(console.log).toHaveBeenCalledWith("Next step:");
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("/vm0-cli"),
      );
    });

    it("should fetch skill content from GitHub", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-cli/SKILL.md",
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
