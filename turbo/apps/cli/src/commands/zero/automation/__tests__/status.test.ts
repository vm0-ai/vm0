/**
 * Tests for zero automation status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { statusCommand } from "../status";
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
  enabled: true,
  nextRunAt: "2026-03-24T09:00:00Z",
  lastRunAt: null,
  retryStartedAt: null,
  consecutiveFailures: 0,
  chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
  createdAt: "2026-03-23T00:00:00Z",
  updatedAt: "2026-03-23T00:00:00Z",
};

describe("zero automation status command", () => {
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

  describe("successful status", () => {
    it("should display automation details", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [mockAutomation] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("enabled");
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("run daily check");
    });

    it("should display automation with --name option", async () => {
      const secondAutomation = {
        ...mockAutomation,
        name: "weekly",
        cronExpression: "0 9 * * 1",
      };
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({
            automations: [mockAutomation, secondAutomation],
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

    it("should show full prompt without truncation with --prompt flag", async () => {
      const longPrompt =
        "a".repeat(120) +
        " this is clearly past the 60-character preview limit";
      const longAutomation = { ...mockAutomation, prompt: longPrompt };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [longAutomation] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "my-agent", "--prompt"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(longPrompt);
      expect(logCalls).not.toMatch(/a{57}\.\.\./);
    });

    it("should truncate prompt preview without --prompt flag", async () => {
      const longPrompt =
        "a".repeat(120) +
        " this is clearly past the 60-character preview limit";
      const longAutomation = { ...mockAutomation, prompt: longPrompt };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [longAutomation] });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain(longPrompt);
      expect(logCalls).toMatch(/a{57}\.\.\./);
      expect(logCalls).toContain("--prompt");
    });

    it("should display automation when agent identifier is a UUID", async () => {
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      const uuidCompose = { ...mockCompose, id: testUuid };
      const uuidAutomation = { ...mockAutomation, agentId: testUuid };

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
      );

      await statusCommand.parseAsync(["node", "cli", testUuid]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("run daily check");
    });
  });

  describe("error handling", () => {
    it("should handle no automation found for agent", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [] });
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No automation found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --name when agent has multiple automations", async () => {
      const secondAutomation = { ...mockAutomation, name: "weekly" };
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({
            automations: [mockAutomation, secondAutomation],
          });
        }),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("multiple automations"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
