import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventRenderer } from "../event-renderer";
import type { ParsedEvent } from "../event-parser";

describe("EventRenderer", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  // ============================================
  // Init Event Rendering Tests
  // ============================================

  describe("Init Event", () => {
    it("should render init event with session, model, and tools", () => {
      const event: ParsedEvent = {
        type: "init",
        timestamp: new Date(),
        data: {
          sessionId: "session-123",
          model: "claude-sonnet-4-5",
          tools: ["Bash", "Read", "Write", "Edit"],
          cwd: "/tmp",
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalledTimes(4);
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[init]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain(
        "Starting Claude Code agent",
      );
      expect(consoleLogSpy.mock.calls[1][0]).toContain("Session:");
      expect(consoleLogSpy.mock.calls[1][0]).toContain("session-123");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("Model:");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("claude-sonnet-4-5");
      expect(consoleLogSpy.mock.calls[3][0]).toContain("Tools:");
      expect(consoleLogSpy.mock.calls[3][0]).toContain(
        "Bash, Read, Write, Edit",
      );
    });

    it("should handle init event without cwd", () => {
      const event: ParsedEvent = {
        type: "init",
        timestamp: new Date(),
        data: {
          sessionId: "session-456",
          model: "claude-sonnet-4-5",
          tools: ["Bash"],
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalledTimes(4);
    });
  });

  // ============================================
  // Text Event Rendering Tests
  // ============================================

  describe("Text Event", () => {
    it("should render text event", () => {
      const event: ParsedEvent = {
        type: "text",
        timestamp: new Date(),
        data: {
          text: "I'll create a hello.md file with content.",
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[text]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain(
        "I'll create a hello.md file with content.",
      );
    });

    it("should handle long text", () => {
      const longText = "x".repeat(500);
      const event: ParsedEvent = {
        type: "text",
        timestamp: new Date(),
        data: { text: longText },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0][0]).toContain(longText);
    });
  });

  // ============================================
  // Tool Use Event Rendering Tests
  // ============================================

  describe("Tool Use Event", () => {
    it("should render tool use with input parameters", () => {
      const event: ParsedEvent = {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Write",
          toolUseId: "toolu_123",
          input: {
            file_path: "/tmp/test.txt",
            content: "hello world",
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[tool_use]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain("Write");
      expect(consoleLogSpy.mock.calls[1][0]).toContain("file_path:");
      expect(consoleLogSpy.mock.calls[1][0]).toContain("/tmp/test.txt");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("content:");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("hello world");
    });

    it("should show full input values without truncation", () => {
      const longValue = "x".repeat(200);
      const event: ParsedEvent = {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Bash",
          toolUseId: "toolu_456",
          input: {
            command: longValue,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      const commandOutput = consoleLogSpy.mock.calls[1][0];
      expect(commandOutput).toContain(longValue);
    });

    it("should handle empty input", () => {
      const event: ParsedEvent = {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Read",
          toolUseId: "toolu_789",
          input: {},
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0][0]).toContain("Read");
    });
  });

  // ============================================
  // Tool Result Event Rendering Tests
  // ============================================

  describe("Tool Result Event", () => {
    it("should render successful tool result", () => {
      const event: ParsedEvent = {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: "toolu_123",
          result: "File created successfully",
          isError: false,
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[tool_result]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain("Completed");
      expect(consoleLogSpy.mock.calls[1][0]).toContain(
        "File created successfully",
      );
    });

    it("should render error tool result", () => {
      const event: ParsedEvent = {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: "toolu_456",
          result: "Error: File not found",
          isError: true,
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[tool_result]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain("Error");
      expect(consoleLogSpy.mock.calls[1][0]).toContain("Error: File not found");
    });

    it("should show full result content without truncation", () => {
      const longResult = "y".repeat(300);
      const event: ParsedEvent = {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: "toolu_789",
          result: longResult,
          isError: false,
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      const resultOutput = consoleLogSpy.mock.calls[1][0];
      expect(resultOutput).toContain(longResult);
    });
  });

  // ============================================
  // Result Event Rendering Tests
  // ============================================

  describe("Result Event", () => {
    it("should render successful result with all details", () => {
      const event: ParsedEvent = {
        type: "result",
        timestamp: new Date(),
        data: {
          success: true,
          result: "Task completed successfully",
          durationMs: 45200,
          numTurns: 2,
          cost: 0.02614095,
          usage: {
            input_tokens: 7000,
            cache_read_input_tokens: 27989,
            output_tokens: 116,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[result]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain("✓");
      expect(consoleLogSpy.mock.calls[0][0]).toContain(
        "completed successfully",
      );
      expect(consoleLogSpy.mock.calls[1][0]).toContain("Duration:");
      expect(consoleLogSpy.mock.calls[1][0]).toContain("45.2s");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("Cost:");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("$0.0261");
      expect(consoleLogSpy.mock.calls[3][0]).toContain("Turns:");
      expect(consoleLogSpy.mock.calls[3][0]).toContain("2");
      expect(consoleLogSpy.mock.calls[4][0]).toContain("Tokens:");
      expect(consoleLogSpy.mock.calls[4][0]).toContain("input=7k");
      expect(consoleLogSpy.mock.calls[4][0]).toContain("output=116");
    });

    it("should render failed result", () => {
      const event: ParsedEvent = {
        type: "result",
        timestamp: new Date(),
        data: {
          success: false,
          result: "Execution failed",
          durationMs: 5000,
          numTurns: 1,
          cost: 0.001,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0][0]).toContain("[result]");
      expect(consoleLogSpy.mock.calls[0][0]).toContain("✗");
      expect(consoleLogSpy.mock.calls[0][0]).toContain("failed");
    });

    it("should format tokens in thousands", () => {
      const event: ParsedEvent = {
        type: "result",
        timestamp: new Date(),
        data: {
          success: true,
          result: "Done",
          durationMs: 1000,
          numTurns: 1,
          cost: 0.0,
          usage: {
            input_tokens: 28543,
            output_tokens: 242,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      const tokensOutput = consoleLogSpy.mock.calls[4][0];
      expect(tokensOutput).toContain("input=28k");
      expect(tokensOutput).toContain("output=242");
    });

    it("should handle zero values", () => {
      const event: ParsedEvent = {
        type: "result",
        timestamp: new Date(),
        data: {
          success: true,
          result: "Done",
          durationMs: 0,
          numTurns: 0,
          cost: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[1][0]).toContain("0.0s");
      expect(consoleLogSpy.mock.calls[2][0]).toContain("$0.0000");
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe("Edge Cases", () => {
    it("should handle missing data fields gracefully", () => {
      const event: ParsedEvent = {
        type: "text",
        timestamp: new Date(),
        data: {},
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should handle undefined values in tool input", () => {
      const event: ParsedEvent = {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Test",
          toolUseId: "toolu_test",
          input: {
            defined: "value",
            undefined: undefined,
            null: null,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
    });
  });
});
