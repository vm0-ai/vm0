import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventRenderer, type RenderOptions } from "../event-renderer";
import type { ParsedEvent } from "../claude-event-parser";

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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[init]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain(
        "Starting Claude Code agent",
      );
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("Session:");
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("session-123");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("Model:");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("claude-sonnet-4-5");
      expect(consoleLogSpy.mock.calls[3]![0]).toContain("Tools:");
      expect(consoleLogSpy.mock.calls[3]![0]).toContain(
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[text]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain(
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain(longText);
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[tool_use]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("Write");
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("file_path:");
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("/tmp/test.txt");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("content:");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("hello world");
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
      const commandOutput = consoleLogSpy.mock.calls[1]![0];
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("Read");
    });

    it("should render object values as formatted JSON", () => {
      const todos = [
        {
          content: "Task 1",
          status: "pending",
          activeForm: "Working on task 1",
        },
        {
          content: "Task 2",
          status: "completed",
          activeForm: "Working on task 2",
        },
      ];
      const event: ParsedEvent = {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "TodoWrite",
          toolUseId: "toolu_todo",
          input: {
            todos,
          },
        },
      };

      EventRenderer.render(event);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[tool_use]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("TodoWrite");

      // Verify the todos are rendered as JSON, not [object Object]
      const todosOutput = consoleLogSpy.mock.calls[1]![0] as string;
      expect(todosOutput).toContain("todos:");
      expect(todosOutput).not.toContain("[object Object]");
      expect(todosOutput).toContain("Task 1");
      expect(todosOutput).toContain("pending");
      expect(todosOutput).toContain("Task 2");
      expect(todosOutput).toContain("completed");
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[tool_result]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("Completed");
      expect(consoleLogSpy.mock.calls[1]![0]).toContain(
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[tool_result]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("Error");
      expect(consoleLogSpy.mock.calls[1]![0]).toContain(
        "Error: File not found",
      );
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
      const resultOutput = consoleLogSpy.mock.calls[1]![0];
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[result]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("✓");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain(
        "completed successfully",
      );
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("Duration:");
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("45.2s");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("Cost:");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("$0.0261");
      expect(consoleLogSpy.mock.calls[3]![0]).toContain("Turns:");
      expect(consoleLogSpy.mock.calls[3]![0]).toContain("2");
      expect(consoleLogSpy.mock.calls[4]![0]).toContain("Tokens:");
      expect(consoleLogSpy.mock.calls[4]![0]).toContain("input=7k");
      expect(consoleLogSpy.mock.calls[4]![0]).toContain("output=116");
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
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[result]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("✗");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("failed");
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
      const tokensOutput = consoleLogSpy.mock.calls[4]![0];
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
      expect(consoleLogSpy.mock.calls[1]![0]).toContain("0.0s");
      expect(consoleLogSpy.mock.calls[2]![0]).toContain("$0.0000");
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

  // ============================================
  // Elapsed Time Formatting Tests
  // ============================================

  describe("formatElapsed", () => {
    it("should format milliseconds for values under 1000ms", () => {
      const start = new Date("2024-01-01T00:00:00.000Z");
      const end = new Date("2024-01-01T00:00:00.500Z");

      const result = EventRenderer.formatElapsed(start, end);

      expect(result).toBe("[+500ms]");
    });

    it("should format seconds for values 1000ms and above", () => {
      const start = new Date("2024-01-01T00:00:00.000Z");
      const end = new Date("2024-01-01T00:00:02.300Z");

      const result = EventRenderer.formatElapsed(start, end);

      expect(result).toBe("[+2.3s]");
    });

    it("should handle exact 1000ms boundary", () => {
      const start = new Date("2024-01-01T00:00:00.000Z");
      const end = new Date("2024-01-01T00:00:01.000Z");

      const result = EventRenderer.formatElapsed(start, end);

      expect(result).toBe("[+1.0s]");
    });

    it("should handle zero elapsed time", () => {
      const time = new Date("2024-01-01T00:00:00.000Z");

      const result = EventRenderer.formatElapsed(time, time);

      expect(result).toBe("[+0ms]");
    });
  });

  describe("formatTotalTime", () => {
    it("should format total time in seconds", () => {
      const start = new Date("2024-01-01T00:00:00.000Z");
      const end = new Date("2024-01-01T00:00:06.700Z");

      const result = EventRenderer.formatTotalTime(start, end);

      expect(result).toBe("6.7s");
    });

    it("should handle short durations", () => {
      const start = new Date("2024-01-01T00:00:00.000Z");
      const end = new Date("2024-01-01T00:00:00.500Z");

      const result = EventRenderer.formatTotalTime(start, end);

      expect(result).toBe("0.5s");
    });
  });

  // ============================================
  // Verbose Mode Tests
  // ============================================

  describe("Verbose Mode", () => {
    it("should render elapsed time prefix in verbose mode", () => {
      const event: ParsedEvent = {
        type: "text",
        timestamp: new Date("2024-01-01T00:00:01.500Z"),
        data: {
          text: "Hello world",
        },
      };

      const options: RenderOptions = {
        verbose: true,
        previousTimestamp: new Date("2024-01-01T00:00:00.000Z"),
      };

      EventRenderer.render(event, options);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[text]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[+1.5s]");
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("Hello world");
    });

    it("should not render elapsed time without verbose flag", () => {
      const event: ParsedEvent = {
        type: "text",
        timestamp: new Date("2024-01-01T00:00:01.500Z"),
        data: {
          text: "Hello world",
        },
      };

      const options: RenderOptions = {
        verbose: false,
        previousTimestamp: new Date("2024-01-01T00:00:00.000Z"),
      };

      EventRenderer.render(event, options);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[text]");
      expect(consoleLogSpy.mock.calls[0]![0]).not.toContain("[+");
    });

    it("should not render elapsed time without previousTimestamp", () => {
      const event: ParsedEvent = {
        type: "text",
        timestamp: new Date("2024-01-01T00:00:01.500Z"),
        data: {
          text: "Hello world",
        },
      };

      const options: RenderOptions = {
        verbose: true,
      };

      EventRenderer.render(event, options);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[text]");
      expect(consoleLogSpy.mock.calls[0]![0]).not.toContain("[+");
    });

    it("should render elapsed time for all event types in verbose mode", () => {
      const baseTimestamp = new Date("2024-01-01T00:00:00.000Z");
      const eventTimestamp = new Date("2024-01-01T00:00:00.100Z");

      const options: RenderOptions = {
        verbose: true,
        previousTimestamp: baseTimestamp,
      };

      // Test init event
      const initEvent: ParsedEvent = {
        type: "init",
        timestamp: eventTimestamp,
        data: { sessionId: "test", model: "test", tools: [] },
      };
      EventRenderer.render(initEvent, options);
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[+100ms]");

      consoleLogSpy.mockClear();

      // Test tool_use event
      const toolUseEvent: ParsedEvent = {
        type: "tool_use",
        timestamp: eventTimestamp,
        data: { tool: "Bash", input: {} },
      };
      EventRenderer.render(toolUseEvent, options);
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[+100ms]");

      consoleLogSpy.mockClear();

      // Test tool_result event
      const toolResultEvent: ParsedEvent = {
        type: "tool_result",
        timestamp: eventTimestamp,
        data: { result: "done", isError: false },
      };
      EventRenderer.render(toolResultEvent, options);
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[+100ms]");

      consoleLogSpy.mockClear();

      // Test result event
      const resultEvent: ParsedEvent = {
        type: "result",
        timestamp: eventTimestamp,
        data: { success: true, durationMs: 0, numTurns: 0, cost: 0, usage: {} },
      };
      EventRenderer.render(resultEvent, options);
      expect(consoleLogSpy.mock.calls[0]![0]).toContain("[+100ms]");
    });
  });

  // ============================================
  // Run State Rendering Tests
  // ============================================

  describe("Run State Rendering", () => {
    it("should render run started with run ID and logs hint", () => {
      EventRenderer.renderRunStarted({
        runId: "test-run-123",
      });

      expect(consoleLogSpy).toHaveBeenCalled();
      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(allCalls.some((call) => call.includes("Run started"))).toBe(true);
      expect(allCalls.some((call) => call.includes("Run ID:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("test-run-123"))).toBe(true);
      expect(
        allCalls.some((call) => call.includes("vm0 logs test-run-123")),
      ).toBe(true);
    });

    it("should render run started with sandbox ID when provided", () => {
      EventRenderer.renderRunStarted({
        runId: "test-run-456",
        sandboxId: "sandbox-abc",
      });

      expect(consoleLogSpy).toHaveBeenCalled();
      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(allCalls.some((call) => call.includes("Sandbox:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("sandbox-abc"))).toBe(true);
    });

    it("should render run completed with result", () => {
      const result = {
        checkpointId: "checkpoint-123",
        agentSessionId: "session-456",
        conversationId: "conv-789",
        artifact: { "my-artifact": "abc12345" },
      };

      EventRenderer.renderRunCompleted(result);

      expect(consoleLogSpy).toHaveBeenCalled();
      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(
        allCalls.some((call) => call.includes("Run completed successfully")),
      ).toBe(true);
      expect(allCalls.some((call) => call.includes("Checkpoint:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("Session:"))).toBe(true);
    });

    it("should render run completed without result", () => {
      EventRenderer.renderRunCompleted(undefined);

      expect(consoleLogSpy).toHaveBeenCalled();
      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(
        allCalls.some((call) => call.includes("Run completed successfully")),
      ).toBe(true);
    });

    it("should render run failed with error", () => {
      EventRenderer.renderRunFailed("Something went wrong", "run-123");

      expect(consoleLogSpy).toHaveBeenCalled();
      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(allCalls.some((call) => call.includes("Run failed"))).toBe(true);
      expect(
        allCalls.some((call) => call.includes("Something went wrong")),
      ).toBe(true);
      expect(
        allCalls.some((call) => call.includes("vm0 logs run-123 --system")),
      ).toBe(true);
    });

    it("should render run failed without error", () => {
      EventRenderer.renderRunFailed(undefined, "run-456");

      expect(consoleLogSpy).toHaveBeenCalled();
      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      expect(allCalls.some((call) => call.includes("Run failed"))).toBe(true);
      expect(allCalls.some((call) => call.includes("Unknown error"))).toBe(
        true,
      );
      expect(
        allCalls.some((call) => call.includes("vm0 logs run-456 --system")),
      ).toBe(true);
    });

    it("should render total time in verbose mode", () => {
      const result = {
        checkpointId: "checkpoint-123",
        agentSessionId: "session-456",
        conversationId: "conv-789",
        artifact: {},
      };

      const options: RenderOptions = {
        verbose: true,
        startTimestamp: new Date("2024-01-01T00:00:00.000Z"),
      };

      // Mock Date to control time
      const mockNow = new Date("2024-01-01T00:00:06.700Z");
      vi.setSystemTime(mockNow);

      EventRenderer.renderRunCompleted(result, options);

      vi.useRealTimers();

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasTotalTime = allCalls.some(
        (call) => call.includes("Total time:") && call.includes("6.7s"),
      );
      expect(hasTotalTime).toBe(true);
    });

    it("should not render total time without verbose flag", () => {
      const result = {
        checkpointId: "checkpoint-123",
        agentSessionId: "session-456",
        conversationId: "conv-789",
        artifact: {},
      };

      const options: RenderOptions = {
        verbose: false,
        startTimestamp: new Date("2024-01-01T00:00:00.000Z"),
      };

      EventRenderer.renderRunCompleted(result, options);

      const allCalls = consoleLogSpy.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasTotalTime = allCalls.some(
        (call) => call && call.includes("Total time"),
      );
      expect(hasTotalTime).toBe(false);
    });
  });
});
