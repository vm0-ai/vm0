/**
 * Tests for zero logs list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: listCommand.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockLogEntry = {
  id: "abc12345-1234-1234-1234-123456789abc",
  sessionId: null,
  agentId: AGENT_ID,
  displayName: "My Agent",
  framework: "claude",
  triggerSource: "cli",
  triggerAgentName: null,
  scheduleId: null,
  status: "completed",
  createdAt: "2026-04-01T10:30:00Z",
  startedAt: "2026-04-01T10:30:01Z",
  completedAt: "2026-04-01T10:35:00Z",
};

const emptyFilters = {
  statuses: [],
  sources: [],
  agents: [],
};

describe("zero logs list command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should display runs in table format", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs", () => {
        return HttpResponse.json({
          data: [mockLogEntry],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("abc12345-1234-1234-1234-123456789abc");
    expect(logCalls).toContain("My Agent");
    expect(logCalls).toContain("completed");
    expect(logCalls).toContain("2026-04-01");
  });

  it("should handle empty run list", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs", () => {
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No logs found");
  });

  it("should pass agent filter to API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/logs", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli", "--agent", AGENT_ID]);

    expect(capturedUrl?.searchParams.get("agent")).toBe(AGENT_ID);
  });

  it("should pass status filter to API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/logs", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli", "--status", "failed"]);

    expect(capturedUrl?.searchParams.get("status")).toBe("failed");
  });

  it("should show pagination hint when more results exist", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs", () => {
        return HttpResponse.json({
          data: [mockLogEntry],
          pagination: { hasMore: true, nextCursor: "cursor-1", totalPages: 3 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("--limit");
  });

  it("should handle authentication error", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs", () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(async () => {
      await listCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should pass since filter to API", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/logs", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli", "--since", "1h"]);

    expect(capturedUrl?.searchParams.get("since")).toBeDefined();
    const sinceValue = Number(capturedUrl?.searchParams.get("since"));
    expect(sinceValue).toBeGreaterThan(Date.now() - 2 * 60 * 60 * 1000);
    expect(sinceValue).toBeLessThanOrEqual(Date.now());
  });

  it("should fall back to agentId when displayName is null", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/logs", () => {
        return HttpResponse.json({
          data: [{ ...mockLogEntry, displayName: null }],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters: emptyFilters,
        });
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(AGENT_ID);
  });
});
