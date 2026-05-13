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
            const since = url.searchParams.get("since");

            if (!since) {
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
            const since = url.searchParams.get("since");

            if (!since) {
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

    it("should pass correct since cursor to subsequent pages", async () => {
      const capturedSinceValues: (string | null)[] = [];
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            const url = new URL(request.url);
            capturedSinceValues.push(url.searchParams.get("since"));

            if (capturedSinceValues.length === 1) {
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

      expect(capturedSinceValues).toHaveLength(2);
      expect(capturedSinceValues[0]).toBeNull(); // First page has no since
      // Second page should have since = timestamp of last event from first page
      expect(capturedSinceValues[1]).toBe(
        new Date("2024-01-15T10:30:00Z").getTime().toString(),
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
            const since = url.searchParams.get("since");

            if (!since) {
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

    it("should fail entirely when pagination encounters API error", async () => {
      let requestCount = 0;
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          ({ request }) => {
            requestCount++;
            const url = new URL(request.url);
            const since = url.searchParams.get("since");

            if (!since) {
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
                    usage: {
                      input_tokens: 24763,
                      cached_input_tokens: 24448,
                      output_tokens: 122,
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
      expect(logCalls).toContain("Write");
      expect(logCalls).toContain("/workspace/README.md");
      expect(logCalls).toContain("Read");
      expect(logCalls).toContain("/workspace/package.json");
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
              systemLog: null,
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--system"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No system log found");
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
    it("should pass --since option to API", async () => {
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

      expect(capturedQuery?.since).toBeDefined();
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

      await logsCommand.parseAsync(["node", "cli", "run-123", "--tail", "20"]);

      // Per-page limit is always PAGE_LIMIT (100), targetCount is 20
      expect(capturedQuery?.limit).toBe("100");
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

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "10"]);

      // Per-page limit is always PAGE_LIMIT (100), targetCount is 10
      expect(capturedQuery?.limit).toBe("100");
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

      expect(capturedQuery?.since).toBeDefined();
      expect(capturedQuery?.limit).toBe("100");
    });
  });
});
