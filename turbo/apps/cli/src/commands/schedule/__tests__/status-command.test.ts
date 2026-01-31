/**
 * Tests for schedule status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { statusCommand } from "../status";
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

describe("schedule status command", () => {
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
        await statusCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Show detailed status");
      expect(output).toContain("<agent-name>");
      expect(output).toContain("--limit");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful status", () => {
    it("should display schedule details", async () => {
      const schedule = createMockSchedule();

      server.use(
        // resolveScheduleByAgent calls listSchedules first
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        // Then getScheduleByName
        http.get(
          "http://localhost:3000/api/agent/schedules/:name",
          ({ params }) => {
            if (params.name === "test-agent-schedule") {
              return HttpResponse.json(schedule);
            }
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
        // Then listScheduleRuns
        http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "test-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("test-agent");
      expect(logCalls).toContain("Status:");
      expect(logCalls).toContain("enabled");
      expect(logCalls).toContain("Agent:");
      expect(logCalls).toContain("Prompt:");
      expect(logCalls).toContain("Trigger:");
      expect(logCalls).toContain("0 9 * * *");
    });

    it("should show vars and secrets names when present", async () => {
      const schedule = createMockSchedule({
        vars: { ENV: "production", DEBUG: "false" },
        secretNames: ["API_KEY", "DB_PASSWORD"],
      });

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(schedule);
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "test-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Variables:");
      expect(logCalls).toContain("ENV");
      expect(logCalls).toContain("DEBUG");
      expect(logCalls).toContain("Secrets:");
      expect(logCalls).toContain("API_KEY");
      expect(logCalls).toContain("DB_PASSWORD");
    });

    it("should show artifact when present", async () => {
      const schedule = createMockSchedule({
        artifactName: "my-artifact",
        artifactVersion: "v1.0",
      });

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(schedule);
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "test-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Artifact:");
      expect(logCalls).toContain("my-artifact:v1.0");
    });

    it("should show recent runs when available", async () => {
      const schedule = createMockSchedule();

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(schedule);
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
          return HttpResponse.json({
            runs: [
              {
                id: "run-1",
                status: "completed",
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                error: null,
              },
              {
                id: "run-2",
                status: "failed",
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                error: "Something went wrong",
              },
            ],
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "test-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Recent Runs:");
      expect(logCalls).toContain("run-1");
      expect(logCalls).toContain("completed");
      expect(logCalls).toContain("run-2");
      expect(logCalls).toContain("failed");
    });
  });

  describe("--limit option", () => {
    it("should respect --limit option", async () => {
      const schedule = createMockSchedule();
      let requestedLimit: number | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(schedule);
        }),
        http.get(
          "http://localhost:3000/api/agent/schedules/:name/runs",
          ({ request }) => {
            const url = new URL(request.url);
            requestedLimit = parseInt(url.searchParams.get("limit") || "5", 10);
            return HttpResponse.json({ runs: [] });
          },
        ),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--limit",
        "10",
      ]);

      expect(requestedLimit).toBe(10);
    });

    it("should respect -l shorthand", async () => {
      const schedule = createMockSchedule();
      let requestedLimit: number | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(schedule);
        }),
        http.get(
          "http://localhost:3000/api/agent/schedules/:name/runs",
          ({ request }) => {
            const url = new URL(request.url);
            requestedLimit = parseInt(url.searchParams.get("limit") || "5", 10);
            return HttpResponse.json({ runs: [] });
          },
        ),
      );

      await statusCommand.parseAsync(["node", "cli", "test-agent", "-l", "3"]);

      expect(requestedLimit).toBe(3);
    });

    it("should hide runs section when --limit 0", async () => {
      const schedule = createMockSchedule();
      let runsRequested = false;

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(schedule);
        }),
        http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
          runsRequested = true;
          return HttpResponse.json({ runs: [] });
        }),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--limit",
        "0",
      ]);

      expect(runsRequested).toBe(false);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("Recent Runs:");
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
        await statusCommand.parseAsync(["node", "cli", "nonexistent-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to get schedule status"),
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
        await statusCommand.parseAsync(["node", "cli", "test-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("global resolution", () => {
    it("should resolve schedule by agent name from any directory", async () => {
      // This tests that resolveScheduleByAgent finds the schedule
      // by matching composeName in the schedules list
      const schedule = createMockSchedule({
        composeName: "my-special-agent",
        name: "my-special-agent-schedule",
      });

      server.use(
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [schedule] });
        }),
        http.get(
          "http://localhost:3000/api/agent/schedules/:name",
          ({ params }) => {
            if (params.name === "my-special-agent-schedule") {
              return HttpResponse.json(schedule);
            }
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules/:name/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "my-special-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-special-agent");
    });
  });
});
