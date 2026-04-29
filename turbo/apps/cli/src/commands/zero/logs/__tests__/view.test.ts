/**
 * Tests for zero logs view (parent command action)
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: zeroLogsCommand.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, event parsers, renderers, pagination
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroLogsCommand } from "../index";

function makeEvent(
  sequenceNumber: number,
  text: string,
  createdAt = "2024-01-15T10:30:00Z",
) {
  return {
    sequenceNumber,
    eventType: "assistant",
    createdAt,
    eventData: {
      type: "assistant",
      message: {
        content: [{ type: "text", text }],
      },
    },
  };
}

const RUN_ID = "abc12345-1234-1234-1234-123456789abc";

describe("zero logs view command", () => {
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

  it("should display agent events with timestamps", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json({
            events: [
              makeEvent(1, "Starting task...", "2024-01-15T10:30:00Z"),
              makeEvent(2, "Task completed.", "2024-01-15T10:30:05Z"),
            ],
            hasMore: false,
          });
        },
      ),
    );

    await zeroLogsCommand.parseAsync(["node", "cli", RUN_ID, "--all"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Starting task");
    expect(logCalls).toContain("Task completed");
  });

  it("should handle empty events", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
          });
        },
      ),
    );

    await zeroLogsCommand.parseAsync(["node", "cli", RUN_ID]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No agent events found");
  });

  it("should respect --tail option", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({
            events: [
              makeEvent(3, "Event 3", "2024-01-15T10:30:03Z"),
              makeEvent(2, "Event 2", "2024-01-15T10:30:02Z"),
              makeEvent(1, "Event 1", "2024-01-15T10:30:01Z"),
            ],
            hasMore: false,
          });
        },
      ),
    );

    await zeroLogsCommand.parseAsync(["node", "cli", RUN_ID, "--tail", "2"]);

    expect(capturedUrl?.searchParams.get("order")).toBe("desc");
    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    // Should show events (tail 2 from 3 events)
    expect(logCalls).toContain("Event");
  });

  it("should respect --head option", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({
            events: [
              makeEvent(1, "First event", "2024-01-15T10:30:01Z"),
              makeEvent(2, "Second event", "2024-01-15T10:30:02Z"),
            ],
            hasMore: false,
          });
        },
      ),
    );

    await zeroLogsCommand.parseAsync(["node", "cli", RUN_ID, "--head", "2"]);

    expect(capturedUrl?.searchParams.get("order")).toBe("asc");
  });

  it("should reject mutually exclusive options", async () => {
    await expect(
      zeroLogsCommand.parseAsync([
        "node",
        "cli",
        RUN_ID,
        "--tail",
        "5",
        "--head",
        "5",
      ]),
    ).rejects.toThrow("process.exit called");

    const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorCalls).toContain("mutually exclusive");
  });

  it("should reject non-UUID run ID", async () => {
    await expect(
      zeroLogsCommand.parseAsync(["node", "cli", "6af7eece"]),
    ).rejects.toThrow("process.exit called");

    const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorCalls).toContain("Invalid run ID");
    expect(errorCalls).toContain("zero logs list");
  });

  it("should render codex framework events", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json({
            events: [
              {
                sequenceNumber: 1,
                eventType: "thread.started",
                createdAt: "2024-01-15T10:30:00Z",
                eventData: {
                  type: "thread.started",
                  thread_id: "thread-zero-1",
                },
              },
              {
                sequenceNumber: 2,
                eventType: "item.completed",
                createdAt: "2024-01-15T10:30:01Z",
                eventData: {
                  type: "item.completed",
                  item: {
                    id: "msg_1",
                    type: "agent_message",
                    text: "Codex zero output",
                  },
                },
              },
              {
                sequenceNumber: 3,
                eventType: "turn.completed",
                createdAt: "2024-01-15T10:30:02Z",
                eventData: {
                  type: "turn.completed",
                  usage: { input_tokens: 100, output_tokens: 20 },
                },
              },
            ],
            framework: "codex",
            hasMore: false,
          });
        },
      ),
    );

    await zeroLogsCommand.parseAsync(["node", "cli", RUN_ID, "--head", "100"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Codex Started");
    expect(logCalls).toContain("Codex zero output");
    expect(logCalls).toContain("Codex Completed");
  });

  it("should handle authentication error", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        },
      ),
    );

    await expect(
      zeroLogsCommand.parseAsync(["node", "cli", RUN_ID]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
  });
});
