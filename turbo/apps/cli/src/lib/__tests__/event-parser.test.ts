import { describe, it, expect } from "vitest";
import { ClaudeEventParser } from "../event-parser";

describe("ClaudeEventParser", () => {
  // ============================================
  // System Init Event Tests
  // ============================================

  describe("System Init Event", () => {
    it("should parse system init event correctly", () => {
      const rawEvent = {
        type: "system",
        subtype: "init",
        cwd: "/tmp",
        session_id: "45123049-1ebd-4293-a0d3-89834fbd6f4c",
        tools: ["Task", "Bash", "Glob", "Grep", "Read", "Write", "Edit"],
        model: "claude-sonnet-4-5-20250929",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("init");
      expect(parsed!.data).toEqual({
        sessionId: "45123049-1ebd-4293-a0d3-89834fbd6f4c",
        model: "claude-sonnet-4-5-20250929",
        tools: ["Task", "Bash", "Glob", "Grep", "Read", "Write", "Edit"],
        cwd: "/tmp",
      });
      expect(parsed!.timestamp).toBeInstanceOf(Date);
    });

    it("should handle system events without cwd", () => {
      const rawEvent = {
        type: "system",
        subtype: "init",
        session_id: "test-session",
        tools: ["Bash"],
        model: "claude-sonnet-4-5-20250929",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("init");
      expect(parsed!.data.cwd).toBeUndefined();
    });
  });

  // ============================================
  // Assistant Text Event Tests
  // ============================================

  describe("Assistant Text Event", () => {
    it("should parse assistant text event correctly", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll create a temp.md file with 'hello world' content.",
            },
          ],
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 12585,
            output_tokens: 92,
          },
        },
        session_id: "45123049-1ebd-4293-a0d3-89834fbd6f4c",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("text");
      expect(parsed!.data).toEqual({
        text: "I'll create a temp.md file with 'hello world' content.",
      });
      expect(parsed!.timestamp).toBeInstanceOf(Date);
    });

    it("should handle assistant text with special characters", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: 'Text with "quotes" and\nnewlines\tand\ttabs',
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("text");
      expect(parsed!.data.text).toBe(
        'Text with "quotes" and\nnewlines\tand\ttabs',
      );
    });
  });

  // ============================================
  // Assistant Tool Use Event Tests
  // ============================================

  describe("Assistant Tool Use Event", () => {
    it("should parse tool use event correctly", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01VejMcsR4nNUD8nMBSQPtKz",
              name: "Write",
              input: {
                file_path: "/tmp/temp.md",
                content: "hello world",
              },
            },
          ],
        },
        session_id: "45123049-1ebd-4293-a0d3-89834fbd6f4c",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("tool_use");
      expect(parsed!.data).toEqual({
        tool: "Write",
        toolUseId: "toolu_01VejMcsR4nNUD8nMBSQPtKz",
        input: {
          file_path: "/tmp/temp.md",
          content: "hello world",
        },
      });
      expect(parsed!.timestamp).toBeInstanceOf(Date);
    });

    it("should handle tool use with complex input", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Bash",
              input: {
                command: "npm install",
                timeout: 60000,
                env: {
                  NODE_ENV: "production",
                  DEBUG: "*",
                },
              },
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("tool_use");
      expect(parsed!.data.tool).toBe("Bash");
      expect(parsed!.data.input).toEqual({
        command: "npm install",
        timeout: 60000,
        env: {
          NODE_ENV: "production",
          DEBUG: "*",
        },
      });
    });

    it("should handle tool use with empty input", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_456",
              name: "Read",
              input: {},
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("tool_use");
      expect(parsed!.data.input).toEqual({});
    });
  });

  // ============================================
  // User Tool Result Event Tests
  // ============================================

  describe("User Tool Result Event", () => {
    it("should parse tool result event correctly", () => {
      const rawEvent = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_01VejMcsR4nNUD8nMBSQPtKz",
              type: "tool_result",
              content: "File created successfully at: /tmp/temp.md",
            },
          ],
        },
        session_id: "45123049-1ebd-4293-a0d3-89834fbd6f4c",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("tool_result");
      expect(parsed!.data).toEqual({
        toolUseId: "toolu_01VejMcsR4nNUD8nMBSQPtKz",
        result: "File created successfully at: /tmp/temp.md",
        isError: false,
      });
      expect(parsed!.timestamp).toBeInstanceOf(Date);
    });

    it("should parse tool result with error correctly", () => {
      const rawEvent = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_789",
              type: "tool_result",
              content: "Error: File not found",
              is_error: true,
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("tool_result");
      expect(parsed!.data.isError).toBe(true);
      expect(parsed!.data.result).toBe("Error: File not found");
    });

    it("should default isError to false when not provided", () => {
      const rawEvent = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_999",
              type: "tool_result",
              content: "Success",
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.data.isError).toBe(false);
    });
  });

  // ============================================
  // Result Event Tests
  // ============================================

  describe("Result Event", () => {
    it("should parse success result event correctly", () => {
      const rawEvent = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 40528,
        num_turns: 2,
        result: "I've created the file temp.md with the content 'hello world'.",
        session_id: "45123049-1ebd-4293-a0d3-89834fbd6f4c",
        total_cost_usd: 0.02614095,
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 2931,
          cache_read_input_tokens: 27989,
          output_tokens: 116,
        },
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("result");
      expect(parsed!.data).toEqual({
        success: true,
        result: "I've created the file temp.md with the content 'hello world'.",
        durationMs: 40528,
        numTurns: 2,
        cost: 0.02614095,
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 2931,
          cache_read_input_tokens: 27989,
          output_tokens: 116,
        },
      });
      expect(parsed!.timestamp).toBeInstanceOf(Date);
    });

    it("should parse error result event correctly", () => {
      const rawEvent = {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 5000,
        num_turns: 1,
        result: "Failed to execute command",
        session_id: "test-session",
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("result");
      expect(parsed!.data.success).toBe(false);
      expect(parsed!.data.result).toBe("Failed to execute command");
    });

    it("should handle result with missing usage fields", () => {
      const rawEvent = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        num_turns: 1,
        result: "Done",
        session_id: "test-session",
        total_cost_usd: 0.0,
        usage: {},
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("result");
      expect(parsed!.data.usage).toEqual({});
    });
  });

  // ============================================
  // Unknown Event Tests
  // ============================================

  describe("Unknown Events", () => {
    it("should return null for unknown event type", () => {
      const rawEvent = {
        type: "unknown_type",
        data: "some data",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeNull();
    });

    it("should return null for assistant event with unknown content type", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "unknown_content_type",
              data: "something",
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeNull();
    });

    it("should return null for user event with unknown content type", () => {
      const rawEvent = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "unknown_user_content",
              data: "something",
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeNull();
    });

    it("should return null for malformed event", () => {
      const rawEvent = {
        // Missing required fields
        data: "incomplete",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeNull();
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe("Edge Cases", () => {
    it("should handle assistant event with empty content array", () => {
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeNull();
    });

    it("should handle user event with empty content array", () => {
      const rawEvent = {
        type: "user",
        message: {
          role: "user",
          content: [],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeNull();
    });

    it("should handle very long text content", () => {
      const longText = "x".repeat(10000);
      const rawEvent = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: longText,
            },
          ],
        },
        session_id: "test-session",
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.type).toBe("text");
      expect(parsed!.data.text).toBe(longText);
    });

    it("should handle zero cost and duration", () => {
      const rawEvent = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 0,
        num_turns: 0,
        result: "Instant",
        session_id: "test-session",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      };

      const parsed = ClaudeEventParser.parse(rawEvent);

      expect(parsed).toBeDefined();
      expect(parsed!.data.durationMs).toBe(0);
      expect(parsed!.data.cost).toBe(0);
    });
  });
});
