import { describe, test, expect } from "vitest";
import { CodexEventParser } from "../codex-event-parser";

describe("CodexEventParser", () => {
  describe("thread.started event", () => {
    test("parses thread.started as init event", () => {
      const rawEvent = {
        type: "thread.started",
        thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("init");
      expect(parsed?.data.sessionId).toBe(
        "0199a213-81c0-7800-8aa1-bbab2a035a53",
      );
      expect(parsed?.data.model).toBeUndefined();
    });
  });

  describe("turn.completed event", () => {
    test("parses turn.completed as result event", () => {
      const rawEvent = {
        type: "turn.completed",
        usage: {
          input_tokens: 24763,
          cached_input_tokens: 24448,
          output_tokens: 122,
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("result");
      expect(parsed?.data.success).toBe(true);
      expect(parsed?.data.usage).toEqual({
        input_tokens: 24763,
        cached_input_tokens: 24448,
        output_tokens: 122,
      });
    });
  });

  describe("turn.failed event", () => {
    test("parses turn.failed as result event with error", () => {
      const rawEvent = {
        type: "turn.failed",
        error: "Rate limit exceeded",
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("result");
      expect(parsed?.data.success).toBe(false);
      expect(parsed?.data.result).toBe("Rate limit exceeded");
    });
  });

  describe("item events - agent_message", () => {
    test("parses agent_message as text event", () => {
      const rawEvent = {
        type: "item.completed",
        item: {
          id: "item_3",
          type: "agent_message",
          text: "Repo contains docs, sdk, and examples directories.",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("text");
      expect(parsed?.data.text).toBe(
        "Repo contains docs, sdk, and examples directories.",
      );
    });
  });

  describe("item events - command_execution", () => {
    test("parses command_execution item.started as tool_use", () => {
      const rawEvent = {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "bash -lc ls",
          status: "in_progress",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_use");
      expect(parsed?.data.tool).toBe("Bash");
      expect(parsed?.data.toolUseId).toBe("item_1");
      expect(parsed?.data.input).toEqual({ command: "bash -lc ls" });
    });

    test("parses command_execution item.completed as tool_result", () => {
      const rawEvent = {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "bash -lc ls",
          exit_code: 0,
          output: "README.md\nsrc\n",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_result");
      expect(parsed?.data.toolUseId).toBe("item_1");
      expect(parsed?.data.result).toBe("README.md\nsrc\n");
      expect(parsed?.data.isError).toBe(false);
    });

    test("parses command_execution with non-zero exit code as error", () => {
      const rawEvent = {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls /nonexistent",
          exit_code: 1,
          output: "ls: cannot access '/nonexistent': No such file or directory",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_result");
      expect(parsed?.data.isError).toBe(true);
    });
  });

  describe("item events - file operations", () => {
    test("parses file_edit item.started as tool_use", () => {
      const rawEvent = {
        type: "item.started",
        item: {
          id: "item_5",
          type: "file_edit",
          path: "/workspace/src/main.ts",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_use");
      expect(parsed?.data.tool).toBe("Edit");
      expect(parsed?.data.input).toEqual({
        file_path: "/workspace/src/main.ts",
      });
    });

    test("parses file_write item.started as tool_use", () => {
      const rawEvent = {
        type: "item.started",
        item: {
          id: "item_6",
          type: "file_write",
          path: "/workspace/README.md",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_use");
      expect(parsed?.data.tool).toBe("Write");
    });

    test("parses file_read item.started as tool_use", () => {
      const rawEvent = {
        type: "item.started",
        item: {
          id: "item_7",
          type: "file_read",
          path: "/workspace/package.json",
        },
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("tool_use");
      expect(parsed?.data.tool).toBe("Read");
    });
  });

  describe("error event", () => {
    test("parses error event as result with failure", () => {
      const rawEvent = {
        type: "error",
        message: "API connection failed",
      };

      const parsed = CodexEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed?.type).toBe("result");
      expect(parsed?.data.success).toBe(false);
      expect(parsed?.data.result).toBe("API connection failed");
    });
  });

  describe("edge cases", () => {
    test("returns null for turn.started (not useful for display)", () => {
      const rawEvent = {
        type: "turn.started",
      };

      const parsed = CodexEventParser.parse(rawEvent);
      expect(parsed).toBeNull();
    });

    test("returns null for unknown event type", () => {
      const rawEvent = {
        type: "unknown.event",
        data: {},
      };

      const parsed = CodexEventParser.parse(rawEvent);
      expect(parsed).toBeNull();
    });

    test("returns null for null input", () => {
      const parsed = CodexEventParser.parse(
        null as unknown as Record<string, unknown>,
      );
      expect(parsed).toBeNull();
    });

    test("returns null for empty object", () => {
      const parsed = CodexEventParser.parse({});
      expect(parsed).toBeNull();
    });
  });
});
