import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseArgs, createSessionHistory } from "../scripts/mock-claude";

describe("mock-claude", () => {
  describe("parseArgs", () => {
    it("should return default values for empty args", () => {
      const result = parseArgs([]);
      expect(result).toEqual({
        outputFormat: "text",
        print: false,
        verbose: false,
        dangerouslySkipPermissions: false,
        resume: null,
        prompt: "",
      });
    });

    it("should parse --output-format option", () => {
      const result = parseArgs(["--output-format", "stream-json"]);
      expect(result.outputFormat).toBe("stream-json");
    });

    it("should parse --print flag", () => {
      const result = parseArgs(["--print"]);
      expect(result.print).toBe(true);
    });

    it("should parse --verbose flag", () => {
      const result = parseArgs(["--verbose"]);
      expect(result.verbose).toBe(true);
    });

    it("should parse --dangerously-skip-permissions flag", () => {
      const result = parseArgs(["--dangerously-skip-permissions"]);
      expect(result.dangerouslySkipPermissions).toBe(true);
    });

    it("should parse --resume option", () => {
      const result = parseArgs(["--resume", "session-123"]);
      expect(result.resume).toBe("session-123");
    });

    it("should parse prompt from remaining args", () => {
      const result = parseArgs(["echo hello"]);
      expect(result.prompt).toBe("echo hello");
    });

    it("should parse all options together", () => {
      const result = parseArgs([
        "--output-format",
        "stream-json",
        "--print",
        "--verbose",
        "--dangerously-skip-permissions",
        "--resume",
        "session-abc",
        "ls -la",
      ]);
      expect(result).toEqual({
        outputFormat: "stream-json",
        print: true,
        verbose: true,
        dangerouslySkipPermissions: true,
        resume: "session-abc",
        prompt: "ls -la",
      });
    });

    it("should handle options in any order", () => {
      const result = parseArgs([
        "--print",
        "--output-format",
        "stream-json",
        "my prompt",
        "--verbose",
      ]);
      expect(result.outputFormat).toBe("stream-json");
      expect(result.print).toBe(true);
      // Note: --verbose after prompt is still parsed
      expect(result.verbose).toBe(true);
      expect(result.prompt).toBe("my prompt");
    });

    it("should ignore --output-format without value", () => {
      const result = parseArgs(["--output-format"]);
      // When --output-format is at end without value, it stays default
      expect(result.outputFormat).toBe("text");
    });

    it("should ignore --resume without value", () => {
      const result = parseArgs(["--resume"]);
      expect(result.resume).toBe(null);
    });

    it("should only use first remaining arg as prompt", () => {
      const result = parseArgs(["first", "second", "third"]);
      expect(result.prompt).toBe("first");
    });
  });

  describe("createSessionHistory", () => {
    let tempDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-test-"));
      originalHome = process.env.HOME;
      process.env.HOME = tempDir;
    });

    afterEach(() => {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should create session history file path with correct structure", () => {
      const sessionId = "test-session-123";
      const cwd = "/workspaces/my-project";

      const result = createSessionHistory(sessionId, cwd);

      expect(result).toBe(
        `${tempDir}/.claude/projects/-workspaces-my-project/${sessionId}.jsonl`,
      );
    });

    it("should create the directory structure", () => {
      const sessionId = "test-session";
      const cwd = "/some/path";

      createSessionHistory(sessionId, cwd);

      const expectedDir = `${tempDir}/.claude/projects/-some-path`;
      expect(fs.existsSync(expectedDir)).toBe(true);
    });

    it("should handle root directory", () => {
      const sessionId = "root-session";
      const cwd = "/";

      const result = createSessionHistory(sessionId, cwd);

      // "/" becomes "" after removing leading /
      expect(result).toBe(`${tempDir}/.claude/projects/-/${sessionId}.jsonl`);
    });

    it("should handle deeply nested paths", () => {
      const sessionId = "deep-session";
      const cwd = "/a/b/c/d/e/f";

      const result = createSessionHistory(sessionId, cwd);

      expect(result).toBe(
        `${tempDir}/.claude/projects/-a-b-c-d-e-f/${sessionId}.jsonl`,
      );
    });

    it("should use /home/user as fallback when HOME is not set", () => {
      // Set HOME to a temp directory to test fallback behavior
      // without actually trying to write to /home/user
      const fallbackDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fallback-test-"),
      );
      process.env.HOME = fallbackDir;

      try {
        const sessionId = "fallback-session";
        const cwd = "/test";

        const result = createSessionHistory(sessionId, cwd);

        expect(result).toBe(
          `${fallbackDir}/.claude/projects/-test/${sessionId}.jsonl`,
        );
      } finally {
        fs.rmSync(fallbackDir, { recursive: true, force: true });
      }
    });
  });
});
