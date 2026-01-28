import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupClaudeCommand } from "../setup-claude";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("setup-claude command", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

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
  });

  describe("skill installation", () => {
    it("should create .claude/skills/vm0-agent-builder directory", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(
        existsSync(path.join(tempDir, ".claude/skills/vm0-agent-builder")),
      ).toBe(true);
    });

    it("should create SKILL.md with embedded content", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const skillPath = path.join(
        tempDir,
        ".claude/skills/vm0-agent-builder/SKILL.md",
      );
      expect(existsSync(skillPath)).toBe(true);

      const content = await fs.readFile(skillPath, "utf8");
      expect(content).toContain("name: vm0-agent-builder");
      expect(content).toContain("# VM0 Agent Builder");
      expect(content).toContain("## When to Use");
      expect(content).toContain("## Workflow");
    });

    it("should overwrite existing files (idempotent)", async () => {
      // Create existing skill directory with old content
      await fs.mkdir(path.join(tempDir, ".claude/skills/vm0-agent-builder"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tempDir, ".claude/skills/vm0-agent-builder/SKILL.md"),
        "old content",
      );

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const content = await fs.readFile(
        path.join(tempDir, ".claude/skills/vm0-agent-builder/SKILL.md"),
        "utf8",
      );
      expect(content).toContain("# VM0 Agent Builder");
      expect(content).not.toContain("old content");
    });

    it("should display success message and next steps", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Installed vm0-agent-builder skill"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("Next step:");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("/vm0-agent-builder"),
      );
    });
  });
});
