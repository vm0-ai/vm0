/**
 * Tests for `zero workflow trigger` commands
 * (add / update / list / show / rm / enable / disable).
 *
 * Tests command-level behavior via parseAsync() following CLI testing
 * principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { triggerCommand } from "../index";
import chalk from "chalk";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const TRIGGER_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "44444444-4444-4444-8444-444444444444";

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

const gmailTrigger = {
  ...triggerBase,
  kind: "event",
  eventType: "gmail-new-message",
  eventConfig: {
    provider: "gmail",
    event: "new_message",
    match: {
      from: { contains: "@acme.com" },
      subject: { contains: "invoice" },
    },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const gmailLabelTrigger = {
  ...triggerBase,
  kind: "event",
  eventType: "gmail-label-applied",
  eventConfig: {
    provider: "gmail",
    event: "label_applied",
    labelName: "Support",
    resolvedLabelId: "Label_support",
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const githubLabelTrigger = {
  ...triggerBase,
  kind: "event",
  eventType: "github-label-applied",
  eventConfig: {
    provider: "github",
    event: "label_applied",
    labelName: "triage",
    filters: {
      subject: "both",
      actor: { type: "me" },
    },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const webhookTrigger = {
  ...triggerBase,
  kind: "event",
  eventType: "webhook-received",
  eventConfig: {
    provider: "webhook",
    event: "received",
    auth: { mode: "hmac-sha256" },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
  webhookUrl: "http://localhost:3000/api/webhooks/workflow-triggers/whk_test",
  secretLastFour: "abcd",
  lastReceivedAt: null,
  webhookSecret: "webhook-secret-abcd",
};

describe("zero workflow trigger commands", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const tempDirs: string[] = [];

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeGmailConfig(config: object): string {
    const dir = mkdtempSync(join(tmpdir(), "vm0-gmail-trigger-"));
    tempDirs.push(dir);
    const path = join(dir, "gmail-trigger.json");
    writeFileSync(path, JSON.stringify(config), "utf-8");
    return path;
  }

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

    it("should add a Gmail new message trigger without match rules", async () => {
      const captured = captureCreateTrigger({
        ...gmailTrigger,
        eventConfig: { provider: "gmail", event: "new_message" },
      });

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "gmail-new-message",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: { provider: "gmail", event: "new_message" },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Gmail new message");
      expect(logCalls).toContain("all inbound messages");
    });

    it("should add a Gmail new message trigger with text match flags", async () => {
      const captured = captureCreateTrigger(gmailTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "gmail-new-message",
        "--from-contains",
        "@acme.com",
        "--subject-contains",
        "invoice",
        "--body-not-contains",
        "unsubscribe",
      ]);

      expect(captured.body).toEqual({
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            from: { contains: "@acme.com" },
            subject: { contains: "invoice" },
            body: { doesNotContain: "unsubscribe" },
          },
        },
      });
    });

    it("should add a Gmail new message trigger from a config file", async () => {
      const configPath = writeGmailConfig({
        match: {
          from: { containsAny: ["@acme.com", "@example.com"] },
          subject: { doesNotContainAny: ["newsletter", "promo"] },
        },
      });
      const captured = captureCreateTrigger(gmailTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "gmail-new-message",
        "--config",
        configPath,
      ]);

      expect(captured.body).toEqual({
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            from: { containsAny: ["@acme.com", "@example.com"] },
            subject: { doesNotContainAny: ["newsletter", "promo"] },
          },
        },
      });
    });

    it("should add a Gmail label applied trigger by label name", async () => {
      const captured = captureCreateTrigger(gmailLabelTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "gmail-label-applied",
        "--label",
        "Support",
      ]);

      expect(captured.body).toEqual({
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Gmail label applied");
      expect(logCalls).toContain("Support");
    });

    it("should add a GitHub label applied trigger", async () => {
      const captured = captureCreateTrigger({
        ...githubLabelTrigger,
        eventConfig: {
          provider: "github",
          event: "label_applied",
          labelName: "triage",
          filters: {
            subject: "pull_requests",
            actor: { type: "anyone" },
          },
        },
      });

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "github-label-applied",
        "--label",
        "triage",
        "--subject",
        "pull-requests",
        "--actor",
        "anyone",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "github-label-applied",
        eventConfig: {
          provider: "github",
          event: "label_applied",
          labelName: "triage",
          filters: {
            subject: "pull_requests",
            actor: { type: "anyone" },
          },
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("GitHub label applied");
      expect(logCalls).toContain("triage");
      expect(logCalls).toContain("pull requests");
      expect(logCalls).toContain("anyone");
    });

    it("should add a webhook trigger", async () => {
      const captured = captureCreateTrigger(webhookTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "webhook",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "webhook-received",
        eventConfig: {
          provider: "webhook",
          event: "received",
          auth: { mode: "hmac-sha256" },
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Webhook");
      expect(logCalls).toContain(webhookTrigger.webhookUrl);
      expect(logCalls).toContain(webhookTrigger.webhookSecret);
      expect(logCalls).toContain("X-VM0-Signature");
    });

    it.each([
      {
        field: "hasAttachment",
        config: { match: { hasAttachment: true } },
      },
      {
        field: "labels",
        config: { match: { labels: { includeAny: ["INBOX"] } } },
      },
      {
        field: "snippet",
        config: { match: { snippet: { contains: "preview" } } },
      },
    ])(
      "should reject unsupported Gmail config match field $field",
      async ({ field, config }) => {
        const configPath = writeGmailConfig(config);

        await expect(async () => {
          await triggerCommand.parseAsync([
            "node",
            "cli",
            "add",
            WORKFLOW_ID,
            "gmail-new-message",
            "--config",
            configPath,
          ]);
        }).rejects.toThrow("process.exit called");

        expect(mockConsoleError).toHaveBeenCalledWith(
          expect.stringContaining(
            `Unsupported Gmail trigger match field "${field}"`,
          ),
        );
        expect(mockExit).toHaveBeenCalledWith(1);
      },
    );

    it("should reject an unknown trigger kind", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "not-a-trigger",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Unknown trigger kind: "not-a-trigger"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Gmail match flags on schedule triggers", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "cron",
          "--expr",
          "0 9 * * *",
          "--from-contains",
          "@acme.com",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Event trigger flags only apply to event triggers",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject label flags on schedule triggers", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "cron",
          "--expr",
          "0 9 * * *",
          "--label",
          "Support",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Event trigger flags only apply to event triggers",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject empty Gmail text match flags", async () => {
      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "gmail-new-message",
          "--from-contains",
          "",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("from contains must be non-empty"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("update", () => {
    function mockExistingTrigger(existing: object) {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-triggers/:id",
          ({ params }) => {
            expect(params.id).toBe(TRIGGER_ID);
            return HttpResponse.json(existing);
          },
        ),
      );
    }

    function captureUpdateTrigger(response: object, existing = response) {
      const captured: { id?: string; body?: Record<string, unknown> } = {};
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-triggers/:id",
          ({ params }) => {
            expect(params.id).toBe(TRIGGER_ID);
            return HttpResponse.json(existing);
          },
        ),
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

    it("should update a Gmail new message trigger with text match flags", async () => {
      const updated = {
        ...gmailTrigger,
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            from: { contains: "@example.com" },
            subject: { doesNotContain: "marketing" },
          },
        },
      };
      const captured = captureUpdateTrigger(updated);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "update",
        TRIGGER_ID,
        "--from-contains",
        "@example.com",
        "--subject-not-contains",
        "marketing",
      ]);

      expect(captured.id).toBe(TRIGGER_ID);
      expect(captured.body).toEqual({
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            from: { contains: "@example.com" },
            subject: { doesNotContain: "marketing" },
          },
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Trigger ${TRIGGER_ID} updated`);
      expect(logCalls).toContain('subject does not contain "marketing"');
    });

    it("should update a Gmail label applied trigger by label name", async () => {
      const updated = {
        ...gmailLabelTrigger,
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Escalated",
          resolvedLabelId: "Label_escalated",
        },
      };
      const captured = captureUpdateTrigger(updated);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "update",
        TRIGGER_ID,
        "--label",
        "Escalated",
      ]);

      expect(captured.id).toBe(TRIGGER_ID);
      expect(captured.body).toEqual({
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Escalated",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Gmail label applied");
      expect(logCalls).toContain("Escalated");
    });

    it("should update a GitHub label applied trigger", async () => {
      const updated = {
        ...githubLabelTrigger,
        eventConfig: {
          provider: "github",
          event: "label_applied",
          labelName: "triage",
          filters: {
            subject: "issues",
            actor: { type: "anyone" },
          },
        },
      };
      const captured = captureUpdateTrigger(updated, githubLabelTrigger);

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "update",
        TRIGGER_ID,
        "--subject",
        "issues",
        "--actor",
        "anyone",
      ]);

      expect(captured.id).toBe(TRIGGER_ID);
      expect(captured.body).toEqual({
        eventConfig: {
          provider: "github",
          event: "label_applied",
          labelName: "triage",
          filters: {
            subject: "issues",
            actor: { type: "anyone" },
          },
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("GitHub label applied");
      expect(logCalls).toContain("issues");
      expect(logCalls).toContain("anyone");
    });

    it("should update a Gmail new message trigger from a config file", async () => {
      const configPath = writeGmailConfig({
        match: {
          body: { containsAny: ["invoice", "receipt"] },
        },
      });
      const captured = captureUpdateTrigger({
        ...gmailTrigger,
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            body: { containsAny: ["invoice", "receipt"] },
          },
        },
      });

      await triggerCommand.parseAsync([
        "node",
        "cli",
        "update",
        TRIGGER_ID,
        "--config",
        configPath,
      ]);

      expect(captured.body).toEqual({
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            body: { containsAny: ["invoice", "receipt"] },
          },
        },
      });
    });

    it("should reject mixing schedule and Gmail match options", async () => {
      mockExistingTrigger(cronTrigger);

      await expect(async () => {
        await triggerCommand.parseAsync([
          "node",
          "cli",
          "update",
          TRIGGER_ID,
          "--expr",
          "0 9 * * *",
          "--from-contains",
          "@acme.com",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Use either schedule flags or event trigger options",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject more than one timing flag", async () => {
      mockExistingTrigger(cronTrigger);

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
            return HttpResponse.json([
              cronTrigger,
              loopTrigger,
              gmailTrigger,
              githubLabelTrigger,
            ]);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "list", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("every 15m");
      expect(logCalls).toContain("Gmail new message");
      expect(logCalls).toContain('from contains "@acme.com"');
      expect(logCalls).toContain("GitHub label applied");
      expect(logCalls).toContain("triage");
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
            return HttpResponse.json(gmailTrigger);
          },
        ),
      );

      await triggerCommand.parseAsync(["node", "cli", "show", TRIGGER_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(TRIGGER_ID);
      expect(logCalls).toContain("Gmail new message");
      expect(logCalls).toContain('subject contains "invoice"');
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
});
