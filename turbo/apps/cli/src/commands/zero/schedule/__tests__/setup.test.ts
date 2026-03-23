/**
 * Tests for zero schedule setup command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { setupCommand } from "../setup";
import chalk from "chalk";

const mockAgent = {
  name: "my-agent",
  agentComposeId: "comp_abc123",
  displayName: "My Agent",
  description: null,
  sound: null,
  connectors: ["github"],
};

const mockDeployResponse = {
  created: true,
  schedule: {
    id: "sched-001",
    composeId: "comp-001",
    composeName: "my-agent",
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
    artifactName: "artifact",
    artifactVersion: null,
    volumeVersions: null,
    enabled: false,
    notifyEmail: true,
    notifySlack: true,
    nextRunAt: "2026-03-24T09:00:00Z",
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    createdAt: "2026-03-23T00:00:00Z",
    updatedAt: "2026-03-23T00:00:00Z",
  },
};

describe("zero schedule setup command", () => {
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

  describe("successful setup (non-interactive)", () => {
    it("should create daily schedule with all flags", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockDeployResponse, { status: 201 });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--frequency",
        "daily",
        "--time",
        "09:00",
        "--timezone",
        "UTC",
        "--prompt",
        "run daily check",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Created schedule");
      expect(logCalls).toContain("my-agent");
    });

    it("should create loop schedule with interval flag", async () => {
      const loopResponse = {
        ...mockDeployResponse,
        schedule: {
          ...mockDeployResponse.schedule,
          triggerType: "loop",
          cronExpression: null,
          intervalSeconds: 300,
          nextRunAt: null,
        },
      };

      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(loopResponse, { status: 201 });
        }),
      );

      await setupCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--frequency",
        "loop",
        "--interval",
        "300",
        "--prompt",
        "loop task",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Created schedule");
    });
  });

  describe("error handling", () => {
    it("should handle agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/missing", () => {
          return HttpResponse.json(
            { error: { message: "Agent not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "missing",
          "--frequency",
          "daily",
          "--time",
          "09:00",
          "--prompt",
          "test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --frequency in non-interactive mode", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await expect(async () => {
        await setupCommand.parseAsync([
          "node",
          "cli",
          "my-agent",
          "--prompt",
          "test",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--frequency is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
