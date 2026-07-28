/**
 * Tests for `zero workflow automation` commands
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
import { automationCommand } from "../index";
import chalk from "chalk";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const AUTOMATION_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "44444444-4444-4444-8444-444444444444";
const MODEL_ID = "gpt-5.6-sol";
const STRAPI_INTEGRATION_ID = "55555555-5555-4555-8555-555555555556";
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const THREAD_METADATA_URL = `http://localhost:3000/api/zero/chat-threads/${THREAD_ID}/metadata`;
const MODEL_POLICIES_URL = "http://localhost:3000/api/zero/model-policies";

function zeroToken(orgId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-123",
      runId: "run-123",
      orgId,
      scope: "zero",
      capabilities: [],
      iat: 1,
      exp: 4_102_444_800,
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

const workflowSummary = {
  id: WORKFLOW_ID,
  agentId: AGENT_ID,
  agentName: "Zero",
  agentDisplayName: "Zero",
  name: "tell-a-joke",
  displayName: "Tell a joke",
  description: "Tell one short joke",
  visibility: "private",
  ownerUserId: "user-123",
  canManage: true,
  canPublish: true,
};

const automationBase = {
  id: AUTOMATION_ID,
  kind: "schedule",
  ownerUserId: "user-123",
  enabled: true,
  chatThreadId: THREAD_ID,
  nextRunAt: "2026-06-12T09:00:00Z",
  lastRunAt: null,
};

const cronAutomation = {
  ...automationBase,
  schedule: {
    type: "cron",
    cronExpression: "0 9 * * *",
    timezone: "UTC",
  },
  scheduleSummary: "0 9 * * * (UTC)",
};

const onceAutomation = {
  ...automationBase,
  schedule: {
    type: "once",
    atTime: "2026-06-22T07:55:00.000Z",
    timezone: "Asia/Shanghai",
  },
  scheduleSummary: "Once at 2026-06-22T07:55:00.000Z",
};

const loopAutomation = {
  ...automationBase,
  schedule: {
    type: "loop",
    intervalSeconds: 900,
  },
  scheduleSummary: "Every 900s",
};

const gmailAutomation = {
  ...automationBase,
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

const gmailLabelAutomation = {
  ...automationBase,
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

const githubLabelAutomation = {
  ...automationBase,
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

const githubWorkflowRunAutomation = {
  ...automationBase,
  kind: "event",
  eventType: "github-workflow-run-completed",
  eventConfig: {
    provider: "github",
    event: "workflow_run_completed",
    filters: {
      repositories: ["vm0-ai/vm0"],
      workflows: ["Turbo"],
      conclusions: ["failure", "startup_failure"],
      branches: ["main"],
      events: ["push"],
      actors: ["lancy"],
    },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const googleCalendarAutomation = {
  ...automationBase,
  kind: "event",
  eventType: "google-calendar-event-created",
  eventConfig: {
    provider: "google-calendar",
    event: "event_created",
    calendarId: "primary",
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const notionAutomation = {
  ...automationBase,
  kind: "event",
  eventType: "notion-child-page-created",
  eventConfig: {
    provider: "notion",
    event: "child_page_created",
    connectorId: "55555555-5555-4555-8555-555555555555",
    parentPage: {
      id: "66666666-6666-4666-8666-666666666666",
      title: "Product notes",
      url: "https://www.notion.so/workspace/Product-notes-66666666666646668666666666666666",
      rawUrl:
        "https://www.notion.so/workspace/Product-notes-66666666666646668666666666666666?pvs=4",
    },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const notionDatabaseAutomation = {
  ...automationBase,
  kind: "event",
  eventType: "notion-database-item-created",
  eventConfig: {
    provider: "notion",
    event: "database_item_created",
    connectorId: "55555555-5555-4555-8555-555555555555",
    dataSource: {
      id: "77777777-7777-4777-8777-777777777777",
      title: "Bug Bash",
      url: "https://www.notion.so/Bug-Bash-77777777777747778777777777777777",
      rawUrl:
        "https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
    },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const notionContentUpdatedAutomation = {
  ...automationBase,
  kind: "event",
  eventType: "notion-page-content-updated",
  eventConfig: {
    provider: "notion",
    event: "page_content_updated",
    connectorId: "55555555-5555-4555-8555-555555555555",
    scope: {
      type: "page",
      page: {
        id: "88888888-8888-4888-8888-888888888888",
        title: "Release plan",
        url: "https://www.notion.so/workspace/Release-plan-88888888888848888888888888888888",
        rawUrl:
          "https://www.notion.so/workspace/Release-plan-88888888888848888888888888888888?pvs=4",
      },
    },
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

const webhookAutomation = {
  ...automationBase,
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
  webhookUrl:
    "http://localhost:3000/api/webhooks/workflow-automations/whk_test",
  secretLastFour: "abcd",
  lastReceivedAt: null,
  webhookSecret: "webhook-secret-abcd",
};

const strapiAutomation = {
  ...automationBase,
  kind: "event",
  eventType: "strapi-entry-published",
  eventConfig: {
    provider: "strapi",
    event: "entry_published",
    integrationId: STRAPI_INTEGRATION_ID,
    contentTypeUid: "api::article.article",
    locale: "en",
  },
  schedule: null,
  scheduleSummary: null,
  nextRunAt: null,
};

describe("zero workflow automation commands", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockConsoleWarn = vi
    .spyOn(console, "warn")
    .mockImplementation(() => {});
  const tempDirs: string[] = [];

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
    server.use(
      http.get(THREAD_METADATA_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          title: "Tell a joke",
          selectedModel: MODEL_ID,
        });
      }),
    );
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockConsoleWarn.mockClear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeGmailConfig(config: object): string {
    const dir = mkdtempSync(join(tmpdir(), "vm0-gmail-automation-"));
    tempDirs.push(dir);
    const path = join(dir, "gmail-automation.json");
    writeFileSync(path, JSON.stringify(config), "utf-8");
    return path;
  }

  function captureCreateAutomation(response: object) {
    const captured: { workflowId?: string; body?: Record<string, unknown> } =
      {};
    server.use(
      http.post(
        "http://localhost:3000/api/zero/workflows/:workflowId/automations",
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

  function failThreadModelLookup(
    boundary: "metadata" | "model-policy" = "metadata",
  ): void {
    if (boundary === "metadata") {
      server.use(
        http.get(THREAD_METADATA_URL, () => {
          return HttpResponse.json(
            {
              error: {
                code: "SERVER_ERROR",
                message: "Thread metadata unavailable",
              },
            },
            { status: 500 },
          );
        }),
      );
      return;
    }

    server.use(
      http.get(THREAD_METADATA_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          title: "Tell a joke",
          selectedModel: null,
        });
      }),
      http.get(MODEL_POLICIES_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "SERVER_ERROR",
              message: "Model policies unavailable",
            },
          },
          { status: 500 },
        );
      }),
    );
  }

  describe("add", () => {
    it("should add a cron automation to a workflow id", async () => {
      const captured = captureCreateAutomation(cronAutomation);

      await automationCommand.parseAsync([
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
      expect(logCalls).toContain(
        `Automation added to workflow "${WORKFLOW_ID}"`,
      );
      expect(logCalls).toContain(AUTOMATION_ID);
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain(`Thread model: GPT 5.6 Sol (${MODEL_ID})`);
      expect(logCalls).toContain("Manage with Zero CLI:");
      expect(logCalls).toContain(`zero workflow edit ${WORKFLOW_ID}`);
      expect(logCalls).toContain('--expr "<cron-expression>" -z <timezone>');
      expect(logCalls).toContain("Pause automation:");
      expect(logCalls).toContain(
        `zero workflow automation disable \\\n      ${AUTOMATION_ID}`,
      );
      expect(logCalls).toContain("About model selection:");
      expect(logCalls).toContain(
        "The selected model affects run behavior, output quality, and cost.",
      );
      expect(logCalls).toContain(
        "All automations on this workflow\n  share one chat thread",
      );
      expect(logCalls).toContain("Model commands:");
      expect(logCalls).toContain(`--thread ${THREAD_ID}`);
      expect(logCalls).toContain("zero model list");
    });

    it.each(["metadata", "model-policy"] as const)(
      "should preserve a successful add when %s lookup fails",
      async (boundary) => {
        const captured = captureCreateAutomation(cronAutomation);
        failThreadModelLookup(boundary);

        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "cron",
          "--expr",
          "0 9 * * *",
        ]);

        expect(captured.workflowId).toBe(WORKFLOW_ID);
        expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
          `Automation added to workflow "${WORKFLOW_ID}"`,
        );
        expect(mockConsoleWarn.mock.calls.flat().join("\n")).toContain(
          "Automation changed, but thread model details could not be loaded",
        );
        expect(mockExit).not.toHaveBeenCalled();
      },
    );

    it("should resolve a workflow name under ZERO_AGENT_ID", async () => {
      vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
      const workflows = mockWorkflowList();
      const captured = captureCreateAutomation(loopAutomation);

      await automationCommand.parseAsync([
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
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Change interval:");
      expect(logCalls).toContain("--every <duration>");
      expect(logCalls).not.toContain("<cron-expression>");
    });

    it("should convert a timezone-local one-time fire to UTC", async () => {
      const captured = captureCreateAutomation(onceAutomation);

      await automationCommand.parseAsync([
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
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Change run time:");
      expect(logCalls).toContain('--at "<iso-time>" -z <timezone>');
    });

    it("should add a Gmail new message automation without match rules", async () => {
      const captured = captureCreateAutomation({
        ...gmailAutomation,
        eventConfig: { provider: "gmail", event: "new_message" },
      });

      await automationCommand.parseAsync([
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
      expect(logCalls).toContain("Edit automation:");
      expect(logCalls).toContain("zero workflow automation update --help");
    });

    it("should add a Gmail new message automation with text match flags", async () => {
      const captured = captureCreateAutomation(gmailAutomation);

      await automationCommand.parseAsync([
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

    it("should add a Gmail new message automation from a config file", async () => {
      const configPath = writeGmailConfig({
        match: {
          from: { containsAny: ["@acme.com", "@example.com"] },
          subject: { doesNotContainAny: ["newsletter", "promo"] },
        },
      });
      const captured = captureCreateAutomation(gmailAutomation);

      await automationCommand.parseAsync([
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

    it("should add a Gmail label applied automation by label name", async () => {
      const captured = captureCreateAutomation(gmailLabelAutomation);

      await automationCommand.parseAsync([
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

    it("should add a GitHub label applied automation", async () => {
      const captured = captureCreateAutomation({
        ...githubLabelAutomation,
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

      await automationCommand.parseAsync([
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

    it("should add a GitHub workflow run completed automation", async () => {
      const captured = captureCreateAutomation(githubWorkflowRunAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "github-workflow-run-completed",
        "--repository",
        "vm0-ai/vm0",
        "--workflow",
        "Turbo",
        "--conclusion",
        "failure,startup_failure",
        "--branch",
        "main",
        "--triggering-event",
        "push",
        "--actor",
        "lancy",
      ]);

      expect(captured.body).toEqual({
        kind: "event",
        eventType: "github-workflow-run-completed",
        eventConfig: {
          provider: "github",
          event: "workflow_run_completed",
          filters: {
            repositories: ["vm0-ai/vm0"],
            workflows: ["Turbo"],
            conclusions: ["failure", "startup_failure"],
            branches: ["main"],
            events: ["push"],
            actors: ["lancy"],
          },
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("GitHub workflow completed");
      expect(logCalls).toContain("failure, startup_failure");
    });

    it("should reject new GitHub webhook automation kinds outside enabled workspaces", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "github-issue-comment-created",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "GitHub webhook automations are not enabled for this workspace",
        ),
      );
    });

    it("should add a GitHub issue comment automation for the staff workspace", async () => {
      vi.stubEnv("ZERO_TOKEN", zeroToken(STAFF_ORG_ID));
      const response = {
        ...automationBase,
        kind: "event",
        eventType: "github-issue-comment-created",
        eventConfig: {
          provider: "github",
          event: "issue_comment_created",
          filters: {
            repositories: ["vm0-ai/vm0"],
            subject: "pull_requests",
            trustedAuthors: ["e7h4n", "lancy"],
            commentPrefixes: ["/verify", "/deploy"],
          },
        },
        schedule: null,
        scheduleSummary: null,
        nextRunAt: null,
      };
      const captured = captureCreateAutomation(response);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "github-issue-comment-created",
        "--repository",
        "vm0-ai/vm0",
        "--subject",
        "pull-requests",
        "--trusted-author",
        "e7h4n,lancy",
        "--comment-prefix",
        "/verify,/deploy",
      ]);

      expect(captured.body).toEqual({
        kind: "event",
        eventType: "github-issue-comment-created",
        eventConfig: {
          provider: "github",
          event: "issue_comment_created",
          filters: {
            repositories: ["vm0-ai/vm0"],
            subject: "pull_requests",
            trustedAuthors: ["e7h4n", "lancy"],
            commentPrefixes: ["/verify", "/deploy"],
          },
        },
      });
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        "GitHub issue comment created",
      );
    });

    it("should reject Strapi automations outside enabled workspaces", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "strapi-entry-published",
          "--integration-id",
          STRAPI_INTEGRATION_ID,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Strapi workflow automations are not enabled for this workspace",
        ),
      );
    });

    it("should add a Strapi entry-published automation for the staff workspace", async () => {
      vi.stubEnv("ZERO_TOKEN", zeroToken(STAFF_ORG_ID));
      const captured = captureCreateAutomation(strapiAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "strapi-entry-published",
        "--integration-id",
        STRAPI_INTEGRATION_ID,
        "--content-type-uid",
        "api::article.article",
        "--locale",
        "en",
      ]);

      expect(captured.body).toEqual({
        kind: "event",
        eventType: "strapi-entry-published",
        eventConfig: {
          provider: "strapi",
          event: "entry_published",
          integrationId: STRAPI_INTEGRATION_ID,
          contentTypeUid: "api::article.article",
          locale: "en",
        },
      });
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        "Strapi entry published: api::article.article, en",
      );
    });

    it("should add a Google Calendar event-created automation", async () => {
      const captured = captureCreateAutomation({
        ...googleCalendarAutomation,
        eventConfig: {
          provider: "google-calendar",
          event: "event_created",
          calendarId: "team@example.com",
        },
      });

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "google-calendar-event-created",
        "--calendar-id",
        "team@example.com",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "google-calendar-event-created",
        eventConfig: {
          provider: "google-calendar",
          event: "event_created",
          calendarId: "team@example.com",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Google Calendar event created");
      expect(logCalls).toContain("team@example.com");
    });

    it("should add a Google Calendar event-updated automation", async () => {
      const captured = captureCreateAutomation({
        ...googleCalendarAutomation,
        eventType: "google-calendar-event-updated",
        eventConfig: {
          provider: "google-calendar",
          event: "event_updated",
          calendarId: "team@example.com",
        },
      });

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "google-calendar-event-updated",
        "--calendar-id",
        "team@example.com",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "google-calendar-event-updated",
        eventConfig: {
          provider: "google-calendar",
          event: "event_updated",
          calendarId: "team@example.com",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Google Calendar event updated");
      expect(logCalls).toContain("team@example.com");
    });

    it("should add a Google Calendar event-cancelled automation", async () => {
      const captured = captureCreateAutomation({
        ...googleCalendarAutomation,
        eventType: "google-calendar-event-cancelled",
        eventConfig: {
          provider: "google-calendar",
          event: "event_cancelled",
          calendarId: "team@example.com",
        },
      });

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "google-calendar-event-cancelled",
        "--calendar-id",
        "team@example.com",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "google-calendar-event-cancelled",
        eventConfig: {
          provider: "google-calendar",
          event: "event_cancelled",
          calendarId: "team@example.com",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Google Calendar event cancelled");
      expect(logCalls).toContain("team@example.com");
    });

    it("should add a Notion child page automation", async () => {
      const captured = captureCreateAutomation(notionAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "notion-child-page-created",
        "--parent-page-url",
        " https://www.notion.so/workspace/Product-notes-66666666666646668666666666666666?pvs=4 ",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "notion-child-page-created",
        eventConfig: {
          provider: "notion",
          event: "child_page_created",
          parentPageUrl:
            "https://www.notion.so/workspace/Product-notes-66666666666646668666666666666666?pvs=4",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("New Notion child page");
      expect(logCalls).toContain("Product notes");
      expect(logCalls).toContain(notionAutomation.eventConfig.parentPage.url);
    });

    it("should add a Notion database item automation", async () => {
      const captured = captureCreateAutomation(notionDatabaseAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "notion-database-item-created",
        "--database-url",
        " https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa ",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "notion-database-item-created",
        eventConfig: {
          provider: "notion",
          event: "database_item_created",
          databaseUrl:
            "https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("New Notion database item");
      expect(logCalls).toContain("Bug Bash");
      expect(logCalls).toContain(
        notionDatabaseAutomation.eventConfig.dataSource.url,
      );
    });

    it("should add a Notion page content updated automation for a page", async () => {
      const captured = captureCreateAutomation(notionContentUpdatedAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "notion-page-content-updated",
        "--page-url",
        " https://www.notion.so/workspace/Release-plan-88888888888848888888888888888888?pvs=4 ",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "notion-page-content-updated",
        eventConfig: {
          provider: "notion",
          event: "page_content_updated",
          pageUrl:
            "https://www.notion.so/workspace/Release-plan-88888888888848888888888888888888?pvs=4",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Notion page content updated");
      expect(logCalls).toContain("Release plan");
      expect(logCalls).toContain(
        notionContentUpdatedAutomation.eventConfig.scope.page.url,
      );
    });

    it("should add a Notion page content updated automation for a database", async () => {
      const captured = captureCreateAutomation({
        ...notionContentUpdatedAutomation,
        eventConfig: {
          ...notionContentUpdatedAutomation.eventConfig,
          scope: {
            type: "data_source",
            dataSource: notionDatabaseAutomation.eventConfig.dataSource,
          },
        },
      });

      await automationCommand.parseAsync([
        "node",
        "cli",
        "add",
        WORKFLOW_ID,
        "notion-page-content-updated",
        "--database-url",
        " https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa ",
      ]);

      expect(captured.workflowId).toBe(WORKFLOW_ID);
      expect(captured.body).toEqual({
        kind: "event",
        eventType: "notion-page-content-updated",
        eventConfig: {
          provider: "notion",
          event: "page_content_updated",
          databaseUrl:
            "https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Notion page content updated");
      expect(logCalls).toContain("Bug Bash");
      expect(logCalls).toContain(
        notionDatabaseAutomation.eventConfig.dataSource.url,
      );
    });

    it("should add a webhook automation", async () => {
      const captured = captureCreateAutomation(webhookAutomation);

      await automationCommand.parseAsync([
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
      expect(logCalls).toContain(webhookAutomation.webhookUrl);
      expect(logCalls).toContain(webhookAutomation.webhookSecret);
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
          await automationCommand.parseAsync([
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
            `Unsupported Gmail automation match field "${field}"`,
          ),
        );
        expect(mockExit).toHaveBeenCalledWith(1);
      },
    );

    it("should reject an unknown automation kind", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "not-an-automation",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Unknown automation kind: "not-an-automation"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject a Notion child page automation without a parent page URL", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "notion-child-page-created",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "notion-child-page-created automations require --parent-page-url",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject a Notion database item automation without a database URL", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "notion-database-item-created",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "notion-database-item-created automations require --database-url",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject a Notion page content updated automation without a scope URL", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "notion-page-content-updated",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "notion-page-content-updated automations require exactly one of --page-url",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject a Notion page content updated automation with both page and database URLs", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "add",
          WORKFLOW_ID,
          "notion-page-content-updated",
          "--page-url",
          "https://www.notion.so/workspace/Release-plan-88888888888848888888888888888888",
          "--database-url",
          "https://www.notion.so/77777777777747778777777777777777",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "notion-page-content-updated automations require exactly one of --page-url",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Gmail match flags on schedule automations", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
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
          "Event automation flags only apply to event automations",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject label flags on schedule automations", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
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
          "Event automation flags only apply to event automations",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject empty Gmail text match flags", async () => {
      await expect(async () => {
        await automationCommand.parseAsync([
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
    function mockExistingAutomation(existing: object) {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-automations/:id",
          ({ params }) => {
            expect(params.id).toBe(AUTOMATION_ID);
            return HttpResponse.json(existing);
          },
        ),
      );
    }

    function captureUpdateAutomation(response: object, existing = response) {
      const captured: { id?: string; body?: Record<string, unknown> } = {};
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-automations/:id",
          ({ params }) => {
            expect(params.id).toBe(AUTOMATION_ID);
            return HttpResponse.json(existing);
          },
        ),
        http.patch(
          "http://localhost:3000/api/zero/workflow-automations/:id",
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
      const captured = captureUpdateAutomation(cronAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
        "--expr",
        "0 9 * * *",
        "--timezone",
        "UTC",
      ]);

      expect(captured.id).toBe(AUTOMATION_ID);
      expect(captured.body).toEqual({
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      });
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Automation ${AUTOMATION_ID} updated`,
      );
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Thread model: GPT 5.6 Sol (${MODEL_ID})`);
      expect(logCalls).not.toContain("Manage with Zero CLI:");
    });

    it("should preserve a successful update when thread model lookup fails", async () => {
      const captured = captureUpdateAutomation(cronAutomation);
      failThreadModelLookup();

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
        "--expr",
        "0 9 * * *",
      ]);

      expect(captured.id).toBe(AUTOMATION_ID);
      expect(captured.body).toEqual({
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      });
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Automation ${AUTOMATION_ID} updated`,
      );
      expect(mockConsoleWarn.mock.calls.flat().join("\n")).toContain(
        "Automation changed, but thread model details could not be loaded",
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should update a Gmail new message automation with text match flags", async () => {
      const updated = {
        ...gmailAutomation,
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          threadId: "gmail-thread-1",
          match: {
            from: { contains: "@example.com" },
            subject: { doesNotContain: "marketing" },
          },
        },
      };
      const captured = captureUpdateAutomation(updated);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
        "--from-contains",
        "@example.com",
        "--subject-not-contains",
        "marketing",
      ]);

      expect(captured.id).toBe(AUTOMATION_ID);
      expect(captured.body).toEqual({
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          threadId: "gmail-thread-1",
          match: {
            from: { contains: "@example.com" },
            subject: { doesNotContain: "marketing" },
          },
        },
      });
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`Automation ${AUTOMATION_ID} updated`);
      expect(logCalls).toContain('subject does not contain "marketing"');
    });

    it("should update a Gmail label applied automation by label name", async () => {
      const updated = {
        ...gmailLabelAutomation,
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Escalated",
          resolvedLabelId: "Label_escalated",
        },
      };
      const captured = captureUpdateAutomation(updated);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
        "--label",
        "Escalated",
      ]);

      expect(captured.id).toBe(AUTOMATION_ID);
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

    it("should update a GitHub label applied automation", async () => {
      const updated = {
        ...githubLabelAutomation,
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
      const captured = captureUpdateAutomation(updated, githubLabelAutomation);

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
        "--subject",
        "issues",
        "--actor",
        "anyone",
      ]);

      expect(captured.id).toBe(AUTOMATION_ID);
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

    it("should update and clear GitHub workflow run filters", async () => {
      const updated = {
        ...githubWorkflowRunAutomation,
        eventConfig: {
          ...githubWorkflowRunAutomation.eventConfig,
          filters: {
            ...githubWorkflowRunAutomation.eventConfig.filters,
            conclusions: ["success"],
            branches: undefined,
          },
        },
      };
      const captured = captureUpdateAutomation(
        updated,
        githubWorkflowRunAutomation,
      );

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
        "--conclusion",
        "success",
        "--branch",
        "any",
      ]);

      expect(captured.body).toEqual({
        eventConfig: {
          provider: "github",
          event: "workflow_run_completed",
          filters: {
            repositories: ["vm0-ai/vm0"],
            workflows: ["Turbo"],
            conclusions: ["success"],
            branches: undefined,
            events: ["push"],
            actors: ["lancy"],
          },
        },
      });
    });

    it("should update a Gmail new message automation from a config file", async () => {
      const configPath = writeGmailConfig({
        match: {
          body: { containsAny: ["invoice", "receipt"] },
        },
      });
      const captured = captureUpdateAutomation({
        ...gmailAutomation,
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            body: { containsAny: ["invoice", "receipt"] },
          },
        },
      });

      await automationCommand.parseAsync([
        "node",
        "cli",
        "update",
        AUTOMATION_ID,
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
      mockExistingAutomation(cronAutomation);

      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "update",
          AUTOMATION_ID,
          "--expr",
          "0 9 * * *",
          "--from-contains",
          "@acme.com",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Use either schedule flags or event automation options",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject more than one timing flag", async () => {
      mockExistingAutomation(cronAutomation);

      await expect(async () => {
        await automationCommand.parseAsync([
          "node",
          "cli",
          "update",
          AUTOMATION_ID,
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
    it("should display workflow automations", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflows/:workflowId/automations",
          ({ params }) => {
            expect(params.workflowId).toBe(WORKFLOW_ID);
            return HttpResponse.json([
              cronAutomation,
              loopAutomation,
              gmailAutomation,
              githubLabelAutomation,
              notionAutomation,
              notionDatabaseAutomation,
              notionContentUpdatedAutomation,
              strapiAutomation,
            ]);
          },
        ),
      );

      await automationCommand.parseAsync(["node", "cli", "list", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(AUTOMATION_ID);
      expect(logCalls).toContain("0 9 * * *");
      expect(logCalls).toContain("every 15m");
      expect(logCalls).toContain("Gmail new message");
      expect(logCalls).toContain('from contains "@acme.com"');
      expect(logCalls).toContain("GitHub label applied");
      expect(logCalls).toContain("Notion page content updated");
      expect(logCalls).toContain("Release plan");
      expect(logCalls).toContain("triage");
      expect(logCalls).toContain("New Notion child page");
      expect(logCalls).toContain("Product notes");
      expect(logCalls).toContain("New Notion database item");
      expect(logCalls).toContain("Bug Bash");
      expect(logCalls).toContain(
        "Strapi entry published: api::article.article, en",
      );
    });

    it("should display an empty state with an add hint", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflows/:workflowId/automations",
          () => {
            return HttpResponse.json([]);
          },
        ),
      );

      await automationCommand.parseAsync(["node", "cli", "list", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No automations");
      expect(logCalls).toContain("zero workflow automation add");
    });
  });

  describe("show", () => {
    it("should display automation details", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-automations/:id",
          () => {
            return HttpResponse.json({ ...gmailAutomation, enabled: false });
          },
        ),
        http.get("http://localhost:3000/api/zero/workflow-automations", () => {
          return HttpResponse.json([
            {
              workflow: workflowSummary,
              automation: { ...gmailAutomation, enabled: false },
            },
          ]);
        }),
      );

      await automationCommand.parseAsync([
        "node",
        "cli",
        "show",
        AUTOMATION_ID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(AUTOMATION_ID);
      expect(logCalls).toContain("Gmail new message");
      expect(logCalls).toContain('subject contains "invoice"');
      expect(logCalls).toContain(THREAD_ID);
      expect(logCalls).toContain(`Workflow:     ${workflowSummary.name}`);
      expect(logCalls).toContain(`Thread model: GPT 5.6 Sol (${MODEL_ID})`);
      expect(logCalls).toContain("Resume automation:");
      expect(logCalls).toContain("zero workflow automation enable");
      expect(logCalls).toContain("zero workflow automation update --help");
    });

    it("should display an automation owned by another user on a visible workflow", async () => {
      const sharedAutomation = {
        ...gmailAutomation,
        ownerUserId: "another-user",
      };
      server.use(
        http.get(
          "http://localhost:3000/api/zero/workflow-automations/:id",
          ({ params }) => {
            expect(params.id).toBe(AUTOMATION_ID);
            return HttpResponse.json(sharedAutomation);
          },
        ),
        http.get("http://localhost:3000/api/zero/workflow-automations", () => {
          return HttpResponse.json([]);
        }),
      );

      await automationCommand.parseAsync([
        "node",
        "cli",
        "show",
        AUTOMATION_ID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(AUTOMATION_ID);
      expect(logCalls).toContain("another-user");
      expect(logCalls).toContain("Gmail new message");
      expect(logCalls).not.toContain("Manage with Zero CLI:");
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("rm", () => {
    it("should remove a workflow automation", async () => {
      let removedId: string | undefined;
      server.use(
        http.delete(
          "http://localhost:3000/api/zero/workflow-automations/:id",
          ({ params }) => {
            removedId = params.id as string;
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );

      await automationCommand.parseAsync(["node", "cli", "rm", AUTOMATION_ID]);

      expect(removedId).toBe(AUTOMATION_ID);
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Automation ${AUTOMATION_ID} removed`,
      );
    });
  });

  describe("enable / disable", () => {
    it("should enable a workflow automation", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflow-automations/:id/enable",
          () => {
            return HttpResponse.json(cronAutomation);
          },
        ),
      );

      await automationCommand.parseAsync([
        "node",
        "cli",
        "enable",
        AUTOMATION_ID,
      ]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Automation ${AUTOMATION_ID} enabled`,
      );
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Thread model: GPT 5.6 Sol (${MODEL_ID})`,
      );
    });

    it("should disable a workflow automation", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflow-automations/:id/disable",
          () => {
            return HttpResponse.json({ ...cronAutomation, enabled: false });
          },
        ),
      );

      await automationCommand.parseAsync([
        "node",
        "cli",
        "disable",
        AUTOMATION_ID,
      ]);

      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Automation ${AUTOMATION_ID} disabled`,
      );
      expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
        `Thread model: GPT 5.6 Sol (${MODEL_ID})`,
      );
    });

    it.each(["enable", "disable"] as const)(
      "should preserve a successful %s when thread model lookup fails",
      async (command) => {
        server.use(
          http.post(
            `http://localhost:3000/api/zero/workflow-automations/:id/${command}`,
            () => {
              return HttpResponse.json({
                ...cronAutomation,
                enabled: command === "enable",
              });
            },
          ),
        );
        failThreadModelLookup();

        await automationCommand.parseAsync([
          "node",
          "cli",
          command,
          AUTOMATION_ID,
        ]);

        expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
          `Automation ${AUTOMATION_ID} ${command}d`,
        );
        expect(mockConsoleWarn.mock.calls.flat().join("\n")).toContain(
          "Automation changed, but thread model details could not be loaded",
        );
        expect(mockExit).not.toHaveBeenCalled();
      },
    );
  });
});
