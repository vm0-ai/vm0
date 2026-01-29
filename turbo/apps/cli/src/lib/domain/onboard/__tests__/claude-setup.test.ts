import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  SKILL_DIR,
  SKILL_FILE,
  SKILL_NAME,
  SKILL_URL,
  fetchSkillContent,
  installClaudeSkill,
  handleFetchError,
} from "../claude-setup.js";

const MOCK_SKILL_CONTENT = `---
name: vm0-cli
description: VM0 CLI for building and running AI agents in secure sandboxes.
vm0_secrets:
  - VM0_TOKEN
---

# VM0 CLI

Build and run AI agents in secure sandboxed environments.

## When to Use

Use this skill when you need to:
- Install and set up the VM0 CLI
- Run agents with prompts and inputs
`;

describe("claude-setup", () => {
  const testDir = "/tmp/test-claude-setup";

  beforeEach(async () => {
    vi.clearAllMocks();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("constants", () => {
    it("should have correct SKILL_DIR", () => {
      expect(SKILL_DIR).toBe(".claude/skills/vm0-cli");
    });

    it("should have correct SKILL_FILE", () => {
      expect(SKILL_FILE).toBe("SKILL.md");
    });

    it("should have correct SKILL_NAME", () => {
      expect(SKILL_NAME).toBe("vm0-cli");
    });

    it("should have correct SKILL_URL", () => {
      expect(SKILL_URL).toBe(
        "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-cli/SKILL.md",
      );
    });
  });

  describe("fetchSkillContent", () => {
    it("should fetch content from GitHub", async () => {
      const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(MOCK_SKILL_CONTENT),
      } as Response);

      const content = await fetchSkillContent();

      expect(content).toBe(MOCK_SKILL_CONTENT);
      expect(mockFetch).toHaveBeenCalledWith(SKILL_URL);
    });

    it("should throw error on fetch failure", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as Response);

      await expect(fetchSkillContent()).rejects.toThrow(
        `Failed to fetch skill from ${SKILL_URL}: 404 Not Found`,
      );
    });

    it("should throw error on network failure", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network error"));

      await expect(fetchSkillContent()).rejects.toThrow("Network error");
    });
  });

  describe("handleFetchError", () => {
    const originalExit = process.exit;
    let mockExit: ReturnType<typeof vi.fn>;
    let mockConsoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockExit = vi.fn();
      process.exit = mockExit as unknown as typeof process.exit;
      mockConsoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
    });

    afterEach(() => {
      process.exit = originalExit;
    });

    it("should log error message with URL", () => {
      handleFetchError(new Error("test"));
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(SKILL_URL),
      );
    });

    it("should log error message when error is Error instance", () => {
      handleFetchError(new Error("Network failed"));
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Network failed"),
      );
    });

    it("should log network connection hint", () => {
      handleFetchError(new Error("test"));
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("network connection"),
      );
    });

    it("should exit with code 1", () => {
      handleFetchError(new Error("test"));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle non-Error objects", () => {
      handleFetchError("string error");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("installClaudeSkill", () => {
    beforeEach(() => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(MOCK_SKILL_CONTENT),
      } as Response);
    });

    it("should create skill directory", async () => {
      const result = await installClaudeSkill(testDir);

      expect(existsSync(result.skillDir)).toBe(true);
      expect(result.skillDir).toBe(path.join(testDir, SKILL_DIR));
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

    it("should write fetched content to file", async () => {
      await installClaudeSkill(testDir);

      const content = await readFile(
        path.join(testDir, SKILL_DIR, SKILL_FILE),
        "utf-8",
      );

      expect(content).toBe(MOCK_SKILL_CONTENT);
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

    it("should propagate fetch errors", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      await expect(installClaudeSkill(testDir)).rejects.toThrow(
        "Failed to fetch skill",
      );
    });
  });
});
