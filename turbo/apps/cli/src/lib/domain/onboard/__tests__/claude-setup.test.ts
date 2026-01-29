import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  SKILL_DIR,
  SKILL_FILE,
  getSkillContent,
  installClaudeSkill,
} from "../claude-setup.js";

describe("claude-setup", () => {
  const testDir = "/tmp/test-claude-setup";

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("constants", () => {
    it("should have correct SKILL_DIR", () => {
      expect(SKILL_DIR).toBe(".claude/skills/vm0-agent-builder");
    });

    it("should have correct SKILL_FILE", () => {
      expect(SKILL_FILE).toBe("SKILL.md");
    });
  });

  describe("getSkillContent", () => {
    it("should return non-empty content", () => {
      const content = getSkillContent();

      expect(content.length).toBeGreaterThan(0);
    });

    it("should include frontmatter", () => {
      const content = getSkillContent();

      expect(content).toContain("---");
      expect(content).toContain("name: vm0-agent-builder");
    });

    it("should include workflow sections", () => {
      const content = getSkillContent();

      expect(content).toContain("## Workflow");
      expect(content).toContain("Step 1");
      expect(content).toContain("Create AGENTS.md");
    });

    it("should include available skills", () => {
      const content = getSkillContent();

      expect(content).toContain("## Available Skills");
      expect(content).toContain("github");
      expect(content).toContain("slack");
    });

    it("should include example agents", () => {
      const content = getSkillContent();

      expect(content).toContain("## Examples");
      expect(content).toContain("HackerNews Curator");
    });
  });

  describe("installClaudeSkill", () => {
    it("should create skill directory", async () => {
      const result = await installClaudeSkill(testDir);

      expect(existsSync(result.skillDir)).toBe(true);
    });

    it("should create skill file", async () => {
      const result = await installClaudeSkill(testDir);

      expect(existsSync(result.skillFile)).toBe(true);
    });

    it("should return correct paths", async () => {
      const result = await installClaudeSkill(testDir);

      expect(result.skillDir).toBe(path.join(testDir, SKILL_DIR));
      expect(result.skillFile).toBe(path.join(testDir, SKILL_DIR, SKILL_FILE));
    });

    it("should write correct content to file", async () => {
      await installClaudeSkill(testDir);

      const { readFile } = await import("fs/promises");
      const content = await readFile(
        path.join(testDir, SKILL_DIR, SKILL_FILE),
        "utf-8",
      );

      expect(content).toBe(getSkillContent());
    });

    it("should use current directory when no targetDir specified", async () => {
      const originalCwd = process.cwd();
      process.chdir(testDir);

      try {
        const result = await installClaudeSkill();

        expect(result.skillDir).toBe(path.join(testDir, SKILL_DIR));
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
