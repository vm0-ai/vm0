import { randomUUID } from "node:crypto";

import {
  zeroWorkflowAutomationsContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const gh = createGithubBddApi(context);
const runs = createRunsApi(context);
const webhookCallbacks = createWebhookCallbackApi(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function detailClient() {
  return setupApp({ context })(zeroWorkflowsDetailContract);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event) && event.run_id === runId;
    });
  });
}

const WORKFLOW_NAME = "automation-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_EMAIL = "workflow-user@example.com";
const GOOGLE_CALENDAR_EMAIL = "calendar-user@example.com";
const NOTION_PARENT_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTION_PARENT_PAGE_URL =
  "https://www.notion.so/Roadmap-11111111111141118111111111111111";
const NOTION_DATABASE_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_DATA_SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const NOTION_DATABASE_URL =
  "https://www.notion.so/22222222222242228222222222222222?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa&source=copy_link";
const NOTION_DATA_SOURCE_URL =
  "https://www.notion.so/Bug-Bash-33333333333343338333333333333333";

interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface AutomationScenario {
  readonly fixture: WorkflowsFixture;
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
}

function futureIso(offsetMs: number): string {
  return new Date(now() + offsetMs).toISOString();
}

async function enableNotionWorkflowAutomations(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.NotionWorkflowAutomations]: true,
  });
}

interface WatchCallRecorder {
  calls: number;
}

function configureGmailWatchMock(historyId = "100"): WatchCallRecorder {
  const recorder: WatchCallRecorder = { calls: 0 };
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      async ({ request }) => {
        recorder.calls += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer gmail-access-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          topicName: GMAIL_TOPIC_NAME,
        });
        return HttpResponse.json({
          historyId,
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
  );
  return recorder;
}

interface CalendarWatchRecorder {
  watchCalls: number;
  baselineCalls: number;
}

function configureGoogleCalendarWatchMock(args?: {
  readonly calendarId?: string;
  readonly baselineItems?: readonly Record<string, unknown>[];
}): CalendarWatchRecorder {
  const recorder: CalendarWatchRecorder = { watchCalls: 0, baselineCalls: 0 };
  const calendarId = args?.calendarId ?? "primary";
  mockOptionalEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");
  server.use(
    http.post(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
      async ({ request, params }) => {
        recorder.watchCalls += 1;
        expect(params.calendarId).toBe(calendarId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const body = (await request.json()) as {
          readonly id?: string;
          readonly type?: string;
          readonly address?: string;
          readonly token?: string;
          readonly params?: { readonly ttl?: string };
        };
        expect(body).toMatchObject({
          type: "web_hook",
          address: "https://api.vm0.ai/api/webhooks/google-calendar",
          params: { ttl: "604800" },
        });
        expect(body.id).toBeTruthy();
        expect(body.token).toBeTruthy();
        return HttpResponse.json({
          id: body.id,
          resourceId: "calendar-resource-1",
          resourceUri: `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
      ({ request, params }) => {
        recorder.baselineCalls += 1;
        expect(params.calendarId).toBe(calendarId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const url = new URL(request.url);
        expect(url.searchParams.get("showDeleted")).toBe("true");
        expect(url.searchParams.get("maxResults")).toBe("2500");
        expect(url.searchParams.get("syncToken")).toBeNull();
        return HttpResponse.json({
          items: args?.baselineItems ?? [],
          nextSyncToken: "calendar-sync-baseline",
        });
      },
    ),
  );
  return recorder;
}

function configureGmailLabelsMock(
  labels: readonly { readonly id: string; readonly name: string }[],
): void {
  server.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
      return HttpResponse.json({ labels });
    }),
  );
}

function configureNotionPageMock(args?: {
  readonly pageId?: string;
  readonly title?: string;
  readonly url?: string;
  readonly parent?: Record<string, unknown>;
}): void {
  const pageId = args?.pageId ?? NOTION_PARENT_PAGE_ID;
  const title = args?.title ?? "Roadmap";
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(params.pageId).toBe(pageId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "page",
          id: pageId,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time: "2026-07-01T00:00:00.000Z",
          archived: false,
          in_trash: false,
          url: args?.url ?? NOTION_PARENT_PAGE_URL,
          parent: args?.parent ?? { type: "workspace" },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ type: "text", plain_text: title }],
            },
          },
        });
      },
    ),
  );
}

function configureNotionDatabaseMock(args?: {
  readonly databaseId?: string;
  readonly dataSourceId?: string;
  readonly title?: string;
  readonly databaseUrl?: string;
  readonly dataSourceUrl?: string;
}): void {
  const databaseId = args?.databaseId ?? NOTION_DATABASE_ID;
  const dataSourceId = args?.dataSourceId ?? NOTION_DATA_SOURCE_ID;
  const title = args?.title ?? "Bug Bash";
  server.use(
    http.get(
      "https://api.notion.com/v1/databases/:databaseId",
      ({ request, params }) => {
        expect(params.databaseId).toBe(databaseId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "database",
          id: databaseId,
          url: args?.databaseUrl ?? NOTION_DATABASE_URL,
          title: [{ plain_text: title }],
          data_sources: [{ id: dataSourceId, name: title }],
        });
      },
    ),
    http.get(
      "https://api.notion.com/v1/data_sources/:dataSourceId",
      ({ request, params }) => {
        expect(params.dataSourceId).toBe(dataSourceId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "data_source",
          id: dataSourceId,
          name: title,
          url: args?.dataSourceUrl ?? NOTION_DATA_SOURCE_URL,
          parent: { type: "database_id", database_id: databaseId },
        });
      },
    ),
  );
}

describe("zero workflow automations", () => {
  async function setupFixture(
    tier: "pro" | "team" = "pro",
  ): Promise<AutomationScenario> {
    const { actor, customerId, subscriptionId } = await wf.setupWorkflowOrg({
      tier,
    });
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const agent = await wf.createAgent(actor, {
      displayName: "Automation Agent",
    });
    const workflowId = await wf.createWorkflow(actor, {
      agentId: agent.agentId,
      name: WORKFLOW_NAME,
    });
    const fixture = { orgId: actor.orgId, userId: actor.userId };
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    return {
      fixture,
      actor,
      agentId: agent.agentId,
      workflowId,
      customerId,
      subscriptionId,
    };
  }

  /**
   * Creates a second agent + workflow through the public routes, optionally
   * owned by another org member, then restores the scenario owner's session.
   */
  async function createAgentWithWorkflow(
    scenario: AutomationScenario,
    options: {
      readonly agentDisplayName?: string;
      readonly workflowName?: string;
      readonly visibility?: "public" | "private";
      readonly userId?: string;
    } = {},
  ): Promise<{ agentId: string; workflowId: string }> {
    const owner = options.userId
      ? wf.user({
          userId: options.userId,
          orgId: scenario.fixture.orgId,
          orgRole: "org:member",
        })
      : scenario.actor;
    const agent = await wf.createAgent(owner, {
      displayName: options.agentDisplayName ?? "Second Automation Agent",
      visibility: options.visibility,
    });
    const workflowId = await wf.createWorkflow(owner, {
      agentId: agent.agentId,
      name: options.workflowName ?? WORKFLOW_NAME,
      visibility: options.visibility,
    });
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );
    return { agentId: agent.agentId, workflowId };
  }

  async function connectGmail(scenario: AutomationScenario): Promise<string> {
    mockGmailConnectorOAuth({ email: GMAIL_EMAIL });
    await wf.connectConnector(scenario.actor, "gmail");
    const connector = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "gmail",
    );
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );
    return connector.id;
  }

  async function connectGoogleCalendar(
    scenario: AutomationScenario,
  ): Promise<string> {
    mockGoogleCalendarConnectorOAuth({ email: GOOGLE_CALENDAR_EMAIL });
    await wf.connectConnector(scenario.actor, "google-calendar");
    const connector = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "google-calendar",
    );
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );
    return connector.id;
  }

  async function connectNotion(scenario: AutomationScenario): Promise<string> {
    mockNotionConnectorOAuth();
    await wf.connectConnector(scenario.actor, "notion");
    const connector = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "notion",
    );
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );
    return connector.id;
  }

  it("creates a cron automation and eagerly binds a chat thread", async () => {
    const { workflowId } = await setupFixture();

    context.mocks.ably.publish.mockClear();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * 1-5",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "schedule",
      enabled: true,
      schedule: {
        type: "cron",
        cronExpression: "0 9 * * 1-5",
        timezone: "UTC",
      },
    });
    expect(created.body.chatThreadId).toBeTruthy();
    expect(created.body.nextRunAt).toBeTruthy();
    expect(created.body.kind).toBe("schedule");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadAutomationsChanged:${created.body.chatThreadId}`,
      null,
    );
    if (created.body.kind !== "schedule") {
      throw new Error("Expected a schedule automation");
    }
    expect(created.body.scheduleSummary.length).toBeGreaterThan(0);
  });

  it("lists thread-bound workflow automations", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [201],
    );
    const second = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId) {
      throw new Error("Expected the workflow automation to bind a chat thread");
    }
    expect(second.body.chatThreadId).toBe(threadId);

    const listed = await accept(
      automationsClient().listForChatThread({
        headers: authHeaders(),
        params: { threadId },
      }),
      [200],
    );

    expect(listed.body).toHaveLength(2);
    expect(
      listed.body.map((automation) => {
        return {
          id: automation.id,
          kind: automation.kind,
          scheduleSummary: automation.scheduleSummary,
          chatThreadId: automation.chatThreadId,
          workflow: automation.workflow,
        };
      }),
    ).toStrictEqual([
      {
        id: created.body.id,
        kind: "schedule",
        scheduleSummary: "Every 60s",
        chatThreadId: threadId,
        workflow: expect.objectContaining({
          id: workflowId,
          name: WORKFLOW_NAME,
        }),
      },
      {
        id: second.body.id,
        kind: "schedule",
        scheduleSummary: "0 9 * * * (UTC)",
        chatThreadId: threadId,
        workflow: expect.objectContaining({
          id: workflowId,
          name: WORKFLOW_NAME,
        }),
      },
    ]);
  });

  it("lists thread-bound webhook automations", async () => {
    const { workflowId } = await setupFixture("team");

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "webhook-received" ||
      !created.body.chatThreadId
    ) {
      throw new Error("Expected a thread-bound webhook automation");
    }

    const listed = await accept(
      automationsClient().listForChatThread({
        headers: authHeaders(),
        params: { threadId: created.body.chatThreadId },
      }),
      [200],
    );
    const [listedAutomation] = listed.body;
    expect(listedAutomation).toMatchObject({
      id: created.body.id,
      kind: "event",
      eventType: "webhook-received",
      eventConfig: {
        provider: "webhook",
        event: "received",
        auth: { mode: "hmac-sha256" },
      },
      chatThreadId: created.body.chatThreadId,
      secretLastFour: created.body.secretLastFour,
      disabledReason: null,
      lastReceivedAt: null,
      workflow: expect.objectContaining({ id: workflowId }),
    });
    if (
      !listedAutomation ||
      listedAutomation.kind !== "event" ||
      listedAutomation.eventType !== "webhook-received"
    ) {
      throw new Error("Expected the webhook automation to be listed");
    }
    expect(listedAutomation.webhookUrl).toBeUndefined();
    expect(listedAutomation.webhookSecret).toBeUndefined();
  });

  it("stores automation chat threads at the workflow-user level", async () => {
    const { workflowId } = await setupFixture();
    const first = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [201],
    );
    const second = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 120 } },
      }),
      [201],
    );

    // Both automations share the workflow-user thread, and both are listed on
    // the workflow.
    expect(second.body.chatThreadId).toBe(first.body.chatThreadId);
    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(2);
    expect(
      listed.body.map((automation) => {
        return automation.chatThreadId;
      }),
    ).toStrictEqual([first.body.chatThreadId, first.body.chatThreadId]);
  });

  it("creates and updates one-time schedules from local atTime and timezone", async () => {
    mockNow(Date.parse("2026-06-22T07:50:00.000Z"));
    const { workflowId } = await setupFixture();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: "2026-06-22T15:55:00",
            timezone: "Asia/Shanghai",
          },
        },
      }),
      [201],
    );

    expect(created.body.schedule).toStrictEqual({
      type: "once",
      atTime: "2026-06-22T07:55:00.000Z",
      timezone: "Asia/Shanghai",
    });
    expect(created.body.nextRunAt).toBe("2026-06-22T07:55:00.000Z");

    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          schedule: {
            type: "once",
            atTime: "2026-06-22T16:05:00",
            timezone: "Asia/Shanghai",
          },
        },
      }),
      [200],
    );

    expect(updated.body.schedule).toStrictEqual({
      type: "once",
      atTime: "2026-06-22T08:05:00.000Z",
      timezone: "Asia/Shanghai",
    });
    expect(updated.body.nextRunAt).toBe("2026-06-22T08:05:00.000Z");

    // Disable so the past-dated one-time automation never becomes a stale due
    // candidate for later cron sweeps in the shared database.
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
  });

  it("rejects creation on a workflow the caller cannot see", async () => {
    const scenario = await setupFixture();
    // A private workflow under another user's private agent is invisible to
    // this member, so automation creation is rejected as not-found.
    const otherUserId = `user_${randomUUID()}`;
    const hidden = await createAgentWithWorkflow(scenario, {
      userId: otherUserId,
      agentDisplayName: "Private Agent",
      workflowName: "hidden-workflow",
      visibility: "private",
    });

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: hidden.workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [404],
    );
  });

  it("rejects an invalid cron expression and a past one-time schedule", async () => {
    const { workflowId } = await setupFixture();

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "not a cron",
            timezone: "UTC",
          },
        },
      }),
      [400],
    );

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: new Date(now() - 60_000).toISOString(),
            timezone: "UTC",
          },
        },
      }),
      [400],
    );
  });

  it("makes a loop automation due immediately when enabled", async () => {
    const { workflowId } = await setupFixture();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 1800 } },
      }),
      [201],
    );

    expect(created.body.schedule).toStrictEqual({
      type: "loop",
      intervalSeconds: 1800,
    });
    expect(created.body.nextRunAt).toBeTruthy();
  });

  it("requires Team or Custom for webhook automation creation", async () => {
    const { actor, customerId, subscriptionId, workflowId } =
      await setupFixture();

    const proRejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [402],
    );
    expect(proRejected.body.error).toStrictEqual({
      code: "TEAM_REQUIRED",
      message: "Webhook automations require a Team or Custom workspace",
    });

    await runs.grantProEntitlement(actor, {
      customerId,
      subscriptionId,
      tier: "team",
    });
    const teamCreated = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    expect(teamCreated.body).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
    });
  });

  it("serializes webhook creation with an effective downgrade", async () => {
    const { subscriptionId, workflowId } = await setupFixture("team");

    const [created] = await Promise.all([
      accept(
        automationsClient().create({
          headers: authHeaders(),
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201, 402],
      ),
      webhookCallbacks.postStripeEvent(
        {
          id: `evt_trigger_create_race_${randomUUID()}`,
          type: "customer.subscription.deleted",
          data: { object: { id: subscriptionId } },
        },
        [200],
      ),
    ]);

    if (created.status === 201) {
      await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
        enabled: false,
        disabledReason: "paid_plan_required",
      });
    } else {
      expect(created.body.error.code).toBe("TEAM_REQUIRED");
    }
  });

  it("lists owned workflow automations across visible workflows", async () => {
    const scenario = await setupFixture();
    const { agentId, workflowId } = scenario;
    const { agentId: secondAgentId, workflowId: secondWorkflowId } =
      await createAgentWithWorkflow(scenario, {
        agentDisplayName: "Second Automation Agent",
      });

    const first = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [201],
    );
    const second = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: secondWorkflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 10 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );

    const listed = await accept(
      automationsClient().listWorkspace({ headers: authHeaders() }),
      [200],
    );

    expect(
      listed.body.map((entry) => {
        return {
          automationId: entry.automation.id,
          workflowId: entry.workflow.id,
          workflowName: entry.workflow.name,
          agentId: entry.workflow.agentId,
        };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        {
          automationId: first.body.id,
          workflowId,
          workflowName: WORKFLOW_NAME,
          agentId,
        },
        {
          automationId: second.body.id,
          workflowId: secondWorkflowId,
          workflowName: WORKFLOW_NAME,
          agentId: secondAgentId,
        },
      ]),
    );
    expect("files" in listed.body[0]!.workflow).toBeFalsy();
    expect("fileContents" in listed.body[0]!.workflow).toBeFalsy();
  });

  it("creates webhook event automations with a signed endpoint secret shown once", async () => {
    const { workflowId } = await setupFixture("team");

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
      eventConfig: {
        provider: "webhook",
        event: "received",
        auth: { mode: "hmac-sha256" },
      },
      schedule: null,
      scheduleSummary: null,
      lastReceivedAt: null,
    });
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "webhook-received"
    ) {
      throw new Error("Expected a webhook automation");
    }
    expect(created.body.webhookUrl).toContain(
      "/api/webhooks/workflow-automations/whk_",
    );
    expect(created.body.webhookSecret).toBeTruthy();
    expect(created.body.secretLastFour).toBe(
      created.body.webhookSecret?.slice(-4),
    );

    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    const listedWebhook = listed.body.find((automation) => {
      return automation.id === created.body.id;
    });
    if (
      !listedWebhook ||
      listedWebhook.kind !== "event" ||
      listedWebhook.eventType !== "webhook-received"
    ) {
      throw new Error("Expected created webhook automation to be listed");
    }
    expect(listedWebhook.webhookUrl).toBeUndefined();
    expect(listedWebhook.secretLastFour).toBe(created.body.secretLastFour);
    expect(listedWebhook.webhookSecret).toBeUndefined();

    const revealed = await accept(
      automationsClient().revealWebhookSecret({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [200],
    );
    expect(revealed.body).toStrictEqual({
      webhookUrl: created.body.webhookUrl,
      webhookSecret: created.body.webhookSecret,
    });
  });

  it("rejects webhook re-enable for Pro", async () => {
    const { actor, customerId, workflowId, subscriptionId } =
      await setupFixture("team");
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [200],
    );
    await webhookCallbacks.postStripeEvent(
      {
        id: `evt_trigger_pro_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId } },
      },
      [200],
    );
    await runs.grantProEntitlement(actor, { customerId, subscriptionId });

    const teamRequired = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [402],
    );
    expect(teamRequired.body.error.code).toBe("TEAM_REQUIRED");
  });

  it("serializes webhook re-enable with an effective downgrade", async () => {
    const { subscriptionId, workflowId } = await setupFixture("team");
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [200],
    );

    const [enabled] = await Promise.all([
      accept(
        automationsClient().enable({
          headers: authHeaders(),
          params: { id: created.body.id },
          body: undefined,
        }),
        [200, 402],
      ),
      webhookCallbacks.postStripeEvent(
        {
          id: `evt_trigger_enable_race_${randomUUID()}`,
          type: "customer.subscription.deleted",
          data: { object: { id: subscriptionId } },
        },
        [200],
      ),
    ]);

    const after = await wf.readAutomation(created.body.id);
    expect(after.enabled).toBeFalsy();
    if (enabled.status === 200) {
      expect(after).toMatchObject({
        disabledReason: "paid_plan_required",
      });
    } else {
      expect(enabled.body.error.code).toBe("TEAM_REQUIRED");
    }
  });

  it("clears the plan-disabled reason without rotating webhook credentials", async () => {
    const { actor, customerId, workflowId, subscriptionId } =
      await setupFixture("team");
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "webhook-received"
    ) {
      throw new Error("Expected a webhook automation");
    }
    await webhookCallbacks.postStripeEvent(
      {
        id: `evt_trigger_restore_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId } },
      },
      [200],
    );
    const disabled = await wf.readAutomation(created.body.id);
    expect(disabled).toMatchObject({
      enabled: false,
      disabledReason: "paid_plan_required",
    });
    await runs.grantProEntitlement(actor, {
      customerId,
      subscriptionId,
      tier: "team",
    });

    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      enabled: true,
      disabledReason: null,
    });
    const revealed = await accept(
      automationsClient().revealWebhookSecret({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [200],
    );
    expect(revealed.body).toStrictEqual({
      webhookUrl: created.body.webhookUrl,
      webhookSecret: created.body.webhookSecret,
    });
  });

  it("requires a connected Gmail account for Gmail event automations", async () => {
    const { workflowId } = await setupFixture();
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Connect Gmail before adding a Gmail event automation",
    );
  });

  it("requires a connected Google Calendar account for Google Calendar event automations", async () => {
    const { workflowId } = await setupFixture();
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Connect Google Calendar before adding a Google Calendar event automation",
    );
  });

  it("rejects Notion child page automations when Notion automation creation is disabled", async () => {
    const { workflowId } = await setupFixture();
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Notion workflow automations are not enabled",
    );
  });

  it("rejects Notion database item automations when Notion automation creation is disabled", async () => {
    const { workflowId } = await setupFixture();
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: NOTION_DATABASE_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Notion workflow automations are not enabled",
    );
  });

  it("rejects Notion page content updated automations when Notion automation creation is disabled", async () => {
    const { workflowId } = await setupFixture();
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Notion workflow automations are not enabled",
    );
  });

  it("requires a connected Notion account for Notion child page automations", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowAutomations(fixture);

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Connect Notion before adding a Notion event automation",
    );
  });

  it("requires a connected Notion account for Notion database item automations", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowAutomations(fixture);

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: NOTION_DATABASE_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Connect Notion before adding a Notion event automation",
    );
  });

  it("requires a connected Notion account for Notion page content updated automations", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowAutomations(fixture);

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Connect Notion before adding a Notion event automation",
    );
  });

  it("requires a standard notion.so page URL for Notion child page automations", async () => {
    const scenario = await setupFixture();
    await enableNotionWorkflowAutomations(scenario.fixture);
    await connectNotion(scenario);

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: "https://example.com/notion-page",
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Enter a standard notion.so page URL",
    );
  });

  it("requires a standard notion.so database URL for Notion database item automations", async () => {
    const scenario = await setupFixture();
    await enableNotionWorkflowAutomations(scenario.fixture);
    await connectNotion(scenario);

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: "https://example.com/notion-database",
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Enter a standard notion.so database URL",
    );
  });

  it("creates Notion child page automations by validating and storing the parent page", async () => {
    const scenario = await setupFixture();
    const connectorId = await connectNotion(scenario);
    await enableNotionWorkflowAutomations(scenario.fixture);
    configureNotionPageMock();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-child-page-created",
      eventConfig: {
        provider: "notion",
        event: "child_page_created",
        connectorId,
        parentPage: {
          id: NOTION_PARENT_PAGE_ID,
          url: NOTION_PARENT_PAGE_URL,
          title: "Roadmap",
          rawUrl: NOTION_PARENT_PAGE_URL,
        },
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });
    expect(created.body.chatThreadId).toBeTruthy();
  });

  it("creates Notion database item automations by validating and storing the data source", async () => {
    const scenario = await setupFixture();
    const connectorId = await connectNotion(scenario);
    await enableNotionWorkflowAutomations(scenario.fixture);
    configureNotionDatabaseMock();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: NOTION_DATABASE_URL,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-database-item-created",
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        connectorId,
        dataSource: {
          id: NOTION_DATA_SOURCE_ID,
          url: NOTION_DATA_SOURCE_URL,
          title: "Bug Bash",
          rawUrl: NOTION_DATABASE_URL,
        },
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });
    expect(created.body.chatThreadId).toBeTruthy();
  });

  it("creates Notion page content updated automations for a page scope", async () => {
    const scenario = await setupFixture();
    const connectorId = await connectNotion(scenario);
    await enableNotionWorkflowAutomations(scenario.fixture);
    configureNotionPageMock();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-page-content-updated",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        connectorId,
        scope: {
          type: "page",
          page: {
            id: NOTION_PARENT_PAGE_ID,
            url: NOTION_PARENT_PAGE_URL,
            title: "Roadmap",
            rawUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });
    expect(created.body.chatThreadId).toBeTruthy();
  });

  it("creates Notion page content updated automations for a database scope", async () => {
    const scenario = await setupFixture();
    const connectorId = await connectNotion(scenario);
    await enableNotionWorkflowAutomations(scenario.fixture);
    configureNotionDatabaseMock();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            databaseUrl: NOTION_DATABASE_URL,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-page-content-updated",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        connectorId,
        scope: {
          type: "data_source",
          dataSource: {
            id: NOTION_DATA_SOURCE_ID,
            url: NOTION_DATA_SOURCE_URL,
            title: "Bug Bash",
            rawUrl: NOTION_DATABASE_URL,
          },
        },
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });
    expect(created.body.chatThreadId).toBeTruthy();
  });

  it("rejects removed Gmail event automation match fields", async () => {
    const { workflowId } = await setupFixture();

    const response = await createApp({ signal: context.signal }).request(
      `/api/zero/workflows/${workflowId}/automations`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { hasAttachment: true },
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("BAD_REQUEST");
  });

  it("creates Gmail event automations with a watch and agent connector grant", async () => {
    const scenario = await setupFixture();
    await connectGmail(scenario);
    const watchRecorder = configureGmailWatchMock();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { subject: { contains: "invoice" } },
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: {
        provider: "gmail",
        event: "new_message",
        match: { subject: { contains: "invoice" } },
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });
    expect(created.body.chatThreadId).toBeTruthy();
    // The Gmail watch was registered against the provider exactly once with
    // the connector's token and the configured Pub/Sub topic (asserted in the
    // provider mock).
    expect(watchRecorder.calls).toBe(1);

    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { from: { contains: "billing@example.com" } },
          },
        },
      }),
      [200],
    );
    expect(updated.body.kind).toBe("event");
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "gmail-new-message"
    ) {
      throw new Error("Expected a Gmail event automation");
    }
    expect(updated.body.eventConfig.match).toStrictEqual({
      from: { contains: "billing@example.com" },
    });
  });

  it("creates Google Calendar event-created automations with a watch and baseline", async () => {
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const watchRecorder = configureGoogleCalendarWatchMock({
      baselineItems: [
        {
          id: "existing-event",
          etag: '"existing-etag"',
          status: "confirmed",
          summary: "Already on calendar",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
          start: { dateTime: "2026-06-30T09:00:00-07:00" },
          end: { dateTime: "2026-06-30T09:30:00-07:00" },
        },
      ],
    });

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });
    expect(created.body.chatThreadId).toBeTruthy();

    // The provider watch was registered once and the baseline event snapshot
    // sync ran once (the mock asserts calendar id, token, and sync params).
    // Baseline semantics — pre-existing events never dispatch runs — are
    // covered by webhooks-google-calendar.test.ts.
    expect(watchRecorder.watchCalls).toBe(1);
    expect(watchRecorder.baselineCalls).toBe(1);
  });

  it("creates and updates Gmail label applied automations by label name", async () => {
    const scenario = await setupFixture();
    await connectGmail(scenario);
    configureGmailLabelsMock([{ id: "Label_support", name: "Support" }]);
    configureGmailWatchMock();

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Support",
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
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
      enabled: true,
      nextRunAt: null,
    });

    configureGmailLabelsMock([{ id: "Label_escalated", name: "Escalated" }]);
    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Escalated",
          },
        },
      }),
      [200],
    );

    expect(updated.body.kind).toBe("event");
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected a Gmail label applied automation");
    }
    expect(updated.body.eventConfig).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelName: "Escalated",
      resolvedLabelId: "Label_escalated",
    });
  });

  it("creates and updates GitHub label applied automations", async () => {
    const scenario = await setupFixture();
    await gh.installGithubApp(scenario.actor, scenario.agentId, {
      oauthCode: {
        code: `wf-automations-${randomUUID().slice(0, 8)}`,
        githubUserId: "101",
      },
    });
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "github-label-applied",
          eventConfig: {
            provider: "github",
            event: "label_applied",
            labelName: "triage",
            filters: {
              subject: "pull_requests",
              actor: { type: "me" },
            },
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "github-label-applied",
      eventConfig: {
        provider: "github",
        event: "label_applied",
        labelName: "triage",
        filters: {
          subject: "pull_requests",
          actor: { type: "me" },
        },
      },
      schedule: null,
      scheduleSummary: null,
      enabled: true,
      nextRunAt: null,
    });

    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "github",
            event: "label_applied",
            labelName: "Escalated",
            filters: {
              subject: "issues",
              actor: { type: "anyone" },
            },
          },
        },
      }),
      [200],
    );

    expect(updated.body.kind).toBe("event");
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "github-label-applied"
    ) {
      throw new Error("Expected a GitHub label applied automation");
    }
    expect(updated.body.eventConfig).toStrictEqual({
      provider: "github",
      event: "label_applied",
      labelName: "Escalated",
      filters: {
        subject: "issues",
        actor: { type: "anyone" },
      },
    });
  });

  it("creates and updates GitHub workflow run completed automations", async () => {
    const scenario = await setupFixture();
    await gh.installGithubApp(scenario.actor, scenario.agentId);
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "github-workflow-run-completed",
          eventConfig: {
            provider: "github",
            event: "workflow_run_completed",
            filters: {
              repositories: ["vm0-ai/vm0"],
              workflows: ["Turbo", ".github/workflows/turbo.yml"],
              conclusions: ["failure", "startup_failure"],
              branches: ["main"],
              events: ["push", "workflow_dispatch"],
              actors: ["dependabot[bot]"],
            },
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "github-workflow-run-completed",
      eventConfig: {
        provider: "github",
        event: "workflow_run_completed",
        filters: {
          repositories: ["vm0-ai/vm0"],
          workflows: ["Turbo", ".github/workflows/turbo.yml"],
          conclusions: ["failure", "startup_failure"],
          branches: ["main"],
          events: ["push", "workflow_dispatch"],
          actors: ["dependabot[bot]"],
        },
      },
      enabled: true,
      nextRunAt: null,
    });

    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "github",
            event: "workflow_run_completed",
            filters: {
              repositories: ["vm0-ai/vm0"],
              conclusions: ["success"],
              branches: ["release"],
            },
          },
        },
      }),
      [200],
    );

    expect(updated.body).toMatchObject({
      kind: "event",
      eventType: "github-workflow-run-completed",
      eventConfig: {
        filters: {
          repositories: ["vm0-ai/vm0"],
          conclusions: ["success"],
          branches: ["release"],
        },
      },
    });
  });

  it("rejects GitHub label applied automations with actor me when GitHub user is not connected", async () => {
    const scenario = await setupFixture();
    // Install without an OAuth code: the org gets an installation but the
    // member has no linked GitHub user.
    await gh.installGithubApp(scenario.actor, scenario.agentId);
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
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
        },
      }),
      [400],
    );

    expect(created.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message:
          "Connect your GitHub account before using Triggered by me for GitHub label workflow automations",
      },
    });
  });

  it("returns created automations from list and both workflow detail fields", async () => {
    const { workflowId } = await setupFixture();

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: futureIso(86_400_000),
            timezone: "UTC",
          },
        },
      }),
      [201],
    );

    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    const [listedAutomation] = listed.body;
    expect(listedAutomation?.kind).toBe("schedule");
    if (listedAutomation?.kind !== "schedule") {
      throw new Error("Expected a schedule automation");
    }
    expect(listedAutomation.schedule.type).toBe("once");

    const detail = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    expect(detail.body.automations).toHaveLength(1);
  });

  it("updates the schedule of an existing automation", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 600 },
        },
      }),
      [201],
    );

    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "*/15 * * * *",
            timezone: "UTC",
          },
        },
      }),
      [200],
    );
    expect(updated.body.schedule).toStrictEqual({
      type: "cron",
      cronExpression: "*/15 * * * *",
      timezone: "UTC",
    });
  });

  it("schedules updated loop automations from the last run interval", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    mockNow(Date.parse("2026-06-28T06:00:00.000Z"));
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 600 },
        },
      }),
      [201],
    );

    // A real manual run through the public run route stamps lastRunAt.
    mockNow(Date.parse("2026-06-28T06:05:00.000Z"));
    await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [201],
    );

    mockNow(Date.parse("2026-06-28T06:10:00.000Z"));
    const updated = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [200],
    );

    expect(updated.body.nextRunAt).toBe("2026-06-28T07:05:00.000Z");

    // Keep the past-dated loop automation out of later global cron sweeps.
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
  });

  it("clears next run on disable and recomputes it on enable", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 * * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );

    const disabled = await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    expect(disabled.body.nextRunAt).toBeNull();

    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    expect(enabled.body.nextRunAt).toBeTruthy();
  });

  it("keeps enabled loop automations scheduled from the last run interval", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    mockNow(Date.parse("2026-06-28T06:00:00.000Z"));
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 1800 },
        },
      }),
      [201],
    );

    // Stamp lastRunAt through a real manual run, then disable so enable has
    // to recompute the next run from the last run interval.
    mockNow(Date.parse("2026-06-28T06:05:00.000Z"));
    await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [201],
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    mockNow(Date.parse("2026-06-28T06:10:00.000Z"));
    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    expect(enabled.body.enabled).toBeTruthy();
    expect(enabled.body.nextRunAt).toBe("2026-06-28T06:35:00.000Z");

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
  });

  it("treats a deleted workflow's automation as not found on enable", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    await accept(
      detailClient().delete({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [204],
    );

    await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [404],
    );
  });

  it("allows another org member to manage only their own automations", async () => {
    const { fixture, workflowId } = await setupFixture();
    const ownerAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );

    // A different member of the same org can create their own automation on the
    // public workflow + public agent, but cannot modify the owner's automation.
    const otherUserId = `user_${randomUUID()}`;
    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 7200 },
        },
      }),
      [201],
    );

    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: ownerAutomation.body.id },
      }),
      [403],
    );
  });

  it("keeps the bound chat thread when an automation is deleted", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    expect(threadId).toBeTruthy();

    context.mocks.ably.publish.mockClear();
    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadAutomationsChanged:${threadId}`,
      null,
    );

    // The bound chat thread survives the automation deletion and still carries
    // the org default model selection.
    await expect(wf.readThreadSelectedModel(String(threadId))).resolves.toBe(
      "claude-sonnet-4-6",
    );
  });

  it("runs a one-time automation immediately in its bound chat thread", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const { workflowId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: futureIso(86_400_000),
            timezone: "Asia/Shanghai",
          },
        },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId) {
      throw new Error("Expected automation creation to bind a chat thread");
    }

    const run = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [201],
    );

    expect(run.body.chatThreadId).toBe(threadId);
    if (!run.body.runId) {
      throw new Error("Expected an idle manual automation run to start");
    }
    const timingEvents = sandboxOperationEventsForRun(run.body.runId);
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_agent_run",
          trigger_source: "workflow-schedule",
          zero_run_origin: "workflow_automation",
        }),
      ]),
    );
    const actionTypes = new Set(
      timingEvents.map((event) => {
        return event.op_type;
      }),
    );
    for (const actionType of [
      "api_dispatch_pre_create_zero_workflow_automation_entrypoint_gap",
      "api_dispatch_pre_create_zero_workflow_automation_check_active_run",
      "api_dispatch_pre_create_zero_workflow_automation_resolve_model_context",
      "api_dispatch_pre_create_zero_workflow_automation_build_run_input",
      "api_dispatch_pre_create_zero_workflow_automation_create_run",
    ]) {
      expect(actionTypes).toContain(actionType);
    }
    expect(actionTypes).not.toContain(
      "api_dispatch_pre_create_zero_entrypoint_gap",
    );
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type:
            "api_dispatch_pre_create_zero_workflow_automation_create_run",
          trigger_source: "workflow-schedule",
          zero_run_origin: "workflow_automation",
          span_kind: "nested",
        }),
      ]),
    );
    expect(JSON.stringify(timingEvents)).not.toContain(WORKFLOW_NAME);

    const automation = await wf.readAutomation(created.body.id);
    expect(typeof automation.lastRunAt).toBe("string");
    expect(automation.nextRunAt).toBe(created.body.nextRunAt);

    // The run landed in the bound thread as the workflow slash-command user
    // message, linked to the created run id.
    const messages = await wf.readThreadEvents(threadId);
    const workflowMessage = messages.find((message) => {
      return (
        message.eventType === "input.prompt" &&
        chatEventDisplayText(message) === `/${WORKFLOW_NAME}`
      );
    });
    expect(workflowMessage).toBeDefined();
    expect(workflowMessage?.runId).toBe(run.body.runId);
    expect(workflowMessage?.workflowSnapshot?.triggerBrief).toMatch(
      /^Once at \d{1,2}:\d{2} [AP]M, [A-Z][a-z]{2} \d{1,2}, \d{4} \(Asia\/Shanghai\)$/u,
    );
  });
});
