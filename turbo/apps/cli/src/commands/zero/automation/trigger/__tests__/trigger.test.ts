/**
 * Tests for `zero automation trigger` commands
 * (add / list / show / rm / enable / disable / rotate-secret).
 *
 * Tests command-level behavior via parseAsync() following CLI testing
 * principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { triggerCommand } from "../index";
import chalk from "chalk";

const AUTOMATION_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";

const triggerBase = {
  id: TRIGGER_ID,
  automationId: AUTOMATION_ID,
  enabled: true,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

const timeRuntime = {
  timezone: "UTC",
  nextRunAt: "2026-06-12T09:00:00Z",
  lastRunAt: null,
  consecutiveFailures: 0,
};

const cronTrigger = {
  ...triggerBase,
  kind: "cron",
  cronExpression: "0 9 * * *",
  ...timeRuntime,
};

const onceTrigger = {
  ...triggerBase,
  kind: "once",
  atTime: "2026-06-10T09:00:00Z",
  ...timeRuntime,
};

const loopTrigger = {
  ...triggerBase,
  kind: "loop",
  intervalSeconds: 900,
  ...timeRuntime,
};

const webhookTrigger = {
  ...triggerBase,
  kind: "webhook",
  webhookToken: "whk_deadbeef",
  webhookUrl: "http://localhost:3000/api/automations/webhooks/whk_deadbeef",
};

describe("zero automation trigger commands", () => {
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

  function captureAddTrigger(response: object, secret?: string) {
    const captured: { ref?: string; body?: Record<string, unknown> } = {};
    server.use(
      http.post(
        "http://localhost:3000/api/v2/automations/:ref/triggers",
        async ({ request, params }) => {
          captured.ref = params.ref as string;
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { trigger: response, webhookSecret: secret },
            { status: 201 },
          );
        },
      ),
    );
    return captured;
  }

  describe("add", () => {
    it("should add a cron trigger with --expr and --timezone", async () => {
      const captured = captureAddTrigger(cronTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        "alerts",
        "cron",
        "--expr",
        "0 9 * * *",
        "--timezone",
        "UTC",
      ]);

      expect(captured.ref).toBe("alerts");
      expect(captured.body).toEqual({
        kind: "cron",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Trigger added to automation "alerts"');
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain("0 9 * * *");
    });

    it("should add a once trigger with --at", async () => {
      const captured = captureAddTrigger(onceTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        "alerts",
        "once",
        "--at",
        "2026-06-10T09:00",
      ]);

      expect(captured.body).toEqual({
        kind: "once",
        atTime: "2026-06-10T09:00",
      });
    });

    it("should add a loop trigger parsing the --every duration", async () => {
      const captured = captureAddTrigger(loopTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        "alerts",
        "loop",
        "--every",
        "15m",
      ]);

      expect(captured.body).toEqual({ kind: "loop", intervalSeconds: 900 });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toMatch(/Every:\s+15m/);
    });

    it("should add a webhook trigger and print URL + one-time secret", async () => {
      const captured = captureAddTrigger(
        webhookTrigger,
        "whsec_supersecretvalue",
      );

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        "alerts",
        "webhook",
      ]);

      expect(captured.body).toEqual({ kind: "webhook" });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(webhookTrigger.webhookUrl);
      expect(logCalls).toContain("whsec_supersecretvalue");
      expect(logCalls).toContain("shown only once");
    });

    it("should reject an invalid --every duration", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          "alerts",
          "loop",
          "--every",
          "15minutes",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid duration: "15minutes"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject a cron trigger without --expr", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          "alerts",
          "cron",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("cron triggers require --expr"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject an unknown trigger kind", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          "alerts",
          "hourly",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Unknown trigger kind: "hourly"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("list", () => {
    it("should display the triggers table", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/v2/automations/:ref/triggers",
          ({ params }) => {
            expect(params.ref).toBe("alerts");
            return HttpResponse.json({
              triggers: [cronTrigger, webhookTrigger],
            });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "list", "alerts"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("cron");
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("webhook");
      expect(logCalls).toContain(webhookTrigger.webhookUrl);
      expect(logCalls).toContain(TRIGGER_ID);
    });

    it("should display empty state with an add hint", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/v2/automations/:ref/triggers",
          () => {
            return HttpResponse.json({ triggers: [] });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "list", "alerts"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No triggers");
      expect(logCalls).toContain("zero automation trigger add");
    });
  });

  describe("show", () => {
    it("should display trigger details", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/v2/automation-triggers/:id",
          ({ params }) => {
            expect(params.id).toBe(TRIGGER_ID);
            return HttpResponse.json(loopTrigger);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "show", TRIGGER_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("loop");
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain(AUTOMATION_ID);
      expect(logCalls).toMatch(/Every:\s+15m/);
    });
  });

  describe("rm", () => {
    it("should remove a trigger", async () => {
      let removedId: string | undefined;

      server.use(
        http.delete(
          "http://localhost:3000/api/v2/automation-triggers/:id",
          ({ params }) => {
            removedId = params.id as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "rm", TRIGGER_ID]);

      expect(removedId).toBe(TRIGGER_ID);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} removed`);
    });
  });

  describe("enable / disable", () => {
    it("should enable a single trigger", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/v2/automation-triggers/:id/enable",
          () => {
            return HttpResponse.json(cronTrigger);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "enable", TRIGGER_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} enabled`);
    });

    it("should disable a single trigger", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/v2/automation-triggers/:id/disable",
          () => {
            return HttpResponse.json({ ...cronTrigger, enabled: false });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "disable", TRIGGER_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} disabled`);
    });
  });

  describe("rotate-secret", () => {
    it("should rotate a webhook trigger secret and print it once", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/v2/automation-triggers/:id/rotate-secret",
          () => {
            return HttpResponse.json({
              trigger: webhookTrigger,
              webhookSecret: "whsec_rotatedvalue",
            });
          },
        ),
      );

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "rotate-secret",
        TRIGGER_ID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} secret rotated`);
      expect(logCalls).toContain("whsec_rotatedvalue");
      expect(logCalls).toContain("shown only once");
    });

    it("should surface the non-webhook trigger error", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/v2/automation-triggers/:id/rotate-secret",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Only webhook triggers have a secret",
                  code: "BAD_REQUEST",
                },
              },
              { status: 400 },
            );
          },
        ),
      );

      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "rotate-secret",
          TRIGGER_ID,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Only webhook triggers have a secret"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
