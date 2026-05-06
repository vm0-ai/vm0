/**
 * Tests for zero logs search command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: searchCommand.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, event parsers, renderers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { searchCommand } from "../search";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

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

describe("zero logs search command", () => {
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

  it("should render search results grouped by run", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", () => {
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
    expect(logCalls).toContain("abc12345-1234-1234-1234-123456789abc");
    expect(logCalls).toContain("my-agent");
    expect(logCalls).toContain("OOM killed");
  });

  it("should handle no matches", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", () => {
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "nonexistent"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No matches found");
    expect(logCalls).toContain("--since 30d");
  });

  it("should pass context options to API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", ({ request }) => {
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
      http.get("http://localhost:3000/api/zero/logs/search", ({ request }) => {
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

  it("should pass agentId and run filters", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [], hasMore: false });
      }),
    );

    await searchCommand.parseAsync([
      "node",
      "cli",
      "deploy",
      "--agent",
      AGENT_ID,
      "--run",
      "abc12345-1234-1234-1234-123456789abc",
    ]);

    expect(capturedUrl?.searchParams.get("agentId")).toBe(AGENT_ID);
    expect(capturedUrl?.searchParams.get("runId")).toBe(
      "abc12345-1234-1234-1234-123456789abc",
    );
  });

  it("should show hasMore hint when truncated", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", () => {
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

  it("should render context events around matched event", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", () => {
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

  it("should reject non-UUID --run value", async () => {
    await expect(
      searchCommand.parseAsync(["node", "cli", "error", "--run", "6af7eece"]),
    ).rejects.toThrow("process.exit called");

    const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorCalls).toContain("Invalid run ID");
    expect(errorCalls).toContain("zero logs list");
  });

  it("should handle authentication error", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs/search", () => {
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
  });
});
