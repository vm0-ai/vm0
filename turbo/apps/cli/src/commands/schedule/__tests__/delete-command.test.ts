/**
 * Tests for schedule delete command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { deleteCommand } from "../delete";
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

describe("schedule delete command", () => {
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
    it("should show usage information with rm alias", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await deleteCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Delete a schedule");
      expect(output).toContain("<agent-name>");
      expect(output).toContain("--force");
      expect(output).toContain("rm");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful delete", () => {
    it("should delete schedule with --force", async () => {
      const schedule = createMockSchedule();
      let deletedName: string | undefined;

      server.use(
        // resolveScheduleByAgent calls listSchedules first
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        // Then deleteSchedule
        http.delete(
          "http://localhost:3000/api/agent/schedules/:name",
          ({ params }) => {
            deletedName = params.name as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await deleteCommand.parseAsync(["node", "cli", "test-agent", "--force"]);

      expect(deletedName).toBe("test-agent-schedule");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Deleted schedule");
      expect(logCalls).toContain("test-agent");
    });

    it("should resolve schedule by agent name from any directory", async () => {
      // This tests that resolveScheduleByAgent finds the schedule
      // by matching composeName in the schedules list
      const schedule = createMockSchedule({
        composeName: "my-special-agent",
        name: "my-special-agent-schedule",
      });
      let deletedName: string | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.delete(
          "http://localhost:3000/api/agent/schedules/:name",
          ({ params }) => {
            deletedName = params.name as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await deleteCommand.parseAsync([
        "node",
        "cli",
        "my-special-agent",
        "--force",
      ]);

      expect(deletedName).toBe("my-special-agent-schedule");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Deleted schedule");
    });
  });

  describe("confirmation", () => {
    it("should require --force in non-interactive mode", async () => {
      const schedule = createMockSchedule();

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
      );

      // Mock isInteractive to return false (non-interactive)
      vi.stubEnv("CI", "true");

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "test-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--force required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
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
        await deleteCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-agent",
          "--force",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete schedule"),
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
        await deleteCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--force",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
