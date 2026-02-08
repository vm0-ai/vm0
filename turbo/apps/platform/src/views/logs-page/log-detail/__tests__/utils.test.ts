import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTime,
  formatDuration,
  eventMatchesSearch,
  getVisibleEventText,
  scrollToMatch,
  EVENTS_CONTAINER_ID,
  groupEventsIntoMessages,
  getVisibleGroupedMessageText,
  groupedMessageMatchesSearch,
  type ToolOperation,
} from "../utils.ts";
import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { groupConsecutiveTools } from "../../components/grouped-message-card.tsx";

describe("log-detail utils", () => {
  describe("formatTime", () => {
    it("should format date string to readable format", () => {
      const result = formatTime("2024-01-15T10:30:00Z");
      expect(result).toContain("Jan");
      expect(result).toContain("15");
    });
  });

  describe("formatDuration", () => {
    it("should return dash when startedAt is null", () => {
      expect(formatDuration(null, "2024-01-01T00:00:10Z")).toBe("-");
    });

    it("should return dash when completedAt is null", () => {
      expect(formatDuration("2024-01-01T00:00:00Z", null)).toBe("-");
    });

    it("should format milliseconds", () => {
      expect(
        formatDuration("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.500Z"),
      ).toBe("500ms");
    });

    it("should format seconds", () => {
      expect(
        formatDuration("2024-01-01T00:00:00Z", "2024-01-01T00:00:05Z"),
      ).toBe("5.0s");
    });

    it("should format minutes and seconds", () => {
      expect(
        formatDuration("2024-01-01T00:00:00Z", "2024-01-01T00:01:30Z"),
      ).toBe("1m 30s");
    });
  });

  describe("getVisibleEventText", () => {
    it("should include event type", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {},
        createdAt: "2024-01-01T00:00:00Z",
      };
      expect(getVisibleEventText(event)).toContain("assistant");
    });

    it("should extract text content from messages", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Hello world" }] },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      const visibleText = getVisibleEventText(event);
      expect(visibleText).toContain("Hello world");
    });

    it("should extract tool name from tool_use", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "tool_use", name: "Read", input: {} }],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      expect(getVisibleEventText(event)).toContain("Read");
    });

    it("should extract bash command from tool_use input", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "ls -la" },
              },
            ],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      const visibleText = getVisibleEventText(event);
      expect(visibleText).toContain("Bash");
      expect(visibleText).toContain("ls -la");
    });

    it("should extract URL from webfetch tool_use", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                name: "WebFetch",
                input: { url: "https://example.com", prompt: "fetch data" },
              },
            ],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      const visibleText = getVisibleEventText(event);
      expect(visibleText).toContain("https://example.com");
      expect(visibleText).toContain("fetch data");
    });

    it("should extract file path from read tool_use", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "/path/to/file.ts" },
              },
            ],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      expect(getVisibleEventText(event)).toContain("/path/to/file.ts");
    });

    it("should extract tool result content", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "tool_result", content: "File contents here" }],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      expect(getVisibleEventText(event)).toContain("File contents here");
    });

    it("should extract system event subtype and tools", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "system",
        eventData: {
          subtype: "init",
          tools: ["Bash", "Read", "Write"],
          agents: ["explorer"],
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      const visibleText = getVisibleEventText(event);
      expect(visibleText).toContain("system");
      expect(visibleText).toContain("init");
      expect(visibleText).toContain("Initialize");
      expect(visibleText).toContain("Bash");
      expect(visibleText).toContain("Read");
      expect(visibleText).toContain("explorer");
    });

    it("should extract result event data", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "result",
        eventData: {
          result: "Task completed successfully",
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      expect(getVisibleEventText(event)).toContain(
        "Task completed successfully",
      );
    });

    it("should NOT include internal JSON fields", () => {
      const event: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool_123abc",
                name: "Bash",
                input: { command: "echo hello" },
              },
            ],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      const visibleText = getVisibleEventText(event);
      expect(visibleText).not.toContain("tool_123abc");
      expect(visibleText).not.toContain("tool_use"); // the type field
    });
  });

  describe("eventMatchesSearch", () => {
    const event: AgentEvent = {
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: {
        message: { content: [{ type: "text", text: "Hello world" }] },
      },
      createdAt: "2024-01-01T00:00:00Z",
    };

    it("should return true when search term is empty", () => {
      expect(eventMatchesSearch(event, "")).toBeTruthy();
      expect(eventMatchesSearch(event, "   ")).toBeTruthy();
    });

    it("should match event type", () => {
      expect(eventMatchesSearch(event, "assistant")).toBeTruthy();
    });

    it("should match visible text content", () => {
      expect(eventMatchesSearch(event, "Hello")).toBeTruthy();
      expect(eventMatchesSearch(event, "world")).toBeTruthy();
    });

    it("should be case insensitive", () => {
      expect(eventMatchesSearch(event, "HELLO")).toBeTruthy();
      expect(eventMatchesSearch(event, "ASSISTANT")).toBeTruthy();
    });

    it("should return false when no match", () => {
      expect(eventMatchesSearch(event, "nonexistent")).toBeFalsy();
    });

    it("should NOT match internal JSON fields", () => {
      const eventWithInternalData: AgentEvent = {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_abc123",
                name: "Bash",
                input: { command: "ls" },
              },
            ],
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
      };
      // Should match visible fields
      expect(eventMatchesSearch(eventWithInternalData, "Bash")).toBeTruthy();
      expect(eventMatchesSearch(eventWithInternalData, "ls")).toBeTruthy();
      // Should NOT match internal fields
      expect(
        eventMatchesSearch(eventWithInternalData, "toolu_abc123"),
      ).toBeFalsy();
      expect(eventMatchesSearch(eventWithInternalData, "tool_use")).toBeFalsy();
    });
  });

  describe("scrollToMatch", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      vi.clearAllMocks();
      container = document.createElement("div");
      container.id = EVENTS_CONTAINER_ID;
      container.style.height = "200px";
      container.style.overflow = "auto";
      document.body.appendChild(container);

      // Mock getBoundingClientRect
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        top: 0,
        left: 0,
        bottom: 200,
        right: 400,
        width: 400,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      // Mock scrollTo
      vi.spyOn(container, "scrollTo").mockImplementation(() => {});
    });

    afterEach(() => {
      container.remove();
    });

    it("should do nothing when container is null", () => {
      scrollToMatch(null, 0);
      // No error should be thrown
    });

    it("should do nothing when matchIndex is negative", () => {
      scrollToMatch(container, -1);
      expect(container.scrollTo).not.toHaveBeenCalled();
    });

    it("should do nothing when match element is not found", () => {
      scrollToMatch(container, 0);
      expect(container.scrollTo).not.toHaveBeenCalled();
    });

    it("should scroll to match element when found", () => {
      const matchElement = document.createElement("span");
      matchElement.dataset.matchIndex = "0";
      container.appendChild(matchElement);

      vi.spyOn(matchElement, "getBoundingClientRect").mockReturnValue({
        top: 100,
        left: 0,
        bottom: 120,
        right: 100,
        width: 100,
        height: 20,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      });

      scrollToMatch(container, 0);
      expect(container.scrollTo).toHaveBeenCalledWith({
        top: expect.any(Number),
        behavior: "smooth",
      });
    });

    it("should scroll to correct match index", () => {
      // Add multiple match elements
      for (let i = 0; i < 3; i++) {
        const matchElement = document.createElement("span");
        matchElement.dataset.matchIndex = String(i);
        matchElement.textContent = `Match ${i}`;
        container.appendChild(matchElement);

        vi.spyOn(matchElement, "getBoundingClientRect").mockReturnValue({
          top: 50 + i * 100,
          left: 0,
          bottom: 70 + i * 100,
          right: 100,
          width: 100,
          height: 20,
          x: 0,
          y: 50 + i * 100,
          toJSON: () => ({}),
        });
      }

      scrollToMatch(container, 1);
      expect(container.scrollTo).toHaveBeenCalledWith({
        top: expect.any(Number),
        behavior: "smooth",
      });
    });
  });

  describe("events container id", () => {
    it("should be a valid string constant", () => {
      expect(typeof EVENTS_CONTAINER_ID).toBe("string");
      expect(EVENTS_CONTAINER_ID.length).toBeGreaterThan(0);
    });
  });

  describe("groupEventsIntoMessages", () => {
    it("should return empty array for empty events", () => {
      const result = groupEventsIntoMessages([]);
      expect(result).toStrictEqual([]);
    });

    it("should keep system events as independent messages", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "system",
          eventData: { subtype: "init", tools: ["Bash"] },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("system");
    });

    it("should keep result events as independent messages", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "result",
          eventData: { result: "Task completed" },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("result");
    });

    it("should extract text from assistant messages", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Hello world" }],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("assistant");
      expect(result[0].textBefore).toBe("Hello world");
    });

    it("should extract tool operations from assistant messages", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_123",
                  name: "Bash",
                  input: { command: "ls -la" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result).toHaveLength(1);
      expect(result[0].toolOperations).toHaveLength(1);
      expect(result[0].toolOperations?.[0].toolName).toBe("Bash");
      expect(result[0].toolOperations?.[0].keyParam).toBe("ls -la");
    });

    it("should link tool_result to pending tool_use", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_123",
                  name: "Bash",
                  input: { command: "ls -la" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          sequenceNumber: 2,
          eventType: "user",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_123",
                  content: "file1.txt\nfile2.txt",
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result).toHaveLength(1);
      expect(result[0].toolOperations?.[0].result?.content).toBe(
        "file1.txt\nfile2.txt",
      );
    });

    it("should handle orphan tool_result without matching tool_use", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "user",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "orphan_tool",
                  content: "orphan result",
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("assistant");
      expect(result[0].toolOperations?.[0].result?.content).toBe(
        "orphan result",
      );
    });

    it("should link tool_result to tool_use when events arrive out of order", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 2,
          eventType: "user",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool_bash_1",
                  content: "file1.txt\nfile2.txt",
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_bash_1",
                  name: "Bash",
                  input: { command: "ls" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      const toolOp = result
        .flatMap((m) => m.toolOperations ?? [])
        .find((op) => op.toolUseId === "tool_bash_1");
      expect(toolOp).toBeDefined();
      expect(toolOp!.toolName).toBe("Bash");
      expect(toolOp!.result?.content).toBe("file1.txt\nfile2.txt");
    });

    it("should extract key param for file operations", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_123",
                  name: "Read",
                  input: { file_path: "/path/to/file.ts" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      expect(result[0].toolOperations?.[0].keyParam).toBe("/path/to/file.ts");
    });

    it("should merge consecutive tool-only events into previous assistant card", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Let me help you" }],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          sequenceNumber: 2,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_1",
                  name: "Read",
                  input: { file_path: "/file1.ts" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          sequenceNumber: 3,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_2",
                  name: "Bash",
                  input: { command: "ls" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:02Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      // All should be merged into one card
      expect(result).toHaveLength(1);
      expect(result[0].textBefore).toBe("Let me help you");
      expect(result[0].toolOperations).toHaveLength(2);
      expect(result[0].toolOperations?.[0].toolName).toBe("Read");
      expect(result[0].toolOperations?.[1].toolName).toBe("Bash");
    });

    it("should start new card when new text appears", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "First message" }],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          sequenceNumber: 2,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_1",
                  name: "Read",
                  input: { file_path: "/file1.ts" },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          sequenceNumber: 3,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Second message" }],
            },
          },
          createdAt: "2024-01-01T00:00:02Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      // Should be two cards: first with text+tool, second with new text
      expect(result).toHaveLength(2);
      expect(result[0].textBefore).toBe("First message");
      expect(result[0].toolOperations).toHaveLength(1);
      expect(result[1].textBefore).toBe("Second message");
      expect(result[1].toolOperations).toBeUndefined();
    });

    it("should create standalone todo card for TodoWrite", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool_1",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      { content: "Task 1", status: "completed" },
                      { content: "Task 2", status: "pending" },
                    ],
                  },
                },
              ],
            },
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          sequenceNumber: 2,
          eventType: "result",
          eventData: { result: "Done" },
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const result = groupEventsIntoMessages(events);
      // Should be: standalone todo card, result
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("todo");
      expect(result[0].todoState).toHaveLength(2);
      expect(result[0].todoState?.[0].content).toBe("Task 1");
      expect(result[0].todoState?.[0].status).toBe("completed");
      expect(result[1].type).toBe("result");
    });
  });

  describe("getVisibleGroupedMessageText", () => {
    it("should include message type", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        eventData: {},
      };
      expect(getVisibleGroupedMessageText(message)).toContain("assistant");
    });

    it("should include textBefore and textAfter", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        textBefore: "Before text",
        textAfter: "After text",
        eventData: {},
      };
      const text = getVisibleGroupedMessageText(message);
      expect(text).toContain("Before text");
      expect(text).toContain("After text");
    });

    it("should include tool operation details", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        toolOperations: [
          {
            toolUseId: "tool_123",
            toolName: "Bash",
            keyParam: "ls -la",
            input: { command: "ls -la" },
            result: {
              content: "file1.txt",
              isError: false,
            },
          },
        ],
        eventData: {},
      };
      const text = getVisibleGroupedMessageText(message);
      expect(text).toContain("Bash");
      expect(text).toContain("ls -la");
      expect(text).toContain("file1.txt");
    });

    it("should include system event details", () => {
      const message = {
        type: "system" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        eventData: {
          subtype: "init",
          tools: ["Bash", "Read"],
        },
      };
      const text = getVisibleGroupedMessageText(message);
      expect(text).toContain("init");
      expect(text).toContain("Bash");
      expect(text).toContain("Read");
    });

    it("should include result event details", () => {
      const message = {
        type: "result" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        eventData: {
          result: "Task completed successfully",
        },
      };
      expect(getVisibleGroupedMessageText(message)).toContain(
        "Task completed successfully",
      );
    });
  });

  describe("groupedMessageMatchesSearch", () => {
    it("should return true for empty search term", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        eventData: {},
      };
      expect(groupedMessageMatchesSearch(message, "")).toBeTruthy();
      expect(groupedMessageMatchesSearch(message, "   ")).toBeTruthy();
    });

    it("should match message type", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        eventData: {},
      };
      expect(groupedMessageMatchesSearch(message, "assistant")).toBeTruthy();
    });

    it("should match text content", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        textBefore: "Hello world",
        eventData: {},
      };
      expect(groupedMessageMatchesSearch(message, "Hello")).toBeTruthy();
      expect(groupedMessageMatchesSearch(message, "world")).toBeTruthy();
    });

    it("should be case insensitive", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        textBefore: "Hello World",
        eventData: {},
      };
      expect(groupedMessageMatchesSearch(message, "HELLO")).toBeTruthy();
      expect(groupedMessageMatchesSearch(message, "WORLD")).toBeTruthy();
    });

    it("should match tool operation details", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        toolOperations: [
          {
            toolUseId: "tool_123",
            toolName: "Bash",
            keyParam: "ls -la",
            input: { command: "ls -la" },
          },
        ],
        eventData: {},
      };
      expect(groupedMessageMatchesSearch(message, "Bash")).toBeTruthy();
      expect(groupedMessageMatchesSearch(message, "ls -la")).toBeTruthy();
    });

    it("should return false for no match", () => {
      const message = {
        type: "assistant" as const,
        sequenceNumber: 1,
        createdAt: "2024-01-01T00:00:00Z",
        textBefore: "Hello world",
        eventData: {},
      };
      expect(groupedMessageMatchesSearch(message, "nonexistent")).toBeFalsy();
    });
  });
});

function makeOp(toolName: string, id?: string): ToolOperation {
  return {
    toolUseId: id ?? `tool_${Math.random().toString(36).slice(2)}`,
    toolName,
    keyParam: `/path/${toolName.toLowerCase()}`,
    input: {},
  };
}

describe("groupConsecutiveTools", () => {
  it("should return empty array for empty input", () => {
    expect(groupConsecutiveTools([])).toStrictEqual([]);
  });

  it("should keep single operations ungrouped", () => {
    const ops = [makeOp("Read"), makeOp("Bash"), makeOp("Grep")];
    const groups = groupConsecutiveTools(ops);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.toolName).toBe("Read");
    expect(groups[0]!.operations).toHaveLength(1);
    expect(groups[1]!.toolName).toBe("Bash");
    expect(groups[2]!.toolName).toBe("Grep");
  });

  it("should group consecutive same-type operations", () => {
    const ops = [
      makeOp("Read", "r1"),
      makeOp("Read", "r2"),
      makeOp("Read", "r3"),
      makeOp("Bash", "b1"),
    ];
    const groups = groupConsecutiveTools(ops);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.toolName).toBe("Read");
    expect(groups[0]!.operations).toHaveLength(3);
    expect(groups[1]!.toolName).toBe("Bash");
    expect(groups[1]!.operations).toHaveLength(1);
  });

  it("should not group non-consecutive same-type operations", () => {
    const ops = [
      makeOp("Read", "r1"),
      makeOp("Bash", "b1"),
      makeOp("Read", "r2"),
    ];
    const groups = groupConsecutiveTools(ops);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.toolName).toBe("Read");
    expect(groups[1]!.toolName).toBe("Bash");
    expect(groups[2]!.toolName).toBe("Read");
  });

  it("should preserve operation order within groups", () => {
    const ops = [
      makeOp("Grep", "g1"),
      makeOp("Grep", "g2"),
      makeOp("Grep", "g3"),
    ];
    const groups = groupConsecutiveTools(ops);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.operations.map((o) => o.toolUseId)).toStrictEqual([
      "g1",
      "g2",
      "g3",
    ]);
  });
});
