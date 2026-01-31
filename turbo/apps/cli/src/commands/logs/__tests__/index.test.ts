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
    vi.unstubAllEnvs();
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

    it("should display hasMore hint when more events available", async () => {
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
                    message: { content: [{ type: "text", text: "Test" }] },
                  },
                },
              ],
              framework: "claude-code",
              hasMore: true,
            });
          },
        ),
      );

      await logsCommand.parseAsync(["node", "cli", "run-123"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Use --tail to see more");
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
        expect.stringContaining("--tail and --head are mutually exclusive"),
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

    it("should pass --tail option to API as limit", async () => {
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

      await logsCommand.parseAsync(["node", "cli", "run-123", "--head", "10"]);

      expect(capturedQuery?.limit).toBe("10");
      expect(capturedQuery?.order).toBe("asc");
    });

    it("should cap limit at 100", async () => {
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

      expect(capturedQuery?.limit).toBe("100");
    });
  });
});
