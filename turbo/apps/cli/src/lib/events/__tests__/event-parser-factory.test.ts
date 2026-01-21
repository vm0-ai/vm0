import { describe, test, expect } from "vitest";
import { getEventParser, parseEvent } from "../event-parser-factory";
import { ClaudeEventParser } from "../claude-event-parser";
import { CodexEventParser } from "../codex-event-parser";

describe("event-parser-factory", () => {
  describe("getEventParser", () => {
    test("returns ClaudeEventParser for claude-code provider", () => {
      const parser = getEventParser("claude-code");
      expect(parser).toBe(ClaudeEventParser);
    });

    test("returns CodexEventParser for codex provider", () => {
      const parser = getEventParser("codex");
      expect(parser).toBe(CodexEventParser);
    });
  });

  describe("parseEvent with invalid framework", () => {
    test("throws for unknown framework", () => {
      const rawEvent = { type: "system", subtype: "init" };
      expect(() => parseEvent(rawEvent, "unknown")).toThrow(
        'Unsupported framework "unknown"',
      );
    });
  });

  describe("parseEvent auto-detection", () => {
    test("auto-detects Claude Code from system event", () => {
      const rawEvent = {
        type: "system",
        subtype: "init",
        session_id: "test-session",
        model: "claude-3-5-sonnet",
        tools: [],
      };

      const parsed = parseEvent(rawEvent);
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("init");
      expect(parsed?.data.sessionId).toBe("test-session");
    });

    test("auto-detects Claude Code from assistant event", () => {
      const rawEvent = {
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      };

      const parsed = parseEvent(rawEvent);
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("text");
    });

    test("auto-detects Codex from thread.started event", () => {
      const rawEvent = {
        type: "thread.started",
        thread_id: "codex-thread-123",
      };

      const parsed = parseEvent(rawEvent);
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("init");
      expect(parsed?.data.sessionId).toBe("codex-thread-123");
    });

    test("auto-detects Codex from item.started event", () => {
      const rawEvent = {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
        },
      };

      const parsed = parseEvent(rawEvent);
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_use");
      expect(parsed?.data.tool).toBe("Bash");
    });

    test("auto-detects Codex from turn.completed event", () => {
      const rawEvent = {
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50 },
      };

      const parsed = parseEvent(rawEvent);
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("result");
    });
  });

  describe("parseEvent with explicit provider", () => {
    test("uses Claude parser when provider is claude-code", () => {
      const rawEvent = {
        type: "system",
        subtype: "init",
        session_id: "test-session",
        model: "claude-3-5-sonnet",
        tools: [],
      };

      const parsed = parseEvent(rawEvent, "claude-code");
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("init");
    });

    test("uses Codex parser when provider is codex", () => {
      const rawEvent = {
        type: "thread.started",
        thread_id: "codex-thread-123",
      };

      const parsed = parseEvent(rawEvent, "codex");
      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("init");
    });
  });

  describe("edge cases", () => {
    test("defaults to Claude parser for unknown event type", () => {
      const rawEvent = {
        type: "unknown_type",
        data: {},
      };

      // Should use Claude parser (default) and return null since event is unknown
      const parsed = parseEvent(rawEvent);
      expect(parsed).toBeNull();
    });

    test("returns null for null/undefined input", () => {
      const parsed = parseEvent(null as unknown as Record<string, unknown>);
      expect(parsed).toBeNull();
    });
  });
});
