/**
 * Tests for `zero automation update` (unified automations).
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { updateCommand } from "../update";
import chalk from "chalk";

const AUTOMATION_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_TRIGGER_ID = "33333333-3333-4333-8333-333333333333";

const mockAutomation = {
  id: AUTOMATION_ID,
  agentId: "550e8400-e29b-41d4-a716-446655440000",
  displayName: "my-agent",
  userId: "user-001",
  name: "alerts-v2",
  description: "Daily alert digest",
  instruction: "Summarize alerts and post to Slack",
  appendSystemPrompt: null,
  enabled: true,
  chatThreadId: "550e8400-e29b-41d4-a716-446655440099",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  triggers: [],
};

const triggerBase = {
  automationId: AUTOMATION_ID,
  enabled: true,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  timezone: "UTC",
  nextRunAt: "2026-06-12T09:00:00Z",
  lastRunAt: null,
  consecutiveFailures: 0,
};

const loopTrigger = {
  ...triggerBase,
  id: TRIGGER_ID,
  kind: "loop",
  intervalSeconds: 300,
};

const cronTrigger = {
  ...triggerBase,
  id: SECOND_TRIGGER_ID,
  kind: "cron",
  cronExpression: "0 9 * * *",
};

const webhookTrigger = {
  id: "44444444-4444-4444-8444-444444444444",
  automationId: AUTOMATION_ID,
  enabled: true,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  kind: "webhook",
  webhookToken: "whk_deadbeef",
  webhookUrl: "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
};

function mockShowAutomation(triggers: object[]) {
  server.use(
    http.get("http://localhost:3000/api/automations/:ref", () => {
      return HttpResponse.json({ ...mockAutomation, triggers });
    }),
  );
}

describe("zero automation update command", () => {
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

  it("should update name, instruction, and description", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedRef: string | undefined;

    server.use(
      http.patch(
        "http://localhost:3000/api/automations/:ref",
        async ({ request, params }) => {
          capturedRef = params.ref as string;
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(mockAutomation);
        },
      ),
    );

    await updateCommand.parseAsync([
      "node",
      "cli",
      "alerts",
      "-n",
      "alerts-v2",
      "-p",
      "Summarize alerts and post to Slack",
      "--description",
      "Daily alert digest",
    ]);

    expect(capturedRef).toBe("alerts");
    expect(capturedBody).toEqual({
      name: "alerts-v2",
      instruction: "Summarize alerts and post to Slack",
      description: "Daily alert digest",
    });

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain('Automation "alerts-v2" updated');
  });

  it("should reject when no update flags are given", async () => {
    await expect(async () => {
      await updateCommand.parseAsync(["node", "cli", "alerts"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to update"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  describe("timing sugar (--cron / --once / --loop)", () => {
    it("should update the single time trigger in place, skipping the automation PATCH", async () => {
      let automationPatchCalls = 0;
      let capturedTriggerId: string | undefined;
      let capturedTriggerBody: Record<string, unknown> | undefined;

      // The webhook trigger is ignored: only time triggers are schedule
      // candidates.
      mockShowAutomation([webhookTrigger, loopTrigger]);
      server.use(
        http.patch("http://localhost:3000/api/automations/:ref", () => {
          automationPatchCalls += 1;
          return HttpResponse.json(mockAutomation);
        }),
        http.patch(
          "http://localhost:3000/api/automation-triggers/:id",
          async ({ request, params }) => {
            capturedTriggerId = params.id as string;
            capturedTriggerBody = (await request.json()) as Record<
              string,
              unknown
            >;
            return HttpResponse.json({
              ...loopTrigger,
              intervalSeconds: 600,
            });
          },
        ),
      );

      await updateCommand.parseAsync([
        "node",
        "cli",
        "alerts",
        "--loop",
        "10m",
      ]);

      expect(automationPatchCalls).toBe(0);
      expect(capturedTriggerId).toBe(TRIGGER_ID);
      expect(capturedTriggerBody).toEqual({
        kind: "loop",
        intervalSeconds: 600,
      });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} updated`);
      expect(logCalls).toContain("every 10m");
    });

    it("should run both the automation PATCH and the trigger update when combined", async () => {
      let capturedUpdateBody: Record<string, unknown> | undefined;
      let capturedTriggerBody: Record<string, unknown> | undefined;

      mockShowAutomation([loopTrigger]);
      server.use(
        http.patch(
          "http://localhost:3000/api/automations/:ref",
          async ({ request }) => {
            capturedUpdateBody = (await request.json()) as Record<
              string,
              unknown
            >;
            return HttpResponse.json(mockAutomation);
          },
        ),
        http.patch(
          "http://localhost:3000/api/automation-triggers/:id",
          async ({ request }) => {
            capturedTriggerBody = (await request.json()) as Record<
              string,
              unknown
            >;
            return HttpResponse.json({
              ...cronTrigger,
              id: TRIGGER_ID,
              timezone: "Asia/Shanghai",
            });
          },
        ),
      );

      await updateCommand.parseAsync([
        "node",
        "cli",
        "alerts",
        "-p",
        "New instruction",
        "--cron",
        "0 9 * * *",
        "-z",
        "Asia/Shanghai",
      ]);

      expect(capturedUpdateBody).toEqual({ instruction: "New instruction" });
      expect(capturedTriggerBody).toEqual({
        kind: "cron",
        cronExpression: "0 9 * * *",
        timezone: "Asia/Shanghai",
      });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Automation "alerts-v2" updated');
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} updated`);
    });

    it("should error when the automation has no time trigger", async () => {
      mockShowAutomation([webhookTrigger]);

      await expect(async () => {
        await updateCommand.parseAsync([
          "node",
          "cli",
          "alerts",
          "--loop",
          "10m",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No time trigger to update"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error listing ids when the automation has multiple time triggers", async () => {
      mockShowAutomation([loopTrigger, cronTrigger]);

      await expect(async () => {
        await updateCommand.parseAsync([
          "node",
          "cli",
          "alerts",
          "--loop",
          "10m",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Multiple time triggers"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(TRIGGER_ID),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(SECOND_TRIGGER_ID),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject more than one timing flag", async () => {
      await expect(async () => {
        await updateCommand.parseAsync([
          "node",
          "cli",
          "alerts",
          "--loop",
          "10m",
          "--cron",
          "0 9 * * *",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("at most one of --cron, --once, --loop"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  it("should surface API errors", async () => {
    server.use(
      http.patch("http://localhost:3000/api/automations/:ref", () => {
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
      await updateCommand.parseAsync(["node", "cli", "alerts", "-n", "x"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Ambiguous name, use the id"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
