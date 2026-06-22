/**
 * Tests for `zero workflow trigger` commands
 * (add / update / list / show / rm / enable / disable / run).
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

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const TRIGGER_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

const workflowSummary = {
  id: WORKFLOW_ID,
  agentId: AGENT_ID,
  agentName: "Zero",
  agentDisplayName: "Zero",
  name: "tell-a-joke",
  displayName: "Tell a joke",
  description: "Tell one short joke",
  visibility: "private",
  requestToPublish: false,
  ownerUserId: "user-123",
  canManage: true,
};

const triggerBase = {
  id: TRIGGER_ID,
  kind: "schedule",
  ownerUserId: "user-123",
  enabled: true,
  chatThreadId: THREAD_ID,
  nextRunAt: "2026-06-12T09:00:00Z",
  lastRunAt: null,
};

const cronTrigger = {
  ...triggerBase,
  schedule: {
    type: "cron",
    cronExpression: "0 9 * * *",
    timezone: "UTC",
  },
  scheduleSummary: "0 9 * * * (UTC)",
};

const onceTrigger = {
  ...triggerBase,
  schedule: {
    type: "once",
    atTime: "2026-06-22T07:55:00.000Z",
    timezone: "Asia/Shanghai",
  },
  scheduleSummary: "Once at 2026-06-22T07:55:00.000Z",
};

const loopTrigger = {
  ...triggerBase,
  schedule: {
    type: "loop",
    intervalSeconds: 900,
  },
  scheduleSummary: "Every 900s",
};

describe("zero workflow trigger commands", () => {
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
    vi.unstubAllEnvs();
  });

  function captureCreateTrigger(response: object) {
    const captured: { workflowId?: string; body?: Record<string, unknown> } =
      {};
    server.use(
      http.post(
        "http://localhost:3000/api/zero/workflows/:workflowId/triggers",
        async ({ request, params }) => {
          captured.workflowId = params.workflowId as string;
          captured.body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(response, { status: 201 });
        },
      ),
    );
    return captured;
  }

  function mockWorkflowList() {
    let capturedUrl: string | undefined;
    server.use(
      http.get("http://localhost:3000/api/zero/workflows", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([workflowSummary]);
      }),
    );
    return {
      capturedUrl: () => {
        return capturedUrl;
      },
    };
  }

  describe("add", () => {
    it("should add a cron trigger to a workflow id", async () => {
      const captured = captureCreateTrigger(cronTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "cron",
        "--expr",
        "0 9 * * *",
        "--timezone",
        "UTC",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      });

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger added to workflow "${WORKFLOW_ID}"`);
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain("0 9 * * *");
    });

    it("should resolve a workflow name under ZERO_AGENT_ID", async () => {
      vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
      const workflows = mockWorkflowList();
      const captured = captureCreateTrigger(loopTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        "tell-a-joke",
        "loop",
        "--every",
        "15m",
      ]);

      expect(workflows.capturedUrl()).toContain(`agentId=${AGENT_ID}`);
      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        schedule: { type: "loop", intervalSeconds: 900 },
      });
    });

    it("should convert a timezone-local one-time fire to UTC", async () => {
      const captured = captureCreateTrigger(onceTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "once",
        "--at",
        "2026-06-22T15:55:00",
        "--timezone",
        "Asia/Shanghai",
      ]);

      expect(captured.body).toEqual({
        schedule: {
          type: "once",
          atTime: "2026-06-22T07:55:00.000Z",
          timezone: "Asia/Shanghai",
        },
      });
    });

    it("should reject an unknown trigger kind", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "webhook",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Unknown trigger kind: "webhook"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("update", () => {
    function captureUpdateTrigger(response: object) {
      const captured: { id?: string; body?: Record<string, unknown> } = {};
      server.use(
        http.patch(
          "http://localhost:3000/api/zero/workflow-triggers/:id",
          async ({ request, params }) => {
            captured.id = params.id as string;
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(response);
          },
        ),
      );
      return captured;
    }

    it("should switch to a cron schedule", async () => {
      const captured = captureUpdateTrigger(cronTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "update",
        TRIGGER_ID,
        "--expr",
        "0 9 * * *",
        "--timezone",
        "UTC",
      ]);

      expect(captured.id).toBe(TRIGGER_ID);
      expect(captured.body).toEqual({
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      });
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Trigger ${TRIGGER_ID} updated`,
      );
    });

    it("should reject more than one timing flag", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "update",
          TRIGGER_ID,
          "--expr",
          "0 9 * * *",
          "--every",
          "15m",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("exactly one of --expr"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("list", () => {
    it("should display workflow triggers", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflows/:workflowId/triggers",
          ({ params }) => {
            expect(params.workflowId).toBe(WORKFLOW_ID);
            return HttpResponse.json([cronTrigger, loopTrigger]);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "list", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("every 15m");
    });

    it("should display an empty state with an add hint", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflows/:workflowId/triggers",
          () => {
            return HttpResponse.json([]);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "list", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No triggers");
      expect(logCalls).toContain("zero workflow trigger add");
    });
  });

  describe("show", () => {
    it("should display trigger details", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-triggers/:id",
          ({ params }) => {
            expect(params.id).toBe(TRIGGER_ID);
            return HttpResponse.json(loopTrigger);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "show", TRIGGER_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain("every 15m");
      expect(logCalls).toContain(THREAD_ID);
    });
  });

  describe("rm", () => {
    it("should remove a workflow trigger", async () => {
      let removedId: string | undefined;
      server.use(
        http.delete(
          "http://localhost:3000/api/zero/workflow-triggers/:id",
          ({ params }) => {
            removedId = params.id as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "rm", TRIGGER_ID]);

      expect(removedId).toBe(TRIGGER_ID);
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Trigger ${TRIGGER_ID} removed`,
      );
    });
  });

  describe("enable / disable", () => {
    it("should enable a workflow trigger", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflow-triggers/:id/enable",
          () => {
            return HttpResponse.json(cronTrigger);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "enable", TRIGGER_ID]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Trigger ${TRIGGER_ID} enabled`,
      );
    });

    it("should disable a workflow trigger", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflow-triggers/:id/disable",
          () => {
            return HttpResponse.json({ ...cronTrigger, enabled: false });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "disable", TRIGGER_ID]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Trigger ${TRIGGER_ID} disabled`,
      );
    });
  });

  describe("run", () => {
    it("should fire a workflow trigger test run", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflow-triggers/:id/run",
          ({ params }) => {
            expect(params.id).toBe(TRIGGER_ID);
            return HttpResponse.json({ runId: RUN_ID });
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "run", TRIGGER_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Workflow trigger ${TRIGGER_ID} run started`);
      expect(logCalls).toContain(RUN_ID);
      expect(logCalls).toContain(`zero logs ${RUN_ID}`);
    });
  });
});
