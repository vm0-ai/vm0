/**
 * Tests for run queue command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { queueCommand } from "../queue";
import chalk from "chalk";

describe("run queue command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
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

  it("displays concurrency header and queue table", async () => {
    server.use(
      http.get("http://localhost:3000/api/agent/runs/queue", () => {
        return HttpResponse.json({
          concurrency: { tier: "team", limit: 5, active: 3, available: 2 },
          queue: [
            {
              position: 1,
              agentName: "data-processor",
              userEmail: "alice@example.com",
              createdAt: new Date(Date.now() - 120000).toISOString(),
              runId: "run-uuid-1",
            },
            {
              position: 2,
              agentName: null,
              userEmail: null,
              createdAt: new Date(Date.now() - 60000).toISOString(),
              runId: null,
            },
          ],
        });
      }),
    );

    await queueCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("3/5 slots used");
    expect(logCalls).toContain("team tier");
    expect(logCalls).toContain("2 runs waiting");
    expect(logCalls).toContain("AGENT");
    expect(logCalls).toContain("USER");
    expect(logCalls).toContain("data-processor");
    expect(logCalls).toContain("alice@example.com");
    // Other user's entries are masked
    expect(logCalls).toContain("-");
    expect(logCalls).not.toContain("bob@example.com");
  });

  it("marks own entries with you indicator", async () => {
    server.use(
      http.get("http://localhost:3000/api/agent/runs/queue", () => {
        return HttpResponse.json({
          concurrency: { tier: "team", limit: 5, active: 3, available: 2 },
          queue: [
            {
              position: 1,
              agentName: "my-agent",
              userEmail: "alice@example.com",
              createdAt: new Date().toISOString(),
              runId: "run-uuid-1",
            },
            {
              position: 2,
              agentName: null,
              userEmail: null,
              createdAt: new Date().toISOString(),
              runId: null,
            },
          ],
        });
      }),
    );

    await queueCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    // The "you" marker should appear for own entries
    expect(logCalls).toContain("you");
  });

  it("displays empty queue state", async () => {
    server.use(
      http.get("http://localhost:3000/api/agent/runs/queue", () => {
        return HttpResponse.json({
          concurrency: { tier: "free", limit: 1, active: 0, available: 1 },
          queue: [],
        });
      }),
    );

    await queueCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("0/1 slots used");
    expect(logCalls).toContain("free tier");
    expect(logCalls).toContain("empty");
  });

  it("handles API error gracefully", async () => {
    server.use(
      http.get("http://localhost:3000/api/agent/runs/queue", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Not authenticated",
              code: "UNAUTHORIZED",
            },
          },
          { status: 401 },
        );
      }),
    );

    await expect(async () => {
      await queueCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
  });

  it("handles single queued run", async () => {
    server.use(
      http.get("http://localhost:3000/api/agent/runs/queue", () => {
        return HttpResponse.json({
          concurrency: { tier: "pro", limit: 2, active: 2, available: 0 },
          queue: [
            {
              position: 1,
              agentName: "test-agent",
              userEmail: "user@example.com",
              createdAt: new Date().toISOString(),
              runId: "run-1",
            },
          ],
        });
      }),
    );

    await queueCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("2/2 slots used");
    expect(logCalls).toContain("1 run waiting");
    expect(logCalls).toContain("test-agent");
  });
});
