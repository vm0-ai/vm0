/**
 * Tests for schedule setup command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 *
 * Note: The setup command is heavily interactive. Core configuration gathering
 * logic is unit tested in gather-configuration.test.ts. These tests focus on:
 * - Non-interactive mode scenarios
 * - API integration via MSW
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setupCommand } from "../setup";
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
    enabled: false,
    nextRunAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to create a mock compose response
function createMockCompose(overrides: Record<string, unknown> = {}) {
  return {
    id: "compose-1",
    name: "test-agent",
    scopeSlug: "user-test",
    currentVersion: "v1",
    content: {
      version: "1.0",
      agents: {
        "test-agent": {
          description: "Test agent",
          framework: "claude-code",
          image: "vm0/claude-code:dev",
          working_dir: "/home/user/workspace",
        },
      },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("schedule setup command", () => {
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
    vi.stubEnv("CI", "true"); // Force non-interactive mode
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
        await setupCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Create or edit a schedule");
      expect(output).toContain("<agent-name>");
      expect(output).toContain("--frequency");
      expect(output).toContain("--time");
      expect(output).toContain("--day");
      expect(output).toContain("--timezone");
      expect(output).toContain("--prompt");
      // --var option removed - vars now managed via platform tables
      expect(output).toContain("--enable");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful setup", () => {
    it("should create daily schedule in non-interactive mode", async () => {
      const compose = createMockCompose();
      const schedule = createMockSchedule({
        cronExpression: "0 14 * * *",
        timezone: "America/New_York",
      });
      let deployPayload: Record<string, unknown> | undefined;

      server.use(
        // getComposeByName
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json(compose);
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        // listSchedules (to check for existing)
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        // deploySchedule
        http.post(
          "http://localhost:3000/api/agent/schedules",
          async ({ request }) => {
            deployPayload = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              { created: true, schedule },
              { status: 201 },
            );
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--frequency",
        "daily",
        "--time",
        "14:00",
        "--timezone",
        "America/New_York",
        "--prompt",
        "Run daily task",
      ]);

      expect(deployPayload).toBeDefined();
      expect(deployPayload!.cronExpression).toBe("0 14 * * *");
      expect(deployPayload!.timezone).toBe("America/New_York");
      expect(deployPayload!.prompt).toBe("Run daily task");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Created schedule");
      expect(logCalls).toContain("test-agent");
    });

    it("should create weekly schedule with day option", async () => {
      const compose = createMockCompose();
      const schedule = createMockSchedule({ cronExpression: "0 9 * * 1" });
      let deployPayload: Record<string, unknown> | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post(
          "http://localhost:3000/api/agent/schedules",
          async ({ request }) => {
            deployPayload = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              { created: true, schedule },
              { status: 201 },
            );
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--frequency",
        "weekly",
        "--day",
        "mon",
        "--time",
        "09:00",
        "--prompt",
        "Weekly report",
      ]);

      expect(deployPayload).toBeDefined();
      expect(deployPayload!.cronExpression).toBe("0 9 * * 1");
    });

    it("should create monthly schedule with day option", async () => {
      const compose = createMockCompose();
      const schedule = createMockSchedule({ cronExpression: "0 12 15 * *" });
      let deployPayload: Record<string, unknown> | undefined;

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post(
          "http://localhost:3000/api/agent/schedules",
          async ({ request }) => {
            deployPayload = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              { created: true, schedule },
              { status: 201 },
            );
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--frequency",
        "monthly",
        "--day",
        "15",
        "--time",
        "12:00",
        "--prompt",
        "Monthly review",
      ]);

      expect(deployPayload).toBeDefined();
      expect(deployPayload!.cronExpression).toBe("0 12 15 * *");
    });

    it("should update existing schedule", async () => {
      const compose = createMockCompose();
      const existingSchedule = createMockSchedule();
      const updatedSchedule = createMockSchedule({
        cronExpression: "0 10 * * *",
        prompt: "Updated task",
      });

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [existingSchedule] });
        }),
        http.post("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(
            { created: false, schedule: updatedSchedule },
            { status: 200 },
          );
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--frequency",
        "daily",
        "--time",
        "10:00",
        "--prompt",
        "Updated task",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Editing existing schedule");
      expect(logCalls).toContain("Updated schedule");
    });

    // Test removed: --var option no longer supported
    // vars are now managed via platform tables (vm0 var set)

    it("should enable schedule with --enable flag", async () => {
      const compose = createMockCompose();
      const schedule = createMockSchedule({ enabled: false });
      const enabledSchedule = createMockSchedule({ enabled: true });
      let enableCalled = false;

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(
            { created: true, schedule },
            { status: 201 },
          );
        }),
        http.post(
          "http://localhost:3000/api/agent/schedules/:name/enable",
          () => {
            enableCalled = true;
            return HttpResponse.json(enabledSchedule);
          },
        ),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "test-agent",
        "--frequency",
        "daily",
        "--time",
        "09:00",
        "--prompt",
        "Daily task",
        "--enable",
      ]);

      expect(enableCalled).toBe(true);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Enabled schedule");
    });
  });

  describe("error handling", () => {
    it("should handle agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-agent",
          "--frequency",
          "daily",
          "--time",
          "09:00",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
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
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--frequency",
          "daily",
          "--time",
          "09:00",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --frequency in non-interactive mode", async () => {
      const compose = createMockCompose();

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--time",
          "09:00",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--frequency is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --day for weekly in non-interactive mode", async () => {
      const compose = createMockCompose();

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--frequency",
          "weekly",
          "--time",
          "09:00",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--day is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --time in non-interactive mode", async () => {
      const compose = createMockCompose();

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--frequency",
          "daily",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--time is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --prompt in non-interactive mode", async () => {
      const compose = createMockCompose();

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--frequency",
          "daily",
          "--time",
          "09:00",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--prompt is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should validate time format", async () => {
      const compose = createMockCompose();

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--frequency",
          "daily",
          "--time",
          "invalid",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid time"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should validate day format for weekly", async () => {
      const compose = createMockCompose();

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(compose);
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "test-agent",
          "--frequency",
          "weekly",
          "--day",
          "invalid",
          "--time",
          "09:00",
          "--prompt",
          "Task",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid day"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
