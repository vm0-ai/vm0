/**
 * Tests for schedule list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("schedule list command", () => {
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
    it("should show ls alias", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await listCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("List all schedules");
      expect(output).toContain("ls");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful list", () => {
    it("should display schedules in table format", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                id: "schedule-1",
                composeId: "compose-1",
                composeName: "my-agent",
                scopeSlug: "user-test",
                name: "my-agent-schedule",
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
              },
              {
                id: "schedule-2",
                composeId: "compose-2",
                composeName: "other-agent",
                scopeSlug: "user-test",
                name: "other-agent-schedule",
                cronExpression: "0 10 * * 1",
                atTime: null,
                timezone: "America/New_York",
                prompt: "Weekly task",
                vars: null,
                secretNames: null,
                artifactName: null,
                artifactVersion: null,
                volumeVersions: null,
                enabled: false,
                nextRunAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("other-agent");
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("UTC");
    });

    it("should show enabled and disabled status", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                id: "schedule-1",
                composeId: "compose-1",
                composeName: "enabled-agent",
                scopeSlug: "user-test",
                name: "enabled-schedule",
                cronExpression: "0 9 * * *",
                atTime: null,
                timezone: "UTC",
                prompt: "Task",
                vars: null,
                secretNames: null,
                artifactName: null,
                artifactVersion: null,
                volumeVersions: null,
                enabled: true,
                nextRunAt: new Date(Date.now() + 86400000).toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: "schedule-2",
                composeId: "compose-2",
                composeName: "disabled-agent",
                scopeSlug: "user-test",
                name: "disabled-schedule",
                cronExpression: "0 10 * * *",
                atTime: null,
                timezone: "UTC",
                prompt: "Task",
                vars: null,
                secretNames: null,
                artifactName: null,
                artifactVersion: null,
                volumeVersions: null,
                enabled: false,
                nextRunAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("enabled");
      expect(logCalls).toContain("disabled");
    });

    it("should display empty state message when no schedules", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No schedules found");
      expect(logCalls).toContain("vm0 schedule setup");
    });

    it("should show table header with correct columns", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                id: "schedule-1",
                composeId: "compose-1",
                composeName: "test-agent",
                scopeSlug: "user-test",
                name: "test-schedule",
                cronExpression: "0 9 * * *",
                atTime: null,
                timezone: "UTC",
                prompt: "Task",
                vars: null,
                secretNames: null,
                artifactName: null,
                artifactVersion: null,
                volumeVersions: null,
                enabled: true,
                nextRunAt: new Date(Date.now() + 86400000).toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AGENT");
      expect(logCalls).toContain("TRIGGER");
      expect(logCalls).toContain("STATUS");
      expect(logCalls).toContain("NEXT RUN");
    });
  });

  describe("error handling", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list schedules"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "INTERNAL_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list schedules"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
