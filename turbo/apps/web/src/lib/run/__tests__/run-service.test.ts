/**
 * Pure function tests for run-service.
 *
 * Service method tests (checkConcurrencyLimit, buildExecutionContext) are tested
 * at the route level in apps/web/app/v1/runs/__tests__/route.test.ts
 */
import { describe, test, expect } from "vitest";
import { calculateSessionHistoryPath } from "../run-service";

describe("run-service", () => {
  describe("calculateSessionHistoryPath", () => {
    test("handles simple workspace path", () => {
      const result = calculateSessionHistoryPath("/workspace", "session-123");
      expect(result).toBe(
        "/home/user/.claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("handles nested path", () => {
      const result = calculateSessionHistoryPath(
        "/home/user/projects/myapp",
        "session-456",
      );
      expect(result).toBe(
        "/home/user/.claude/projects/-home-user-projects-myapp/session-456.jsonl",
      );
    });

    test("handles path with multiple leading slashes", () => {
      const result = calculateSessionHistoryPath("/test/path", "abc");
      expect(result).toBe("/home/user/.claude/projects/-test-path/abc.jsonl");
    });

    test("handles single directory path", () => {
      const result = calculateSessionHistoryPath("/myproject", "xyz");
      expect(result).toBe("/home/user/.claude/projects/-myproject/xyz.jsonl");
    });

    test("preserves session ID exactly", () => {
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const result = calculateSessionHistoryPath("/workspace", sessionId);
      expect(result).toContain(sessionId);
    });

    test("returns claude-code path by default", () => {
      const result = calculateSessionHistoryPath("/workspace", "session-123");
      expect(result).toBe(
        "/home/user/.claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("returns claude-code path when agent type is claude-code", () => {
      const result = calculateSessionHistoryPath(
        "/workspace",
        "session-123",
        "claude-code",
      );
      expect(result).toBe(
        "/home/user/.claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("returns codex path when agent type is codex", () => {
      const result = calculateSessionHistoryPath(
        "/workspace",
        "thread-abc123",
        "codex",
      );
      expect(result).toBe("/home/user/.codex/sessions/thread-abc123.jsonl");
    });

    test("codex path ignores working directory", () => {
      const result1 = calculateSessionHistoryPath(
        "/workspace",
        "thread-123",
        "codex",
      );
      const result2 = calculateSessionHistoryPath(
        "/home/user/projects/myapp",
        "thread-123",
        "codex",
      );
      expect(result1).toBe(result2);
      expect(result1).toBe("/home/user/.codex/sessions/thread-123.jsonl");
    });
  });
});
