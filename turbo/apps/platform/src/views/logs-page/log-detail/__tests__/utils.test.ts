import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTime,
  formatDuration,
  getEventTypeCounts,
  eventMatchesSearch,
  getVisibleEventText,
  scrollToMatch,
  EVENTS_CONTAINER_ID,
} from "../utils.ts";
import type { AgentEvent } from "../../../../signals/logs-page/types.ts";

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

  describe("getEventTypeCounts", () => {
    it("should count event types correctly", () => {
      const events: AgentEvent[] = [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {},
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          sequenceNumber: 2,
          eventType: "assistant",
          eventData: {},
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          sequenceNumber: 3,
          eventType: "user",
          eventData: {},
          createdAt: "2024-01-01T00:00:02Z",
        },
      ];

      const counts = getEventTypeCounts(events);
      expect(counts.get("assistant")).toBe(2);
      expect(counts.get("user")).toBe(1);
    });

    it("should return empty map for empty events", () => {
      const counts = getEventTypeCounts([]);
      expect(counts.size).toBe(0);
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
});
