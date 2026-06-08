/**
 * Tests for zero schedule enable command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { enableCommand } from "../enable";
import chalk from "chalk";

const mockCompose = {
  id: "compose-uuid-001",
  name: "my-agent",
  headVersionId: "ver-001",
  content: null,
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

const mockSchedule = {
  id: "sched-001",
  agentId: "compose-uuid-001",
  userId: "user-001",
  name: "default",
  triggerType: "cron",
  cronExpression: "0 9 * * *",
  atTime: null,
  intervalSeconds: null,
  timezone: "UTC",
  prompt: "run daily check",
  description: null,
  appendSystemPrompt: null,
  enabled: true,
  nextRunAt: "2026-03-24T09:00:00Z",
  lastRunAt: null,
  retryStartedAt: null,
  consecutiveFailures: 0,
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

describe("zero schedule enable command", () => {
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

  describe("successful enable", () => {
    it("should enable a schedule", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [mockSchedule] });
        }),
        http.post(
          "http://localhost:3000/api/zero/schedules/default/enable",
          () => {
            return HttpResponse.json(mockSchedule);
          },
        ),
      );

      await enableCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Schedule");
      expect(logCalls).toContain("enabled");
    });

    it("should enable a schedule when agent identifier is a UUID", async () => {
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      const uuidCompose = { ...mockCompose, id: testUuid };
      const uuidSchedule = { ...mockSchedule, agentId: testUuid };

      server.use(
        http.get(
          "http://localhost:3000/api/agent/composes/:id",
          ({ params }) => {
            if (params.id !== testUuid) {
              return HttpResponse.json(
                { error: { message: "Not found", code: "NOT_FOUND" } },
                { status: 404 },
              );
            }
            return HttpResponse.json(uuidCompose);
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [uuidSchedule] });
        }),
        http.post(
          "http://localhost:3000/api/zero/schedules/default/enable",
          () => {
            return HttpResponse.json(uuidSchedule);
          },
        ),
      );

      await enableCommand.parseAsync(["node", "cli", testUuid]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Schedule");
      expect(logCalls).toContain("enabled");
    });
  });

  describe("error handling", () => {
    it("should handle no schedule found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await enableCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No schedule found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
