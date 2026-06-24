/**
 * Tests for logs command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, event parsers, renderers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { logsCommand } from "../index";

function countOccurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

function makeAgentEvent(sequenceNumber: number) {
  return {
    sequenceNumber,
    eventType: "assistant",
    createdAt: new Date(
      Date.UTC(2024, 0, 15, 10, 30, sequenceNumber),
    ).toISOString(),
    eventData: {
      type: "assistant",
      message: {
        content: [{ type: "text", text: `message-${sequenceNumber}` }],
      },
    },
  };
}

describe("logs command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("agent events (default)", () => {
    it("should display agent events with timestamps", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: "Hello, world!" }],
                    },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Hello, world!");
    });

    it("should handle empty events", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No agent events found");
    });

    it("should auto-paginate when more events available", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            requestCount++;
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");

            if (!cursor) {
              // First page
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 1,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:00Z",
                    eventData: {
                      type: "assistant",
                      message: { content: [{ type: "text", text: "Page 1" }] },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: true,
                nextCursor: "cursor-page-2",
              });
            } else {
              // Second page
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 2,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:31:00Z",
                    eventData: {
                      type: "assistant",
                      message: { content: [{ type: "text", text: "Page 2" }] },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: false,
              });
            }
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--all"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Page 1");
      expect(logCalls).toContain("Page 2");
      expect(requestCount).toBe(2);
    });

    it("should stop pagination when target count is reached within single page", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            requestCount++;
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Event 1" }] },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Event 2" }] },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Event 3" }] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: true,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "2"]);

      // Should only make 1 request since we got enough events
      expect(requestCount).toBe(1);
      // Should display only 2 events (trimmed to target count)
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Event 1");
      expect(logCalls).toContain("Event 2");
    });

    it("should paginate across multiple pages until target count is reached", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            requestCount++;
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");

            if (!cursor) {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 1,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:00Z",
                    eventData: {
                      type: "assistant",
                      message: {
                        content: [{ type: "text", text: "Page1-Event1" }],
                      },
                    },
                  },
                  {
                    sequenceNumber: 2,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:01Z",
                    eventData: {
                      type: "assistant",
                      message: {
                        content: [{ type: "text", text: "Page1-Event2" }],
                      },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: true,
                nextCursor: "cursor-page-2",
              });
            } else {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 3,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:02Z",
                    eventData: {
                      type: "assistant",
                      message: {
                        content: [{ type: "text", text: "Page2-Event1" }],
                      },
                    },
                  },
                  {
                    sequenceNumber: 4,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:03Z",
                    eventData: {
                      type: "assistant",
                      message: {
                        content: [{ type: "text", text: "Page2-Event2" }],
                      },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: true,
              });
            }
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "3"]);

      // Should make 2 requests to collect 3 events
      expect(requestCount).toBe(2);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Page1-Event1");
      expect(logCalls).toContain("Page1-Event2");
      expect(logCalls).toContain("Page2-Event1");
      // Should NOT contain 4th event (trimmed to target count)
      expect(logCalls).not.toContain("Page2-Event2");
    });

    it("should pass server cursor to subsequent pages", async () => {
      const capturedCursorValues: (string | null)[] = [];
      const capturedSinceValues: (string | null)[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedCursorValues.push(url.searchParams.get("cursor"));
            capturedSinceValues.push(url.searchParams.get("since"));

            if (capturedCursorValues.length === 1) {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 1,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:00Z",
                    eventData: {
                      type: "assistant",
                      message: { content: [{ type: "text", text: "Event 1" }] },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: true,
                nextCursor: "sequence:desc:1",
              });
            } else {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 2,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:31:00Z",
                    eventData: {
                      type: "assistant",
                      message: { content: [{ type: "text", text: "Event 2" }] },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: false,
              });
            }
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--all"]);

      expect(capturedCursorValues).toHaveLength(2);
      expect(capturedCursorValues[0]).toBeNull();
      expect(capturedCursorValues[1]).toBe("sequence:desc:1");
      expect(capturedSinceValues).toHaveLength(2);
      expect(capturedSinceValues).toStrictEqual([null, null]);
    });

    it("should return the latest large tail across descending cursor pages", async () => {
      const capturedCursors: (string | null)[] = [];
      const capturedLimits: (string | null)[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");
            capturedCursors.push(cursor);
            capturedLimits.push(url.searchParams.get("limit"));

            if (!cursor) {
              return HttpResponse.json({
                events: Array.from({ length: 100 }, (_, index) => {
                  return makeAgentEvent(200 - index);
                }),
                framework: "claude-code",
                hasMore: true,
                nextCursor: "sequence:desc:101",
              });
            }

            return HttpResponse.json({
              events: [makeAgentEvent(100)],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "101"]);

      expect(capturedCursors).toStrictEqual([null, "sequence:desc:101"]);
      expect(capturedLimits).toStrictEqual(["100", "1"]);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("message-100");
      expect(logCalls).toContain("message-200");
      expect(logCalls).not.toContain("message-99");
      expect(logCalls.indexOf("message-100")).toBeLessThan(
        logCalls.indexOf("message-200"),
      );
    });

    it("should stop pagination when API returns empty items with hasMore true", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            requestCount++;
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");

            if (!cursor) {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 1,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:00Z",
                    eventData: {
                      type: "assistant",
                      message: { content: [{ type: "text", text: "Event 1" }] },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: true,
                nextCursor: "cursor-page-2",
              });
            } else {
              // API says hasMore but returns no items - should stop
              return HttpResponse.json({
                events: [],
                framework: "claude-code",
                hasMore: true,
              });
            }
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--all"]);

      // Should stop after 2 requests (not infinite loop)
      expect(requestCount).toBe(2);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Event 1");
    });

    it("should stop pagination when API repeats the same cursor", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            requestCount++;
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");

            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: cursor ? 2 : 1,
                  eventType: "assistant",
                  createdAt: cursor
                    ? "2024-01-15T10:31:00Z"
                    : "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [
                        { type: "text", text: cursor ? "Event 2" : "Event 1" },
                      ],
                    },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: true,
              nextCursor: "repeated-cursor",
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--all"]);

      expect(requestCount).toBe(2);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Event 1");
      expect(logCalls).toContain("Event 2");
    });

    it("should fail entirely when pagination encounters API error", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            requestCount++;
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");

            if (!cursor) {
              return HttpResponse.json({
                events: [
                  {
                    sequenceNumber: 1,
                    eventType: "assistant",
                    createdAt: "2024-01-15T10:30:00Z",
                    eventData: {
                      type: "assistant",
                      message: { content: [{ type: "text", text: "Event 1" }] },
                    },
                  },
                ],
                framework: "claude-code",
                hasMore: true,
                nextCursor: "cursor-page-2",
              });
            } else {
              // Second page fails
              return HttpResponse.json(
                { error: { message: "Server error", code: "ERROR" } },
                { status: 500 },
              );
            }
          },
        ),
      );

      await expect(async () => {
        await logsCommand.parseAsync(["node", "cli", "run-123", "--all"]);
      }).rejects.toThrow("process.exit called");

      expect(requestCount).toBe(2);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Server error"),
      );
    });

    it("should handle paired tool_use and tool_result events", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            // API returns events in desc order (newest first)
            // They get reversed in showAgentEvents for chronological display
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 2,
                  eventType: "user",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "user",
                    message: {
                      content: [
                        {
                          type: "tool_result",
                          tool_use_id: "tool-123",
                          content: "File content here",
                        },
                      ],
                    },
                  },
                },
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [
                        {
                          type: "tool_use",
                          name: "Read",
                          id: "tool-123",
                          input: { file_path: "/test/file.ts" },
                        },
                      ],
                    },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Read");
      expect(logCalls).toContain("File content here");
    });

    it("should preserve falsy primitive event values in rendered output", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [
                        {
                          type: "tool_use",
                          name: "Bash",
                          id: 0,
                          input: { command: "printf false" },
                        },
                      ],
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "user",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "user",
                    message: {
                      content: [
                        {
                          type: "tool_result",
                          tool_use_id: 0,
                          content: false,
                        },
                      ],
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: 0 }],
                    },
                  },
                },
                {
                  sequenceNumber: 4,
                  eventType: "result",
                  createdAt: "2024-01-15T10:30:03Z",
                  eventData: {
                    type: "result",
                    is_error: true,
                    result: false,
                    duration_ms: 0,
                    num_turns: 1,
                    total_cost_usd: 0,
                    usage: {},
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("printf false");
      expect(logCalls).toContain("false");
      expect(logCalls).toContain("● 0");
      expect(logCalls).toContain("Error: false");
      expect(logCalls).not.toContain("Done");
    });

    it("should not pair malformed tool results with tool uses that lack ids", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [
                        {
                          type: "tool_use",
                          name: "Bash",
                          input: { command: "echo no-id" },
                        },
                      ],
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "user",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "user",
                    message: {
                      content: [
                        {
                          type: "tool_result",
                          content: "orphan output",
                        },
                      ],
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [
                        { type: "text", text: "after malformed result" },
                      ],
                    },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("echo no-id");
      expect(logCalls).toContain("after malformed result");
      expect(logCalls).not.toContain("orphan output");
    });

    it("should handle tool_result events", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "result",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "result",
                    result: "Tool execution complete",
                    tool_use_id: "tool-123",
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      // Result events are handled without error
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should handle unknown event types gracefully", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "unknown_type",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "unknown_type",
                    someData: "test",
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      // Should not crash on unknown event types
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should handle events with empty content", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      // Should handle empty content gracefully
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should handle malformed event data", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "unknown",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: null,
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      // Should handle malformed data gracefully
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("codex framework events", () => {
    it("should render thread.started, agent_message, and turn.completed", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "item_1",
                      type: "agent_message",
                      text: "Codex says hello",
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "turn.completed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "turn.completed",
                    turn: {
                      usage: {
                        input_tokens: 24763,
                        cached_input_tokens: 24448,
                        output_tokens: 122,
                      },
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Codex Started");
      expect(logCalls).toContain("0199a213-81c0-7800-8aa1-bbab2a035a53");
      expect(logCalls).toContain("Codex says hello");
      expect(logCalls).toContain("Codex Completed");
      expect(logCalls).toContain("input=24k output=122");
    });

    it("should render command_execution as Bash tool with output", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "cmd_1",
                      type: "command_execution",
                      command: "bash -lc ls",
                      status: "in_progress",
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "cmd_1",
                      type: "command_execution",
                      command: "bash -lc ls",
                      exit_code: 0,
                      output: "README.md\nsrc",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Bash");
      expect(logCalls).toContain("bash -lc ls");
      expect(logCalls).toContain("README.md");
    });

    it("should render completed-only Codex tool events", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "cmd_only",
                      type: "command_execution",
                      command: "echo completed-only",
                      exit_code: 0,
                      aggregated_output: "  completed output  \n",
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "edit_only",
                      type: "file_edit",
                      path: "/workspace/src/edge.ts",
                      diff: "-before  \n+ after",
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "read_only",
                      type: "file_read",
                      path: "/workspace/package.json",
                      status: "completed",
                      output: "  file body  \n",
                    },
                  },
                },
                {
                  sequenceNumber: 4,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:03Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "read_blank",
                      type: "file_read",
                      path: "/workspace/blank.txt",
                      status: "completed",
                      output: "   ",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Bash");
      expect(logCalls).toContain("echo completed-only");
      expect(logCalls).toContain("  completed output  ");
      expect(logCalls).toContain("Edit");
      expect(logCalls).toContain("/workspace/src/edge.ts");
      expect(logCalls).toContain("-before  ");
      expect(logCalls).toContain("+ after");
      expect(logCalls).toContain("Read");
      expect(logCalls).toContain("/workspace/package.json");
      expect(logCalls).toContain("  file body  ");
      expect(logCalls).toContain("/workspace/blank.txt");
      expect(logCalls).not.toContain("(empty)");
    });

    it("should mark command_execution with non-zero exit_code as error", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "cmd_1",
                      type: "command_execution",
                      command: "ls /nonexistent",
                      status: "in_progress",
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "cmd_1",
                      type: "command_execution",
                      command: "ls /nonexistent",
                      exit_code: 1,
                      output: "ls: cannot access '/nonexistent'",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("ls /nonexistent");
      expect(logCalls).toContain("✗");
      expect(logCalls).toContain("ls: cannot access '/nonexistent'");
    });

    it("should render file_edit, file_write, and file_read tools", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "edit_1",
                      type: "file_edit",
                      path: "/workspace/src/main.ts",
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "edit_1",
                      type: "file_edit",
                      path: "/workspace/src/main.ts",
                      diff: "-old\n+new",
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "write_1",
                      type: "file_write",
                      path: "/workspace/README.md",
                      diff: "",
                    },
                  },
                },
                {
                  sequenceNumber: 4,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:03Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "write_1",
                      type: "file_write",
                      path: "/workspace/README.md",
                    },
                  },
                },
                {
                  sequenceNumber: 5,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:04Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "read_1",
                      type: "file_read",
                      path: "/workspace/package.json",
                      output: "",
                    },
                  },
                },
                {
                  sequenceNumber: 6,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:05Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "read_1",
                      type: "file_read",
                      path: "/workspace/package.json",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Edit");
      expect(logCalls).toContain("/workspace/src/main.ts");
      expect(logCalls).toContain("-old");
      expect(logCalls).toContain("+new");
      expect(logCalls).toContain("Write");
      expect(logCalls).toContain("/workspace/README.md");
      expect(logCalls).toContain("File operation completed");
      expect(logCalls).toContain("Read");
      expect(logCalls).toContain("/workspace/package.json");
      expect(logCalls).toContain("File read completed");
    });

    it("should render reasoning items with [thinking] prefix", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "reason_1",
                      type: "reasoning",
                      text: "Considering the trade-offs",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("[thinking] Considering the trade-offs");
    });

    it("should render file_change as a [files] text event", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "change_1",
                      type: "file_change",
                      changes: [
                        { kind: "add", path: "/workspace/new.ts" },
                        { kind: "modify", path: "/workspace/existing.ts" },
                        { kind: "delete", path: "/workspace/old.ts" },
                      ],
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("[files]");
      expect(logCalls).toContain("Created: /workspace/new.ts");
      expect(logCalls).toContain("Modified: /workspace/existing.ts");
      expect(logCalls).toContain("Deleted: /workspace/old.ts");
    });

    it("should render turn.failed as Codex Failed", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "turn.failed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.failed",
                    error: "Rate limit exceeded",
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Codex Failed");
    });

    it("should render truncated Codex result events with the Codex label", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 2,
                  eventType: "turn.failed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.failed",
                    error: "Rate limit exceeded",
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "1"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Codex Failed");
      expect(logCalls).not.toContain("Agent Failed");
    });

    it("should render top-level error event as a failure result", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "error",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "error",
                    message: "API connection failed",
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Codex Failed");
    });

    it("should collapse paired top-level error and turn.failed into one Codex failure", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "error",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "error",
                    message: "API connection failed",
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "turn.failed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "turn.failed",
                    error: "Rate limit exceeded",
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(countOccurrences(logCalls, "Codex Failed")).toBe(1);
    });

    it("should collapse paired Codex error and turn.failed when default tail order is descending", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 3,
                  eventType: "turn.failed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "turn.failed",
                    error: "Rate limit exceeded",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "error",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "error",
                    message: "API connection failed",
                  },
                },
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(countOccurrences(logCalls, "Codex Failed")).toBe(1);
    });

    it("should render failed turn.completed with nested error details", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "turn.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.completed",
                    thread_id: "thread-x",
                    turn: {
                      id: "turn-1",
                      status: "failed",
                      duration_ms: 1200,
                      error: {
                        message: "selected model is at capacity",
                        additional_details: "retry later",
                        codex_error_info: "serverOverloaded",
                      },
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Codex Failed");
      expect(logCalls).toContain("selected model is at capacity");
      expect(logCalls).toContain("retry later");
      expect(logCalls).not.toContain("[object Object]");
    });

    it("should ignore null turn errors when rendering failed turn.completed", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "turn.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.completed",
                    thread_id: "thread-x",
                    message: "request aborted before shutdown",
                    turn: {
                      id: "turn-1",
                      status: "failed",
                      error: null,
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Codex Failed");
      expect(logCalls).toContain("request aborted before shutdown");
      expect(logCalls).not.toContain("Error: null");
    });

    it("should collapse same-turn Codex error and failed turn.completed while preserving details", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:29:59Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "error",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "error",
                    turn_id: "turn-1",
                    message: "API connection failed",
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "turn.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.completed",
                    turn: {
                      id: "turn-1",
                      status: "failed",
                      error: {
                        message: "Rate limit exceeded",
                      },
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(countOccurrences(logCalls, "Codex Failed")).toBe(1);
      expect(logCalls).toContain("API connection failed");
      expect(logCalls).toContain("Rate limit exceeded");
    });

    it("should not collapse Codex failures from different turns", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "thread.started",
                  createdAt: "2024-01-15T10:29:59Z",
                  eventData: {
                    type: "thread.started",
                    thread_id: "thread-x",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "error",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "error",
                    turn_id: "turn-1",
                    message: "First turn failed",
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "turn.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.completed",
                    turn: {
                      id: "turn-2",
                      status: "failed",
                      error: {
                        message: "Second turn failed",
                      },
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(countOccurrences(logCalls, "Codex Failed")).toBe(2);
      expect(logCalls).toContain("First turn failed");
      expect(logCalls).toContain("Second turn failed");
    });

    it("should render warnings, plans, and generic completed items", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "warning",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "warning",
                    message: "configuration warning",
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "turn.plan.updated",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.plan.updated",
                    explanation: "working",
                    plan: [
                      { step: "read files", status: "completed" },
                      { step: "write fix", status: "in_progress" },
                    ],
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "plan-1",
                      type: "plan",
                      text: "Review implementation",
                    },
                  },
                },
                {
                  sequenceNumber: 4,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:03Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "mcp-1",
                      type: "mcp_tool_call",
                      status: "completed",
                      server: "github",
                      tool: "listIssues",
                      arguments: { owner: "vm0-ai" },
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("[warning] configuration warning");
      expect(logCalls).toContain("[plan]");
      expect(logCalls).toContain("working");
      expect(logCalls).toContain("completed: read files");
      expect(logCalls).toContain("Review implementation");
      expect(logCalls).toContain("[item] mcp_tool_call");
      expect(logCalls).toContain("server=github");
      expect(logCalls).not.toContain("Codex Failed");
      expect(logCalls).not.toContain("[object Object]");
    });

    it("should respect failed and declined statuses and flush pending tools", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "cmd-failed",
                      type: "command_execution",
                      command: "deploy",
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "cmd-failed",
                      type: "command_execution",
                      status: "failed",
                      aggregated_output: "permission denied",
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "read-declined",
                      type: "file_read",
                      path: "/workspace/private.txt",
                    },
                  },
                },
                {
                  sequenceNumber: 4,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:03Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "read-declined",
                      type: "file_read",
                      status: "declined",
                    },
                  },
                },
                {
                  sequenceNumber: 5,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:04Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "cmd-pending",
                      type: "command_execution",
                      command: "sleep 10",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("deploy");
      expect(logCalls).toContain("permission denied");
      expect(logCalls).toContain("File read declined");
      expect(logCalls).toContain("sleep 10");
      expect(countOccurrences(logCalls, "✗")).toBeGreaterThanOrEqual(2);
    });

    it("should keep delayed Codex tool results after intervening text", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "item.started",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "item.started",
                    item: {
                      id: "cmd-delayed",
                      type: "command_execution",
                      command: "printf delayed",
                    },
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "message-1",
                      type: "agent_message",
                      text: "continuing while command runs",
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "cmd-delayed",
                      type: "command_execution",
                      status: "completed",
                      aggregated_output: "delayed output",
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      const commandIndex = logCalls.indexOf("printf delayed");
      const textIndex = logCalls.indexOf("continuing while command runs");
      const outputIndex = logCalls.indexOf("delayed output");
      expect(commandIndex).toBeGreaterThan(-1);
      expect(textIndex).toBeGreaterThan(commandIndex);
      expect(outputIndex).toBeGreaterThan(textIndex);
    });

    it("should tolerate malformed optional Codex payload fields", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "malformed",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: 123,
                  },
                },
                {
                  sequenceNumber: 2,
                  eventType: "turn.completed",
                  createdAt: "2024-01-15T10:30:01Z",
                  eventData: {
                    type: "turn.completed",
                    turn: {
                      id: "turn-1",
                      status: "failed",
                      error: {
                        code: "server_error",
                        additional_details: "retry later",
                      },
                    },
                  },
                },
                {
                  sequenceNumber: 3,
                  eventType: "item.completed",
                  createdAt: "2024-01-15T10:30:02Z",
                  eventData: {
                    type: "item.completed",
                    item: {
                      id: "change-1",
                      type: "file_change",
                      changes: [
                        null,
                        { kind: { type: "modify" }, path: 12 },
                        { kind: "modify", path: "/workspace/ok.ts" },
                      ],
                    },
                  },
                },
              ],
              framework: "codex",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "100"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(mockExit).not.toHaveBeenCalled();
      expect(logCalls).toContain("server_error");
      expect(logCalls).toContain("retry later");
      expect(logCalls).toContain("Modified: /workspace/ok.ts");
      expect(logCalls).not.toContain("[object Object]");
    });
  });

  describe("system log", () => {
    it("should display system log with --system flag", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/system-log",
          () => {
            return HttpResponse.json({
              systemLog: "System started\nRunning tests\nCompleted",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--system"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("System started");
      expect(logCalls).toContain("Completed");
    });

    it("should handle empty system log", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/system-log",
          () => {
            return HttpResponse.json({
              systemLog: "",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--system"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No system log found");
    });

    it("should paginate system log pages with server cursor", async () => {
      const capturedCursors: (string | null)[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/system-log",
          ({ request }) => {
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");
            capturedCursors.push(cursor);

            if (!cursor) {
              return HttpResponse.json({
                systemLog: "first page\n",
                hasMore: true,
                nextCursor: "time:desc:1",
              });
            }

            return HttpResponse.json({
              systemLog: "second page\n",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync([
        "node",
        "cli",
        "run-123",
        "--system",
        "--all",
      ]);

      expect(capturedCursors).toStrictEqual([null, "time:desc:1"]);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("first page");
      expect(logCalls).toContain("second page");
    });

    it("should continue system log pagination past empty pages with cursors", async () => {
      const capturedCursors: (string | null)[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/system-log",
          ({ request }) => {
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");
            capturedCursors.push(cursor);

            if (!cursor) {
              return HttpResponse.json({
                systemLog: "",
                hasMore: true,
                nextCursor: "time:desc:1",
              });
            }

            return HttpResponse.json({
              systemLog: "second page\n",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync([
        "node",
        "cli",
        "run-123",
        "--system",
        "--all",
      ]);

      expect(capturedCursors).toStrictEqual([null, "time:desc:1"]);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("second page");
      expect(logCalls).not.toContain("No system log found");
    });

    it("should not consume limited system log batches on empty pages with cursors", async () => {
      const capturedCursors: (string | null)[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/system-log",
          ({ request }) => {
            const url = new URL(request.url);
            const cursor = url.searchParams.get("cursor");
            capturedCursors.push(cursor);

            if (!cursor) {
              return HttpResponse.json({
                systemLog: "",
                hasMore: true,
                nextCursor: "time:desc:1",
              });
            }

            return HttpResponse.json({
              systemLog: "visible page\n",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--system"]);

      expect(capturedCursors).toStrictEqual([null, "time:desc:1"]);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("visible page");
      expect(logCalls).not.toContain("No system log found");
    });
  });

  describe("metrics", () => {
    it("should display metrics with --metrics flag", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/metrics",
          () => {
            return HttpResponse.json({
              metrics: [
                {
                  ts: "2024-01-15T10:30:00Z",
                  cpu: 45.5,
                  mem_used: 1073741824,
                  mem_total: 4294967296,
                  disk_used: 10737418240,
                  disk_total: 107374182400,
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--metrics"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("CPU:");
      expect(logCalls).toContain("45.5%");
      expect(logCalls).toContain("Mem:");
      expect(logCalls).toContain("Disk:");
    });

    it("should handle empty metrics", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/metrics",
          () => {
            return HttpResponse.json({
              metrics: [],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--metrics"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No metrics found");
    });
  });

  describe("network logs", () => {
    it("should display network logs with --network flag", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  action: "ALLOW",
                  method: "GET",
                  status: 200,
                  latency_ms: 150,
                  request_size: 1024,
                  response_size: 2048,
                  browser_user_agent: true,
                  url: "https://api.example.com/data",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("GET");
      expect(logCalls).toContain("200");
      expect(logCalls).toContain("150ms");
      expect(logCalls).toContain("[browser]");
    });

    it("should display DENY action without HTTP details", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  action: "DENY",
                  method: "POST",
                  url: "https://api.stripe.com/v1/charges",
                  firewall_name: "stripe",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("DENY");
      expect(logCalls).toContain("POST");
      expect(logCalls).toContain("[stripe]");
      expect(logCalls).not.toContain("200");
      expect(logCalls).not.toContain("ms");
    });

    it("should display BLOCK action as a local block", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  type: "http",
                  action: "BLOCK",
                  method: "POST",
                  status: 424,
                  latency_ms: 4,
                  host: "api.example.com",
                  port: 443,
                  url: "",
                  firewall_name: "example",
                  firewall_error: "connector_not_configured",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("BLOCK");
      expect(logCalls).toContain("POST");
      expect(logCalls).toContain("api.example.com:443");
      expect(logCalls).toContain("[example]");
      expect(logCalls).toContain("connector_not_configured");
      expect(logCalls).not.toContain("424");
      expect(logCalls).not.toContain("4ms");
    });

    it("should display BLOCK before protocol-specific formatting", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  type: "tcp",
                  action: "BLOCK",
                  host: "db.internal",
                  port: 5432,
                  firewall_name: "database",
                  firewall_error: "connector_not_configured",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("BLOCK");
      expect(logCalls).toContain("db.internal:5432");
      expect(logCalls).toContain("[database]");
      expect(logCalls).toContain("connector_not_configured");
      expect(logCalls).not.toContain("TCP");
    });

    it("should display ERROR action with auth failed suffix", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  action: "ALLOW",
                  method: "GET",
                  status: 502,
                  latency_ms: 5,
                  request_size: 0,
                  response_size: 100,
                  url: "https://api.stripe.com/v1/users",
                  firewall_name: "stripe",
                  firewall_error: "auth_failed",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("502");
      expect(logCalls).toContain("5ms");
      expect(logCalls).toContain("[stripe]");
      expect(logCalls).toContain("auth_failed");
    });

    it("should display connector diagnostic fields", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  action: "ALLOW",
                  method: "POST",
                  status: 502,
                  latency_ms: 8,
                  request_size: 0,
                  response_size: 192,
                  url: "https://fal.run/models/example",
                  firewall_name: "fal",
                  firewall_error: "connector_not_configured_for_run",
                  connector_diagnostic_type: "fal",
                  connector_diagnostic_reason: "not_configured_for_run",
                  connector_diagnostic_env_names: ["FAL_TOKEN"],
                  connector_diagnostic_base: "https://fal.run",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("connector diagnostic");
      expect(logCalls).toContain("fal");
      expect(logCalls).toContain("not_configured_for_run");
      expect(logCalls).toContain("FAL_TOKEN");
      expect(logCalls).toContain("https://fal.run");
    });

    it("should display TCP connection logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  type: "tcp",
                  host: "redis.example.com",
                  port: 6379,
                  latency_ms: 5000,
                  request_size: 1024,
                  response_size: 2048,
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("TCP");
      expect(logCalls).toContain("redis.example.com:6379");
      expect(logCalls).toContain("5000ms");
    });

    it("should display TCP error logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  type: "tcp",
                  host: "db.example.com",
                  port: 5432,
                  latency_ms: 3000,
                  request_size: 0,
                  response_size: 0,
                  error: "connection reset by peer",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("TCP");
      expect(logCalls).toContain("db.example.com:5432");
      expect(logCalls).toContain("connection reset by peer");
    });

    it("should display DNS result logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  type: "dns",
                  host: "api.github.com",
                  port: 53,
                  dns_event: "reply",
                  dns_result: "140.82.121.4",
                  dns_serial: "42",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("DNS");
      expect(logCalls).toContain("api.github.com:53");
      expect(logCalls).toContain("140.82.121.4");
    });

    it("should handle empty network logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No network logs found");
    });
  });

  describe("option validation", () => {
    it("should exit with error when multiple log types specified", async () => {
      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--system",
          "--metrics",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("mutually exclusive"),
      );
    });

    it("should exit with error when --tail and --head specified together", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--tail",
          "10",
          "--head",
          "10",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("mutually exclusive"),
      );
    });

    it("should exit with error when --tail and --all specified together", async () => {
      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--tail",
          "10",
          "--all",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("mutually exclusive"),
      );
    });

    it("should exit with error when --head and --all specified together", async () => {
      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--head",
          "10",
          "--all",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("mutually exclusive"),
      );
    });

    it("should exit with error when --tail is not a positive integer", async () => {
      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--tail",
          "abc",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Option --tail must be a positive integer"),
      );

      mockExit.mockClear();
      mockConsoleError.mockClear();

      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--tail",
          "000",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Option --tail must be a positive integer"),
      );

      mockExit.mockClear();
      mockConsoleError.mockClear();

      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--tail",
          "1e2",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Option --tail must be a positive integer"),
      );
    });

    it("should exit with error when --head is not a positive integer", async () => {
      await expect(async () => {
        await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "0"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Option --head must be a positive integer"),
      );
    });
  });

  describe("error handling", () => {
    it("should handle not authenticated error", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json(
              { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
              { status: 401 },
            );
          },
        ),
      );

      await expect(async () => {
        await logsCommand.parseAsync(["node", "cli", "run-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should handle run not found error", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json(
              { error: { message: "Run not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await logsCommand.parseAsync(["node", "cli", "nonexistent-run"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run not found"),
      );
    });

    it("should handle invalid time format error", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--since",
          "invalid-time",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid time format"),
      );
    });

    it("should reject invalid calendar dates for --since", async () => {
      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--since",
          "2024-02-30T00:00:00Z",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid time format"),
      );
    });

    it("should reject out-of-range Unix timestamps for --since", async () => {
      await expect(async () => {
        await logsCommand.parseAsync([
          "node",
          "cli",
          "run-123",
          "--since",
          "8640000000000001",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid time format"),
      );
    });

    it("should handle generic API error", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json(
              { error: { message: "Internal server error", code: "ERROR" } },
              { status: 500 },
            );
          },
        ),
      );

      await expect(async () => {
        await logsCommand.parseAsync(["node", "cli", "run-123"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
    });
  });

  describe("platform URL", () => {
    it("should display platform URL after agent events", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: {
                      content: [{ type: "text", text: "Hello" }],
                    },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("View on platform:");
      expect(logCalls).toContain("http://localhost:3001/logs/run-123");
    });

    it("should NOT display platform URL for system logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/system-log",
          () => {
            return HttpResponse.json({
              systemLog: "System log content",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--system"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("View on platform:");
    });

    it("should NOT display platform URL for metrics", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/metrics",
          () => {
            return HttpResponse.json({
              metrics: [
                {
                  ts: "2024-01-15T10:30:00Z",
                  cpu: 45.5,
                  mem_used: 1073741824,
                  mem_total: 4294967296,
                  disk_used: 10737418240,
                  disk_total: 107374182400,
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--metrics"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("View on platform:");
    });

    it("should NOT display platform URL for network logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  action: "ALLOW",
                  method: "GET",
                  status: 200,
                  host: "api.example.com",
                  port: 443,
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("View on platform:");
    });

    it("should transform www.vm0.ai to app.vm0.ai", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");

      server.use(
        http.get(
          "https://www.vm0.ai/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Test" }] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/logs/run-123");
    });

    it("should not double-prefix when input URL already has app subdomain", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");

      server.use(
        http.get(
          "https://app.vm0.ai/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Test" }] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/logs/run-123");
      expect(logCalls).not.toContain("app.app.");
    });

    it("should replace platform subdomain with app", async () => {
      vi.stubEnv("VM0_API_URL", "https://platform.vm0.ai");

      server.use(
        http.get(
          "https://platform.vm0.ai/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Test" }] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/logs/run-123");
      expect(logCalls).not.toContain("app.platform.");
    });

    it("should transform vm7.ai:8443 to app.vm7.ai:8443", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm7.ai:8443");

      server.use(
        http.get(
          "https://www.vm7.ai:8443/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "assistant",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "assistant",
                    message: { content: [{ type: "text", text: "Test" }] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm7.ai:8443/logs/run-123");
    });
  });

  describe("time and limit options", () => {
    it("should pass --since option to API as sinceTime", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedQuery = Object.fromEntries(url.searchParams);
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--since", "5m"]);

      expect(capturedQuery?.sinceTime).toBeDefined();
      expect(capturedQuery?.since).toBeUndefined();
    });

    it("should pass --tail option to API with desc order", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedQuery = Object.fromEntries(url.searchParams);
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "020"]);

      // Small finite requests only fetch the remaining target count.
      expect(capturedQuery?.limit).toBe("20");
      expect(capturedQuery?.order).toBe("desc");
    });

    it("should pass --head option to API with asc order", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedQuery = Object.fromEntries(url.searchParams);
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "010"]);

      // Small finite requests only fetch the remaining target count.
      expect(capturedQuery?.limit).toBe("10");
      expect(capturedQuery?.order).toBe("asc");
    });

    it("should use page limit of 100 for --tail 500", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedQuery = Object.fromEntries(url.searchParams);
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "500"]);

      // Per-page limit is capped at 100
      expect(capturedQuery?.limit).toBe("100");
    });

    it("should use --all flag to fetch all entries", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedQuery = Object.fromEntries(url.searchParams);
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--all"]);

      // --all uses page limit of 100 and fetches all pages
      expect(capturedQuery?.limit).toBe("100");
      expect(capturedQuery?.order).toBe("desc");
    });

    it("should combine --all with --since", async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedQuery = Object.fromEntries(url.searchParams);
            return HttpResponse.json({
              events: [],
              framework: "claude-code",
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync([
        "node",
        "cli",
        "run-123",
        "--all",
        "--since",
        "5m",
      ]);

      expect(capturedQuery?.sinceTime).toBeDefined();
      expect(capturedQuery?.since).toBeUndefined();
      expect(capturedQuery?.limit).toBe("100");
    });
  });
});
