import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

// Mock fetchSkillContent before importing the command
vi.mock("../../lib/domain/onboard/index.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/domain/onboard/index.js")>();
  return {
    ...original,
    fetchSkillContent: vi.fn().mockResolvedValue(`---
name: vm0-cli
description: VM0 CLI for building and running AI agents in secure sandboxes.
vm0_secrets:
  - VM0_TOKEN
---

# VM0 CLI

Build and run AI agents in secure sandboxed environments.

## When to Use

Use this skill when you need to install and set up the VM0 CLI.
`),
  };
});

import { setupClaudeCommand } from "../setup-claude";
import { fetchSkillContent } from "../../lib/domain/onboard/index.js";

describe("setup-claude command", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-setup-claude-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
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

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Installed vm0-cli skill"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("Next step:");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("/vm0-cli"),
      );
    });

    it("should fetch skill content from GitHub", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(fetchSkillContent).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should exit with error when fetch fails", async () => {
      vi.mocked(fetchSkillContent).mockRejectedValueOnce(
        new Error("Network error"),
      );

      await expect(
        setupClaudeCommand.parseAsync(["node", "cli"]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch skill from GitHub"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Network error"),
      );
    });
  });
});
