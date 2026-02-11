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

describe("logs command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
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
        expect.stringContaining("Failed to fetch logs"),
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
    it("should use CodexEventRenderer for codex provider", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 1,
                  eventType: "message",
                  createdAt: "2024-01-15T10:30:00Z",
                  eventData: {
                    type: "message",
                    message: "Codex message",
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

      // Should not crash with codex events
      expect(mockExit).not.toHaveBeenCalled();
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
    it("should display SNI network logs with --network flag", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  mode: "sni",
                  host: "api.example.com",
                  port: 443,
                  action: "ALLOW",
                  rule_matched: "allowlist",
                },
              ],
              hasMore: false,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123", "--network"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("api.example.com");
      expect(logCalls).toContain("443");
    });

    it("should display MITM network logs", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/runs/:id/telemetry/network",
          () => {
            return HttpResponse.json({
              networkLogs: [
                {
                  timestamp: "2024-01-15T10:30:00Z",
                  mode: "mitm",
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
      expect(logCalls).toContain("experimental_firewall");
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
        expect.stringContaining("Failed to fetch logs"),
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
                  mode: "sni",
                  host: "api.example.com",
                  port: 443,
                  action: "ALLOW",
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

    it("should transform www.vm0.ai to platform.vm0.ai", async () => {
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
      expect(logCalls).toContain("https://platform.vm0.ai/logs/run-123");
    });

    it("should transform vm7.ai:8443 to platform.vm7.ai:8443", async () => {
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
      expect(logCalls).toContain("https://platform.vm7.ai:8443/logs/run-123");
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
