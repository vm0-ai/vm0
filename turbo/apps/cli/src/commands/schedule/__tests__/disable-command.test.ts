/**
 * Tests for schedule disable command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { disableCommand } from "../disable";
import chalk from "chalk";

// Helper to create a mock schedule response
function createMockSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "schedule-1",
    composeId: "compose-1",
    composeName: "test-agent",
    scopeSlug: "user-test",
    name: "test-agent-schedule",
    cronExpression: "0 9 * * *",
    atTime: null,
    timezone: "UTC",
    prompt: "Daily task",
    vars: null,
    secretNames: null,
    artifactName: null,
    artifactVersion: null,
    volumeVersions: null,
    enabled: true,
    nextRunAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("schedule disable command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("help text", () => {
    it("should show usage information", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await disableCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Disable a schedule");
      expect(output).toContain("<agent-name>");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful disable", () => {
    it("should disable schedule successfully", async () => {
      const schedule = createMockSchedule({ enabled: true });
      const disabledSchedule = createMockSchedule({
        enabled: false,
        nextRunAt: null,
      });

      server.use(
        // resolveScheduleByAgent calls listSchedules first
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        // Then disableSchedule
        http.post(
          "http://localhost:3000/api/agent/schedules/:name/disable",
          () => {
            return HttpResponse.json(disabledSchedule);
          },
        ),
      );

      await disableCommand.parseAsync(["node", "cli", "test-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Disabled schedule");
      expect(logCalls).toContain("test-agent");
    });

    it("should resolve schedule by agent name from any directory", async () => {
      // This tests that resolveScheduleByAgent finds the schedule
      // by matching composeName in the schedules list
      const schedule = createMockSchedule({
        composeName: "my-special-agent",
        name: "my-special-agent-schedule",
      });
      const disabledSchedule = { ...schedule, enabled: false, nextRunAt: null };
      let disabledName: string | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.post(
          "http://localhost:3000/api/agent/schedules/:name/disable",
          ({ params }) => {
            disabledName = params.name as string;
            return HttpResponse.json(disabledSchedule);
          },
        ),
      );

      await disableCommand.parseAsync(["node", "cli", "my-special-agent"]);

      expect(disabledName).toBe("my-special-agent-schedule");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Disabled schedule");
    });
  });

  describe("error handling", () => {
    it("should handle schedule not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await disableCommand.parseAsync(["node", "cli", "nonexistent-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to disable schedule"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No schedule found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
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
        await disableCommand.parseAsync(["node", "cli", "test-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
