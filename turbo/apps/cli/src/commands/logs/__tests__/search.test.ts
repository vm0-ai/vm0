/**
 * Tests for logs search subcommand
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: searchCommand.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, event parsers, renderers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { searchCommand } from "../search";

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

describe("logs search command", () => {
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

  it("should display search results grouped by run", async () => {
    server.use(
      http.get("http://localhost:3000/api/logs/search", () => {
        return HttpResponse.json({
          results: [
            {
              runId: "abc12345-1234-1234-1234-123456789abc",
              agentName: "my-agent",
              matchedEvent: makeEvent(3, "Build failed: OOM killed"),
              contextBefore: [],
              contextAfter: [],
            },
          ],
          hasMore: false,
        });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "OOM"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("abc12345");
    expect(logCalls).toContain("my-agent");
    expect(logCalls).toContain("OOM killed");
  });

  it("should pass context params to API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/logs/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "error", "-C", "3"]);

    expect(capturedUrl?.searchParams.get("keyword")).toBe("error");
    expect(capturedUrl?.searchParams.get("before")).toBe("3");
    expect(capturedUrl?.searchParams.get("after")).toBe("3");
  });

  it("should pass -A and -B independently", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/logs/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync([
      "node",
      "cli",
      "error",
      "-A",
      "5",
      "-B",
      "2",
    ]);

    expect(capturedUrl?.searchParams.get("before")).toBe("2");
    expect(capturedUrl?.searchParams.get("after")).toBe("5");
  });

  it("should pass --agent as agentId and --run filters to API", async () => {
    let capturedUrl: URL | undefined;
    const agentId = "550e8400-e29b-41d4-a716-446655440001";
    server.use(
      http.get("http://localhost:3000/api/logs/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync([
      "node",
      "cli",
      "deploy",
      "--agent",
      agentId,
      "--run",
      "run-123",
    ]);

    expect(capturedUrl?.searchParams.get("agentId")).toBe(agentId);
    expect(capturedUrl?.searchParams.get("runId")).toBe("run-123");
  });

  it("should parse --since and send as timestamp", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/logs/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "error", "--since", "24h"]);

    const since = capturedUrl?.searchParams.get("since");
    expect(since).toBeDefined();
    // Should be a timestamp roughly 24h ago (within 5s tolerance)
    const sinceMs = Number(since);
    const expectedMs = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(sinceMs - expectedMs)).toBeLessThan(5000);
  });

  it("should show guided message for empty results", async () => {
    server.use(
      http.get("http://localhost:3000/api/logs/search", () => {
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "nonexistent"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No matches found");
    expect(logCalls).toContain("--since 30d");
  });

  it("should show auth error with login hint", async () => {
    server.use(
      http.get("http://localhost:3000/api/logs/search", () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(
      searchCommand.parseAsync(["node", "cli", "error"]),
    ).rejects.toThrow();

    const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorCalls).toContain("Not authenticated");
    expect(errorCalls).toContain("vm0 auth login");
  });

  it("should render context events around matched event", async () => {
    server.use(
      http.get("http://localhost:3000/api/logs/search", () => {
        return HttpResponse.json({
          results: [
            {
              runId: "abc12345-1234-1234-1234-123456789abc",
              agentName: "test-agent",
              matchedEvent: makeEvent(
                5,
                "Error: connection refused",
                "2024-01-15T10:30:05Z",
              ),
              contextBefore: [
                makeEvent(
                  4,
                  "Connecting to database...",
                  "2024-01-15T10:30:04Z",
                ),
              ],
              contextAfter: [
                makeEvent(6, "Retrying connection...", "2024-01-15T10:30:06Z"),
              ],
            },
          ],
          hasMore: false,
        });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "connection", "-C", "1"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Connecting to database");
    expect(logCalls).toContain("connection refused");
    expect(logCalls).toContain("Retrying connection");
  });

  it("should show hasMore hint when results are truncated", async () => {
    server.use(
      http.get("http://localhost:3000/api/logs/search", () => {
        return HttpResponse.json({
          results: [
            {
              runId: "abc12345-1234-1234-1234-123456789abc",
              agentName: "agent",
              matchedEvent: makeEvent(1, "match"),
              contextBefore: [],
              contextAfter: [],
            },
          ],
          hasMore: true,
        });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "match"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("--limit");
  });
});
