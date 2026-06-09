/**
 * Tests for zero automation disable command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { disableCommand } from "../disable";
import chalk from "chalk";

const mockCompose = {
  id: "compose-uuid-001",
  name: "my-agent",
  headVersionId: "ver-001",
  content: null,
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

const mockAutomation = {
  id: "auto-001",
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
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  retryStartedAt: null,
  consecutiveFailures: 0,
  chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

describe("zero automation disable command", () => {
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

  describe("successful disable", () => {
    it("should disable an automation", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({
            automations: [{ ...mockAutomation, enabled: true }],
          });
        }),
        http.post(
          "http://localhost:3000/api/automations/default/disable",
          () => {
            return HttpResponse.json(mockAutomation);
          },
        ),
      );

      await disableCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Automation");
      expect(logCalls).toContain("disabled");
    });

    it("should disable an automation when agent identifier is a UUID", async () => {
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      const uuidCompose = { ...mockCompose, id: testUuid };
      const uuidAutomation = {
        ...mockAutomation,
        agentId: testUuid,
        enabled: true,
      };

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
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [uuidAutomation] });
        }),
        http.post(
          "http://localhost:3000/api/automations/default/disable",
          () => {
            return HttpResponse.json({ ...uuidAutomation, enabled: false });
          },
        ),
      );

      await disableCommand.parseAsync(["node", "cli", testUuid]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Automation");
      expect(logCalls).toContain("disabled");
    });
  });

  describe("error handling", () => {
    it("should handle no automation found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [] });
        }),
      );

      await expect(async () => {
        await disableCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No automation found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
