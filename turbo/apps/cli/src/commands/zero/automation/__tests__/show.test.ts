/**
 * Tests for `zero automation show` (unified automations).
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { showCommand } from "../show";
import chalk from "chalk";

const AUTOMATION_ID = "11111111-1111-4111-8111-111111111111";

const mockAutomation = {
  id: AUTOMATION_ID,
  agentId: "550e8400-e29b-41d4-a716-446655440000",
  displayName: "my-agent",
  userId: "user-001",
  name: "alerts",
  description: "Daily alert digest",
  instruction: "Summarize alerts",
  appendSystemPrompt: null,
  enabled: true,
  chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  triggers: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      automationId: AUTOMATION_ID,
      enabled: true,
      kind: "loop",
      intervalSeconds: 900,
      timezone: "UTC",
      nextRunAt: "2026-06-12T09:00:00Z",
      lastRunAt: null,
      consecutiveFailures: 0,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      automationId: AUTOMATION_ID,
      enabled: false,
      kind: "webhook",
      webhookToken: "whk_deadbeef",
      webhookUrl: "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    },
  ],
};

describe("zero automation show command", () => {
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

  it("should display automation fields and the triggers table", async () => {
    server.use(
      http.get("http://localhost:3000/api/automations/:ref", ({ params }) => {
        expect(params.ref).toBe("alerts");
        return HttpResponse.json(mockAutomation);
      }),
    );

    await showCommand.parseAsync(["node", "cli", "alerts"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("alerts");
    expect(logCalls).toContain(AUTOMATION_ID);
    expect(logCalls).toContain("Daily alert digest");
    expect(logCalls).toContain("Summarize alerts");
    // Triggers table: kind, id, status, config
    expect(logCalls).toContain("loop");
    expect(logCalls).toContain("22222222-2222-4222-8222-222222222222");
    expect(logCalls).toContain("every 15m");
    expect(logCalls).toContain("webhook");
    expect(logCalls).toContain(
      "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
    );
    expect(logCalls).toContain("disabled");
  });

  it("should hint at adding a trigger when the automation has none", async () => {
    server.use(
      http.get("http://localhost:3000/api/automations/:ref", () => {
        return HttpResponse.json({ ...mockAutomation, triggers: [] });
      }),
    );

    await showCommand.parseAsync(["node", "cli", "alerts"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No triggers");
    expect(logCalls).toContain("zero automation trigger add");
  });

  it("should surface the ambiguous-name API error", async () => {
    server.use(
      http.get("http://localhost:3000/api/automations/:ref", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Ambiguous name, use the id",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await showCommand.parseAsync(["node", "cli", "alerts"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Ambiguous name, use the id"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
