/**
 * Tests for zero automation delete command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { deleteCommand } from "../delete";
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

describe("zero automation delete command", () => {
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

  describe("successful delete", () => {
    it("should delete with --yes flag without prompting", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [mockAutomation] });
        }),
        http.delete("http://localhost:3000/api/automations/default", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "my-agent", "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Automation");
      expect(logCalls).toContain("deleted");
    });

    it("should delete when agent identifier is a UUID", async () => {
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
        http.delete("http://localhost:3000/api/automations/default", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", testUuid, "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Automation");
      expect(logCalls).toContain("deleted");
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
        await deleteCommand.parseAsync(["node", "cli", "my-agent", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No automation found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --yes in non-interactive mode", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockCompose);
        }),
        http.get("http://localhost:3000/api/automations", () => {
          return HttpResponse.json({ automations: [mockAutomation] });
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
