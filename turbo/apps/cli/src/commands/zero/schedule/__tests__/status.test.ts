/**
 * Tests for zero schedule status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { statusCommand } from "../status";
import chalk from "chalk";

const mockSchedule = {
  id: "sched-001",
  zeroAgentId: "za-001",
  agentName: "my-agent",
  orgSlug: "my-org",
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
  vars: null,
  secretNames: null,
  artifactName: null,
  artifactVersion: null,
  volumeVersions: null,
  enabled: true,
  notifyEmail: true,
  notifySlack: true,
  nextRunAt: "2026-03-24T09:00:00Z",
  lastRunAt: null,
  retryStartedAt: null,
  consecutiveFailures: 0,
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

describe("zero schedule status command", () => {
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

  describe("successful status", () => {
    it("should display schedule details", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [mockSchedule] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("enabled");
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("run daily check");
    });

    it("should display schedule with --name option", async () => {
      const secondSchedule = {
        ...mockSchedule,
        name: "weekly",
        cronExpression: "0 9 * * 1",
      };
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [mockSchedule, secondSchedule],
          });
        }),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--name",
        "weekly",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("0 9 * * 1");
    });
  });

  describe("error handling", () => {
    it("should handle no schedule found for agent", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "missing-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No schedule found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --name when agent has multiple schedules", async () => {
      const secondSchedule = { ...mockSchedule, name: "weekly" };
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [mockSchedule, secondSchedule],
          });
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("multiple schedules"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
