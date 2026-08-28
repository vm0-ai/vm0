import { randomUUID } from "node:crypto";

import {
  cronRenewGoogleCalendarWatchesContract,
  cronRenewGoogleFormsWatchesContract,
} from "@okouai/api-contracts/contracts/cron";
import { testGmailWatchRenewalContract } from "@okouai/api-contracts/contracts/test-gmail-watch-renewal";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  readRunAutonomyBudgetFixture,
  readWorkflowAutomationAutonomyFixture,
  setRunAutonomyBudgetFixture,
  setWorkflowAutomationAutonomyBudgetFixture,
} from "./helpers/runtime-state";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { cronRenewGmailWatchesRoutes } from "../cron-renew-gmail-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "../cron-renew-google-calendar-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "../cron-renew-google-forms-watches";
import { testGmailWatchRenewalRoutes } from "../test-gmail-watch-renewal";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { webhooksGoogleCalendarRoutes } from "../webhooks-google-calendar";

const TEST_APP_ROUTES = Object.freeze([
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleFormsWatchesRoutes,
  ...webhooksGoogleCalendarRoutes,
  ...workflowAutomationsRoutes,
  ...workflowsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const bdd = createBddApi(context);
const gh = createGithubBddApi(context);
const runs = createRunsApi(context);
const webhookCallbacks = createWebhookCallbackApi(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function renewGmailWatchScopeClient() {
  return setupApp({ context, routes: testGmailWatchRenewalRoutes })(
    testGmailWatchRenewalContract,
  );
}

function renewGoogleCalendarWatchesClient() {
  return setupApp({ context, routes: cronRenewGoogleCalendarWatchesRoutes })(
    cronRenewGoogleCalendarWatchesContract,
  );
}

function renewGoogleFormsWatchesClient() {
  return setupApp({ context, routes: cronRenewGoogleFormsWatchesRoutes })(
    cronRenewGoogleFormsWatchesContract,
  );
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
const GOOGLE_FORMS_TOPIC_NAME = "projects/vm0-ai-488909/topics/forms-events";
const GOOGLE_FORMS_PUSH_AUDIENCE =
  "https://api.vm0.ai/api/webhooks/google-forms";
const GOOGLE_FORMS_PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const GOOGLE_FORM_ID = "1FAIpQLScGoogleFormsAutomationTest";
const GOOGLE_FORM_URL = `https://docs.google.com/forms/d/${GOOGLE_FORM_ID}/edit`;
const GOOGLE_FORM_SEED_CURSOR = "2026-08-05T09:30:00.123456Z";
const NOTION_PARENT_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTION_PARENT_PAGE_URL =
  "https://www.notion.so/Roadmap-11111111111141118111111111111111";
const NOTION_DATABASE_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_DATA_SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const NOTION_DATABASE_URL =
  "https://www.notion.so/22222222222242228222222222222222?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa&source=copy_link";
const NOTION_DATA_SOURCE_URL =
  "https://www.notion.so/Bug-Bash-33333333333343338333333333333333";
const CRON_SECRET = "workflow-watch-lifecycle-cron-secret";

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

async function enableGoogleFormsWorkflowAutomations(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.GoogleFormsWorkflowAutomations]: true,
  });
}

interface GoogleFormsWatchRecorder {
  readonly watchIds: string[];
  createCalls: number;
}

function configureGoogleFormsCreationMock(args?: {
  readonly unpublished?: boolean;
  readonly expireTime?: string;
}): GoogleFormsWatchRecorder {
  const recorder: GoogleFormsWatchRecorder = {
    watchIds: [],
    createCalls: 0,
  };
  mockOptionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME", GOOGLE_FORMS_TOPIC_NAME);
  mockOptionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE",
    GOOGLE_FORMS_PUSH_AUDIENCE,
  );
  mockOptionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    GOOGLE_FORMS_PUSH_SERVICE_ACCOUNT,
  );
  server.use(
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId",
      ({ request, params }) => {
        expect(params.formId).toBe(GOOGLE_FORM_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer google-forms-access-token",
        );
        return HttpResponse.json({
          formId: GOOGLE_FORM_ID,
          info: { title: "Customer survey" },
          publishSettings: args?.unpublished
            ? { publishState: {} }
            : {
                publishState: {
                  isPublished: true,
                  isAcceptingResponses: true,
                },
              },
        });
      },
    ),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/responses",
      ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("pageSize")).toBe("1");
        expect(url.searchParams.get("fields")).toBe(
          "responses(responseId,createTime,lastSubmittedTime,respondentEmail),nextPageToken",
        );
        return HttpResponse.json({
          responses: [
            {
              responseId: "seed-response",
              createTime: GOOGLE_FORM_SEED_CURSOR,
              lastSubmittedTime: GOOGLE_FORM_SEED_CURSOR,
            },
          ],
        });
      },
    ),
    http.post(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      async ({ request }) => {
        recorder.createCalls += 1;
        await expect(request.json()).resolves.toStrictEqual({
          watch: {
            target: { topic: { topicName: GOOGLE_FORMS_TOPIC_NAME } },
            eventType: "RESPONSES",
          },
        });
        const watchId = `forms-watch-${randomUUID()}`;
        recorder.watchIds.push(watchId);
        return HttpResponse.json({
          id: watchId,
          createTime: "2026-08-05T10:00:00Z",
          expireTime: args?.expireTime ?? "2099-08-12T10:00:00Z",
          eventType: "RESPONSES",
          target: { topic: { topicName: GOOGLE_FORMS_TOPIC_NAME } },
        });
      },
    ),
  );
  return recorder;
}

interface WatchCallRecorder {
  calls: number;
}

function configureGmailWatchMock(
  historyIds: string | readonly string[] = "100",
): WatchCallRecorder {
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
          historyId:
            typeof historyIds === "string"
              ? historyIds
              : historyIds[Math.min(recorder.calls - 1, historyIds.length - 1)],
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
  );
  return recorder;
}

interface StopCallRecorder {
  calls: number;
}

function configureGmailStopMock(
  statuses: readonly number[] = [204],
): StopCallRecorder {
  const recorder: StopCallRecorder = { calls: 0 };
  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      async ({ request }) => {
        recorder.calls += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer gmail-access-token",
        );
        await expect(request.json()).resolves.toStrictEqual({});
        const status =
          statuses[Math.min(recorder.calls - 1, statuses.length - 1)] ?? 204;
        return status === 204
          ? new HttpResponse(null, { status })
          : HttpResponse.json({ error: "stop failed" }, { status });
      },
    ),
  );
  return recorder;
}

interface CalendarWatchRecorder {
  watchCalls: number;
  baselineCalls: number;
  incrementalCalls: number;
  readonly channelIds: string[];
}

interface CalendarWatchRegistration {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
}

interface CalendarStopRecorder extends StopCallRecorder {
  readonly requests: {
    readonly id: string;
    readonly resourceId: string;
  }[];
}

function configureGoogleCalendarStopMock(
  statuses: readonly number[] = [204],
): CalendarStopRecorder {
  const recorder: CalendarStopRecorder = { calls: 0, requests: [] };
  server.use(
    http.post(
      "https://www.googleapis.com/calendar/v3/channels/stop",
      async ({ request }) => {
        recorder.calls += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const body = (await request.json()) as {
          readonly id: string;
          readonly resourceId: string;
        };
        recorder.requests.push(body);
        const status =
          statuses[Math.min(recorder.calls - 1, statuses.length - 1)] ?? 204;
        return status === 204
          ? new HttpResponse(null, { status })
          : HttpResponse.json({ error: "stop failed" }, { status });
      },
    ),
  );
  return recorder;
}

function configureGoogleCalendarWatchMock(args?: {
  readonly calendarId?: string;
  readonly baselineItems?: readonly Record<string, unknown>[];
  readonly incrementalItems?: readonly Record<string, unknown>[];
  readonly onWatchRegistered?: (
    registration: CalendarWatchRegistration,
  ) => Promise<void>;
}): CalendarWatchRecorder {
  const recorder: CalendarWatchRecorder = {
    watchCalls: 0,
    baselineCalls: 0,
    incrementalCalls: 0,
    channelIds: [],
  };
  const calendarId = args?.calendarId ?? "primary";
  mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
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
        const channelId = String(body.id);
        const channelToken = String(body.token);
        const resourceId = `calendar-resource-${recorder.watchCalls}`;
        recorder.channelIds.push(channelId);
        await args?.onWatchRegistered?.({
          channelId,
          channelToken,
          resourceId,
        });
        return HttpResponse.json({
          id: body.id,
          resourceId,
          resourceUri: `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
      ({ request, params }) => {
        expect(params.calendarId).toBe(calendarId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const url = new URL(request.url);
        expect(url.searchParams.get("showDeleted")).toBe("true");
        expect(url.searchParams.get("maxResults")).toBe("2500");
        const syncToken = url.searchParams.get("syncToken");
        if (syncToken) {
          recorder.incrementalCalls += 1;
          expect(syncToken).toBe("calendar-sync-baseline");
          return HttpResponse.json({
            items: args?.incrementalItems ?? [],
            nextSyncToken: "calendar-sync-incremental",
          });
        }
        recorder.baselineCalls += 1;
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

describe("okou workflow automations", () => {
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

  async function connectGmail(
    scenario: AutomationScenario,
    email = GMAIL_EMAIL,
    oauth?: {
      readonly accessToken?: string;
      readonly refreshToken?: string;
    },
  ): Promise<string> {
    mockGmailConnectorOAuth({ email, ...oauth });
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

  async function connectGoogleForms(
    scenario: AutomationScenario,
  ): Promise<string> {
    mockGoogleFormsConnectorOAuth();
    await wf.connectConnector(scenario.actor, "google-forms");
    const connector = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "google-forms",
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

  it("projects webhook URLs by request and run brand without rotating credentials", async () => {
    mockEnv("VM0_WEB_URL", "https://api.vm0.ai");
    const { actor, agentId, workflowId } = await setupFixture("team");
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "webhook-received" ||
      !created.body.webhookUrl ||
      !created.body.webhookSecret
    ) {
      throw new Error("Expected a webhook automation with credentials");
    }
    const createdUrl = new URL(created.body.webhookUrl);
    expect(createdUrl.hostname).toBe("api.okou.ai");

    const sourceRun = await runs.createRun(actor, {
      agentId,
      prompt: "project webhook credentials by run brand",
      modelProvider: "anthropic-api-key",
    });
    const brandCases = [
      {
        publicBrand: "okou" as const,
        origin: "https://app.vm0.ai",
        hostname: "api.okou.ai",
      },
      {
        publicBrand: "vm0" as const,
        origin: "https://app.okou.ai",
        hostname: "api.vm0.ai",
      },
      {
        publicBrand: undefined,
        origin: "https://app.okou.ai",
        hostname: "api.vm0.ai",
      },
    ];

    for (const brandCase of brandCases) {
      const token = runs.okouTokenForRunWithCapabilities(
        actor,
        sourceRun.runId,
        ["agent:write"],
        brandCase.publicBrand,
      );
      const revealed = await accept(
        automationsClient().revealWebhookSecret({
          headers: { authorization: `Bearer ${token}` },
          extraHeaders: { origin: brandCase.origin },
          params: { id: created.body.id },
          body: undefined,
        }),
        [200],
      );
      const revealedUrl = new URL(revealed.body.webhookUrl);
      expect(revealedUrl.hostname).toBe(brandCase.hostname);
      expect(revealedUrl.pathname).toBe(createdUrl.pathname);
      expect(revealed.body.webhookSecret).toBe(created.body.webhookSecret);
    }
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

  it("rejects Google Forms response automation creation when the feature is disabled", async () => {
    const { workflowId } = await setupFixture();
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [400],
    );
    expect(rejected.body.error.message).toBe(
      "Google Forms workflow automations are not enabled",
    );
  });

  it("rejects Google Forms creation when Pub/Sub push is not configured", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Google Forms Pub/Sub push is not configured",
    );
  });

  it("rejects Google Forms respondent links with edit-page guidance", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl:
              "https://docs.google.com/forms/d/e/1FAIpQLSfPublic/viewform",
          },
        },
      }),
      [400],
    );
    expect(rejected.body.error.message).toBe(
      "Please open the form's edit page and copy the link from the address bar",
    );
  });

  it("explains inaccessible or missing Google Forms", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    configureGoogleFormsCreationMock();
    server.use(
      http.get("https://forms.googleapis.com/v1/forms/:formId", () => {
        return HttpResponse.json(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "The caller does not have permission",
            },
          },
          { status: 403 },
        );
      }),
    );

    const rejected = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "You do not have access to this form, or it does not exist",
    );
  });

  it("validates Google Forms, seeds the raw cursor, creates a watch, and warns for unpublished forms", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    const connectorId = await connectGoogleForms(scenario);
    configureGoogleFormsCreationMock({ unpublished: true });
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "google-forms-response-submitted",
      eventConfig: {
        provider: "google-forms",
        event: "response_submitted",
        connectorId,
        form: {
          id: GOOGLE_FORM_ID,
          title: "Customer survey",
          url: GOOGLE_FORM_URL,
        },
      },
      warning:
        "This Google Form is not accepting responses yet. Publish it before expecting response events.",
      enabled: true,
    });
  });

  it("shares one Google Forms watch until the last same-user consumer is disabled", async () => {
    const scenario = await setupFixture();
    const second = await createAgentWithWorkflow(scenario, {
      workflowName: `second-${WORKFLOW_NAME}`,
    });
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    const watch = configureGoogleFormsCreationMock();
    const createAutomation = async (workflowId: string) => {
      return await accept(
        automationsClient().create({
          headers: authHeaders(),
          params: { workflowId },
          body: {
            kind: "event",
            eventType: "google-forms-response-submitted",
            eventConfig: {
              provider: "google-forms",
              event: "response_submitted",
              formUrl: GOOGLE_FORM_URL,
            },
          },
        }),
        [201],
      );
    };
    const firstAutomation = await createAutomation(scenario.workflowId);
    const secondAutomation = await createAutomation(second.workflowId);
    let deleteCalls = 0;
    server.use(
      http.delete(
        /^https:\/\/forms\.googleapis\.com\/v1\/forms\/[^/]+\/watches\/[^/]+$/,
        () => {
          deleteCalls += 1;
          return HttpResponse.json({});
        },
      ),
    );

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: firstAutomation.body.id },
      }),
      [200],
    );
    expect(deleteCalls).toBe(0);
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: secondAutomation.body.id },
      }),
      [200],
    );

    expect(watch.createCalls).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  it("adopts the matching Google Forms watch after a create conflict", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    configureGoogleFormsCreationMock();
    const adoptedWatchId = `forms-watch-adopted-${randomUUID()}`;
    let listCalls = 0;
    server.use(
      http.post("https://forms.googleapis.com/v1/forms/:formId/watches", () => {
        return HttpResponse.json(
          {
            error: {
              code: 400,
              status: "FAILED_PRECONDITION",
              message:
                "A watch for the given end user, project, form, and event type already exists.",
            },
          },
          { status: 400 },
        );
      }),
      http.get("https://forms.googleapis.com/v1/forms/:formId/watches", () => {
        listCalls += 1;
        return HttpResponse.json({
          watches: [
            {
              id: adoptedWatchId,
              createTime: "2026-08-05T10:00:00Z",
              expireTime: "2099-08-12T10:00:00Z",
              eventType: "RESPONSES",
              target: {
                topic: { topicName: GOOGLE_FORMS_TOPIC_NAME },
              },
            },
          ],
        });
      }),
    );

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [201],
    );

    expect(created.body.enabled).toBeTruthy();
    expect(listCalls).toBe(1);
  });

  it("renews a Google Forms watch in place", async () => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    const startedAt = Date.parse("2026-08-05T10:00:00.000Z");
    mockNow(startedAt);
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    const watch = configureGoogleFormsCreationMock({
      expireTime: "2026-08-12T10:00:00Z",
    });
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [201],
    );
    const originalWatchId = watch.watchIds[0];
    if (!originalWatchId) {
      throw new Error("Expected the Google Forms watch id");
    }
    let renewCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json({
          access_token: "google-forms-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
      http.post(
        /^https:\/\/forms\.googleapis\.com\/v1\/forms\/[^/]+\/watches\/[^/]+:renew$/,
        async ({ request }) => {
          renewCalls += 1;
          expect(request.url).toContain(`/watches/${originalWatchId}:renew`);
          await expect(request.json()).resolves.toStrictEqual({});
          return HttpResponse.json({
            id: originalWatchId,
            createTime: "2026-08-05T10:00:00Z",
            expireTime: "2026-08-18T10:00:00Z",
            eventType: "RESPONSES",
            target: { topic: { topicName: GOOGLE_FORMS_TOPIC_NAME } },
          });
        },
      ),
    );
    mockNow(startedAt + 6 * 24 * 60 * 60 * 1000);

    const renewed = await accept(
      renewGoogleFormsWatchesClient().renew({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    const unchanged = await accept(
      renewGoogleFormsWatchesClient().renew({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );

    expect(renewed.body).toStrictEqual({
      success: true,
      renewed: 1,
      failed: 0,
    });
    expect(unchanged.body).toStrictEqual({
      success: true,
      renewed: 0,
      failed: 0,
    });
    expect(renewCalls).toBe(1);
    expect(watch.createCalls).toBe(1);
  });

  it("treats the Google Forms missing-watch 403 as successful teardown", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    const watch = configureGoogleFormsCreationMock();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [201],
    );
    let deleteCalls = 0;
    server.use(
      http.delete(
        /^https:\/\/forms\.googleapis\.com\/v1\/forms\/[^/]+\/watches\/[^/]+$/,
        () => {
          deleteCalls += 1;
          return HttpResponse.json(
            {
              error: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: "Watch not found or permission denied.",
              },
            },
            { status: 403 },
          );
        },
      ),
    );

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    expect(deleteCalls).toBe(1);
    expect(watch.createCalls).toBe(2);
    expect(enabled.body.enabled).toBeTruthy();
  });

  it("rejects updates to a Google Forms trigger with explicit guidance", async () => {
    const scenario = await setupFixture();
    await enableGoogleFormsWorkflowAutomations(scenario.fixture);
    await connectGoogleForms(scenario);
    configureGoogleFormsCreationMock();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: GOOGLE_FORM_URL,
          },
        },
      }),
      [201],
    );

    const rejected = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
          },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "this trigger has no updatable fields; delete it and create a new one",
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

  it("projects inaccessible Notion page errors by request brand", async () => {
    const scenario = await setupFixture();
    await enableNotionWorkflowAutomations(scenario.fixture);
    await connectNotion(scenario);
    server.use(
      http.get("https://api.notion.com/v1/pages/:pageId", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    for (const [origin, assistantName] of [
      [undefined, "Zero"],
      ["https://app.okou.ai", "Okou"],
    ] as const) {
      const rejected = await accept(
        automationsClient().create({
          headers: authHeaders(),
          ...(origin ? { extraHeaders: { origin } } : {}),
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
        [400],
      );
      expect(rejected.body.error.message).toBe(
        `${assistantName} cannot access this Notion page`,
      );
    }
  });

  it("projects inaccessible Notion database errors by request brand", async () => {
    const scenario = await setupFixture();
    await enableNotionWorkflowAutomations(scenario.fixture);
    await connectNotion(scenario);
    server.use(
      http.get("https://api.notion.com/v1/databases/:databaseId", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.get("https://api.notion.com/v1/data_sources/:dataSourceId", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    for (const [origin, assistantName] of [
      [undefined, "Zero"],
      ["https://app.okou.ai", "Okou"],
    ] as const) {
      const rejected = await accept(
        automationsClient().create({
          headers: authHeaders(),
          ...(origin ? { extraHeaders: { origin } } : {}),
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
        [400],
      );
      expect(rejected.body.error.message).toBe(
        `${assistantName} cannot access this Notion database`,
      );
    }
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

    const response = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/workflows/${workflowId}/automations`, {
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
    });

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

  it("catches up Calendar changes from the channel startup sync", async () => {
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const notifications: { readonly status: number; readonly body: unknown }[] =
      [];
    const watch = configureGoogleCalendarWatchMock({
      baselineItems: [],
      incrementalItems: [
        {
          id: "registration-window-event",
          etag: '"version-1"',
          status: "confirmed",
          summary: "Created between baseline and channel registration",
        },
      ],
      onWatchRegistered: async ({ channelId, channelToken, resourceId }) => {
        const response = await createApp({
          signal: context.signal,
          routes: TEST_APP_ROUTES,
        }).request("/api/webhooks/google-calendar", {
          method: "POST",
          headers: {
            "x-goog-channel-id": channelId,
            "x-goog-channel-token": channelToken,
            "x-goog-resource-id": resourceId,
            "x-goog-resource-state": "sync",
            "x-goog-message-number": "1",
          },
        });
        notifications.push({
          status: response.status,
          body: await response.json(),
        });
      },
    });

    await accept(
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

    expect(notifications).toStrictEqual([
      {
        status: 200,
        body: {
          success: true,
          watchStates: 1,
          dispatched: 1,
          duplicates: 0,
        },
      },
    ]);
    expect(watch.baselineCalls).toBe(1);
    expect(watch.incrementalCalls).toBe(1);
    await runs.heartbeatRunner(runnerGroup);
    const job = await runs.pollRunner(runnerGroup);
    expect(job.body.job?.runId).toStrictEqual(expect.any(String));
  });

  it("does not create provider watches for disabled Gmail or Calendar automations", async () => {
    const scenario = await setupFixture();
    await connectGmail(scenario);
    await connectGoogleCalendar(scenario);
    const gmailWatch = configureGmailWatchMock();
    const calendarWatch = configureGoogleCalendarWatchMock();

    const gmail = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
          enabled: false,
        },
      }),
      [201],
    );
    const calendar = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
          enabled: false,
        },
      }),
      [201],
    );

    expect(gmail.body.enabled).toBeFalsy();
    expect(calendar.body.enabled).toBeFalsy();
    expect(gmailWatch.calls).toBe(0);
    expect(calendarWatch.watchCalls).toBe(0);
    expect(calendarWatch.baselineCalls).toBe(0);
  });

  it("keeps a shared Gmail watch until the last consumer and refreshes it for label re-enable", async () => {
    const scenario = await setupFixture();
    await connectGmail(
      scenario,
      `shared-consumer-${scenario.fixture.userId}@example.com`,
    );
    configureGmailLabelsMock([{ id: "Label_support", name: "Support" }]);
    const watch = configureGmailWatchMock(["history-1", "history-2"]);
    const stop = configureGmailStopMock();

    const messageAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    const labelAutomation = await accept(
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
    expect(watch.calls).toBe(1);

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: labelAutomation.body.id },
      }),
      [200],
    );
    expect(stop.calls).toBe(0);

    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: messageAutomation.body.id },
      }),
      [204],
    );
    expect(stop.calls).toBe(1);

    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: labelAutomation.body.id },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    expect(watch.calls).toBe(2);
  });

  it("does not stop a Gmail mailbox while another VM0 identity consumes it", async () => {
    const first = await setupFixture();
    const sharedEmail = `cross-identity-${first.fixture.userId}@example.com`;
    await connectGmail(first, sharedEmail);
    const second = await setupFixture();
    await connectGmail(second, sharedEmail);
    const watch = configureGmailWatchMock();
    const stop = configureGmailStopMock();

    mocks.clerk.session(
      first.fixture.userId,
      first.fixture.orgId,
      "org:member",
    );
    const firstAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: first.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    mocks.clerk.session(
      second.fixture.userId,
      second.fixture.orgId,
      "org:member",
    );
    const secondAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: second.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    expect(watch.calls).toBe(2);

    mocks.clerk.session(
      first.fixture.userId,
      first.fixture.orgId,
      "org:member",
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: firstAutomation.body.id },
      }),
      [200],
    );
    expect(stop.calls).toBe(0);

    mocks.clerk.session(
      second.fixture.userId,
      second.fixture.orgId,
      "org:member",
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: secondAutomation.body.id },
      }),
      [200],
    );
    expect(stop.calls).toBe(1);
  });

  it("renews a shared Gmail mailbox through another healthy identity", async () => {
    const startedAt = Date.parse("2026-08-05T08:00:00.000Z");
    mockNow(startedAt);
    const first = await setupFixture();
    const sharedEmail = `renew-fallback-${first.fixture.userId}@example.com`;
    await connectGmail(first, sharedEmail, {
      refreshToken: "gmail-first-refresh-token",
    });
    mockNow(startedAt + 1000);
    const second = await setupFixture();
    await connectGmail(second, sharedEmail, {
      refreshToken: "gmail-second-refresh-token",
    });
    const watch = configureGmailWatchMock([
      "history-first",
      "history-second",
      "history-renewed",
    ]);

    for (const scenario of [first, second]) {
      mocks.clerk.session(
        scenario.fixture.userId,
        scenario.fixture.orgId,
        "org:member",
      );
      await accept(
        automationsClient().create({
          headers: authHeaders(),
          params: { workflowId: scenario.workflowId },
          body: {
            kind: "event",
            eventType: "gmail-new-message",
            eventConfig: { provider: "gmail", event: "new_message" },
          },
        }),
        [201],
      );
    }
    expect(watch.calls).toBe(2);

    const refreshTokens: string[] = [];
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        const refreshToken = body.get("refresh_token");
        if (!refreshToken) {
          throw new Error("Expected a Gmail refresh token");
        }
        refreshTokens.push(refreshToken);
        if (refreshTokens.length === 1) {
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }
        return HttpResponse.json({
          access_token: "gmail-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
    );
    mockNow(startedAt + 6 * 24 * 60 * 60 * 1000 + 2000);

    const renewed = await accept(
      renewGmailWatchScopeClient().renew({
        body: {
          email_address: sharedEmail,
          topic_name: GMAIL_TOPIC_NAME,
        },
      }),
      [200],
    );

    expect(renewed.body).toStrictEqual({
      success: true,
      renewed: 1,
      failed: 0,
    });
    expect(new Set(refreshTokens)).toStrictEqual(
      new Set(["gmail-first-refresh-token", "gmail-second-refresh-token"]),
    );
    expect(watch.calls).toBe(3);
  });

  it("stops Calendar with the persisted channel pair after the last consumer", async () => {
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const watch = configureGoogleCalendarWatchMock();
    const stop = configureGoogleCalendarStopMock();

    const createdAutomation = await accept(
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
    const updatedAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-updated",
        },
      }),
      [201],
    );
    expect(watch.watchCalls).toBe(1);

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: createdAutomation.body.id },
      }),
      [200],
    );
    expect(stop.calls).toBe(0);

    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: updatedAutomation.body.id },
      }),
      [204],
    );
    expect(stop.requests).toStrictEqual([
      { id: watch.channelIds[0], resourceId: "calendar-resource-1" },
    ]);

    await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: createdAutomation.body.id },
      }),
      [200],
    );
    expect(watch.watchCalls).toBe(2);
    expect(watch.baselineCalls).toBe(2);
  });

  it("keeps a concurrent Calendar disable authoritative during registration", async () => {
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const registrationStarted = createDeferredPromise<void>(context.signal);
    const releaseRegistration = createDeferredPromise<void>(context.signal);
    let blockRegistration = true;
    const watch = configureGoogleCalendarWatchMock({
      onWatchRegistered: async () => {
        if (!blockRegistration) {
          return;
        }
        blockRegistration = false;
        registrationStarted.resolve(undefined);
        await releaseRegistration.promise;
      },
    });
    const stop = configureGoogleCalendarStopMock();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
          enabled: false,
        },
      }),
      [201],
    );

    const enabling = accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200, 400],
    );
    await registrationStarted.promise;
    const disabled = await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    releaseRegistration.resolve(undefined);

    expect(disabled.body.enabled).toBeFalsy();
    const supersededEnable = await enabling;
    expect(supersededEnable.status).toBe(400);
    expect(stop.requests).toStrictEqual([
      { id: watch.channelIds[0], resourceId: "calendar-resource-1" },
    ]);
    await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
      enabled: false,
    });

    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    expect(watch.watchCalls).toBe(2);
  });

  it("recovers after Calendar registration outlives its connector state", async () => {
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    let deleteConnector = true;
    const watch = configureGoogleCalendarWatchMock({
      onWatchRegistered: async () => {
        if (!deleteConnector) {
          return;
        }
        deleteConnector = false;
        await connectorsApi.disconnectSingleBuiltinConnectorAccount(
          scenario.actor,
          "google-calendar",
        );
      },
    });
    const stop = configureGoogleCalendarStopMock();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
          enabled: false,
        },
      }),
      [201],
    );

    const failedEnable = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/workflow-automations/${created.body.id}/enable`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(failedEnable.status).toBe(500);
    expect(stop.requests).toStrictEqual([
      { id: watch.channelIds[0], resourceId: "calendar-resource-1" },
    ]);
    await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
      enabled: false,
    });

    await connectGoogleCalendar(scenario);
    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    expect(watch.watchCalls).toBe(2);
  });

  it("does not create a Calendar channel when baseline setup fails", async () => {
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const watch = configureGoogleCalendarWatchMock();
    const stop = configureGoogleCalendarStopMock();
    server.use(
      http.get(
        "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
        () => {
          return HttpResponse.json(
            { error: "baseline failed" },
            { status: 500 },
          );
        },
      ),
    );

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [400],
    );

    expect(watch.watchCalls).toBe(0);
    expect(stop.calls).toBe(0);
    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(0);
  });

  it("keeps a failed Gmail stop retryable and repairs it in the renewal pass", async () => {
    const scenario = await setupFixture();
    const email = `retry-stop-${scenario.fixture.userId}@example.com`;
    await connectGmail(scenario, email);
    const watch = configureGmailWatchMock(["history-1", "history-2"]);
    const stop = configureGmailStopMock([500, 500, 204]);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
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
    expect(stop.calls).toBe(1);

    await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(watch.calls).toBe(2);

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(stop.calls).toBe(2);

    const reconciled = await accept(
      renewGmailWatchScopeClient().renew({
        body: {
          email_address: email,
          topic_name: GMAIL_TOPIC_NAME,
        },
      }),
      [200],
    );
    expect(reconciled.body).toStrictEqual({
      success: true,
      renewed: 0,
      failed: 0,
    });
    expect(stop.calls).toBe(3);
  });

  it("retries an inactive Calendar stop without renewing the channel", async () => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const watch = configureGoogleCalendarWatchMock();
    const stop = configureGoogleCalendarStopMock([500, 204]);
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
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(stop.calls).toBe(1);

    const reconciled = await accept(
      renewGoogleCalendarWatchesClient().renew({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(reconciled.body).toStrictEqual({
      success: true,
      renewed: 0,
      failed: 0,
    });
    expect(stop.calls).toBe(2);
    expect(watch.watchCalls).toBe(1);
    expect(stop.requests[1]).toStrictEqual({
      id: watch.channelIds[0],
      resourceId: "calendar-resource-1",
    });
  });

  it("retains a replaced Calendar channel until its stop succeeds", async () => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    const startedAt = Date.parse("2026-08-05T08:00:00.000Z");
    mockNow(startedAt);
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const watch = configureGoogleCalendarWatchMock();
    const stop = configureGoogleCalendarStopMock([500, 204]);
    await accept(
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

    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json({
          access_token: "calendar-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
    );
    mockNow(startedAt + 6 * 24 * 60 * 60 * 1000);
    const renewed = await accept(
      renewGoogleCalendarWatchesClient().renew({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(renewed.body).toStrictEqual({
      success: true,
      renewed: 1,
      failed: 0,
    });
    expect(watch.watchCalls).toBe(2);
    expect(watch.baselineCalls).toBe(1);
    expect(stop.requests).toStrictEqual([
      { id: watch.channelIds[0], resourceId: "calendar-resource-1" },
    ]);

    const reconciled = await accept(
      renewGoogleCalendarWatchesClient().renew({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(reconciled.body).toStrictEqual({
      success: true,
      renewed: 0,
      failed: 0,
    });
    expect(watch.watchCalls).toBe(2);
    expect(stop.requests).toStrictEqual([
      { id: watch.channelIds[0], resourceId: "calendar-resource-1" },
      { id: watch.channelIds[0], resourceId: "calendar-resource-1" },
    ]);
  });

  it("leaves a Gmail automation disabled when watch setup fails", async () => {
    const scenario = await setupFixture();
    await connectGmail(
      scenario,
      `watch-failure-${scenario.fixture.userId}@example.com`,
    );
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({ error: "watch failed" }, { status: 500 });
      }),
    );

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
          enabled: false,
        },
      }),
      [201],
    );
    await accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [400],
    );

    await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
      enabled: false,
    });
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [400],
    );
    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
      }),
      [200],
    );
    expect(listed.body).toMatchObject([
      { id: created.body.id, enabled: false },
    ]);
  });

  it("serializes last-consumer disable with re-enable", async () => {
    const scenario = await setupFixture();
    await connectGmail(
      scenario,
      `concurrent-lifecycle-${scenario.fixture.userId}@example.com`,
    );
    const watch = configureGmailWatchMock(["history-1", "history-2"]);
    const stopStarted = createDeferredPromise<void>(context.signal);
    const releaseStop = createDeferredPromise<void>(context.signal);
    let stopCalls = 0;
    server.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/stop",
        async () => {
          stopCalls += 1;
          stopStarted.resolve(undefined);
          await releaseStop.promise;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );

    const disabling = accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    await stopStarted.promise;
    const enabling = accept(
      automationsClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    releaseStop.resolve(undefined);

    await disabling;
    const enabled = await enabling;
    expect(enabled.body.enabled).toBeTruthy();
    expect(stopCalls).toBe(1);
    expect(watch.calls).toBe(2);
    await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
      enabled: true,
    });
  });

  it("reconciles Gmail watches after workflow and agent cascade deletion", async () => {
    const workflowScenario = await setupFixture();
    await connectGmail(
      workflowScenario,
      `workflow-cascade-${workflowScenario.fixture.userId}@example.com`,
    );
    const watch = configureGmailWatchMock();
    const stop = configureGmailStopMock();
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: workflowScenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    await accept(
      detailClient().delete({
        headers: authHeaders(),
        params: { workflowId: workflowScenario.workflowId },
      }),
      [204],
    );
    expect(stop.calls).toBe(1);

    const agentScenario = await setupFixture();
    await connectGmail(
      agentScenario,
      `agent-cascade-${agentScenario.fixture.userId}@example.com`,
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: agentScenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    await bdd.deleteAgent(agentScenario.actor, agentScenario.agentId);
    expect(watch.calls).toBe(2);
    expect(stop.calls).toBe(2);
  });

  it("stops a provider watch before connector credentials are removed", async () => {
    const scenario = await setupFixture();
    await connectGmail(
      scenario,
      `connector-cleanup-${scenario.fixture.userId}@example.com`,
    );
    configureGmailWatchMock();
    const stop = configureGmailStopMock();
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );

    await connectorsApi.disconnectSingleBuiltinConnectorAccount(
      scenario.actor,
      "gmail",
    );
    expect(stop.calls).toBe(1);
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

  it("creates and updates GitHub pull request automations", async () => {
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
          eventType: "github-pull-request",
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "vm0-ai/vm0",
            action: "closed",
            merged: true,
            filters: {
              baseBranches: ["main"],
              authors: ["pr-author"],
              pullRequestNumbers: ["42"],
            },
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "github-pull-request",
      eventConfig: {
        provider: "github",
        event: "pull_request",
        repository: "vm0-ai/vm0",
        action: "closed",
        merged: true,
        filters: {
          baseBranches: ["main"],
          authors: ["pr-author"],
          pullRequestNumbers: ["42"],
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
            event: "pull_request",
            repository: "vm0-ai/vm0",
            action: "labeled",
            filters: {
              labels: ["ready-to-merge"],
            },
          },
        },
      }),
      [200],
    );

    expect(updated.body.kind).toBe("event");
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "github-pull-request"
    ) {
      throw new Error("Expected a GitHub pull request automation");
    }
    expect(updated.body.eventConfig).toStrictEqual({
      provider: "github",
      event: "pull_request",
      repository: "vm0-ai/vm0",
      action: "labeled",
      filters: {
        labels: ["ready-to-merge"],
      },
    });

    const rejected = await automationsClient().update({
      headers: authHeaders(),
      params: { id: created.body.id },
      body: {
        eventConfig: {
          provider: "github",
          event: "pull_request",
          repository: "vm0-ai/vm0",
          action: "opened",
          merged: true,
          filters: {},
        },
      },
    });
    expect(rejected.status).toBe(400);
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

  it("rejects GitHub pull request automations when the GitHub App is not installed", async () => {
    const scenario = await setupFixture();
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
          eventType: "github-pull-request",
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "vm0-ai/vm0",
            action: "closed",
            filters: {},
          },
        },
      }),
      [400],
    );

    expect(created.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Install GitHub before creating GitHub webhook automations",
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
      "claude-sonnet-5",
    );
  });

  it("runs a one-time automation immediately in its bound chat thread", async () => {
    const requestedAt = Date.UTC(2026, 7, 1, 12, 34, 56);
    mockNow(requestedAt);
    const runnerGroup = runs.configureRunnerGroup();
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
          trigger_source: "automation-schedule",
          agent_run_origin: "workflow_automation",
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
          trigger_source: "automation-schedule",
          agent_run_origin: "workflow_automation",
          span_kind: "nested",
        }),
      ]),
    );
    expect(JSON.stringify(timingEvents)).not.toContain(WORKFLOW_NAME);

    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.body.runId);
    const requestedAtIso = new Date(requestedAt).toISOString();
    expect(claim.prompt).toContain(
      `/${WORKFLOW_NAME}\n\nAutomation event\nType: manual\nSummary: manual run requested at ${requestedAtIso}.`,
    );
    expect(claim.prompt).toContain(
      JSON.stringify(
        {
          automationId: created.body.id,
          trigger: "manual",
          requestedAt: requestedAtIso,
        },
        null,
        2,
      ),
    );
    expect(claim.appendSystemPrompt).toContain("# Agent Identity");
    expect(claim.appendSystemPrompt).not.toContain("# Current context");

    const automation = await wf.readAutomation(created.body.id);
    expect(typeof automation.lastRunAt).toBe("string");
    expect(automation.nextRunAt).toBe(created.body.nextRunAt);

    // The run landed in the bound thread as the workflow slash-command user
    // message, linked to the created run id.
    const messages = await wf.readThreadEvents(threadId);
    const workflowMessage = messages.find((message) => {
      return (
        message.eventType === "input.prompt" &&
        chatEventAutomationPart(message)?.workflowName === WORKFLOW_NAME
      );
    });
    expect(workflowMessage).toBeDefined();
    expect(workflowMessage?.runId).toBe(run.body.runId);
    expect(chatEventDisplayText(workflowMessage!)).toBe(
      "A manual run of this workflow was requested.",
    );
  });

  it("derives automation budgets and blocks creation from budget zero", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const { actor, workflowId } = await setupFixture();
    const rootAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, rootAutomation.body.id),
    ).resolves.toMatchObject({ autonomyBudget: 10 });

    const rootRun = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: rootAutomation.body.id },
      }),
      [201],
    );
    if (!rootRun.body.runId) {
      throw new Error("Expected the root automation to start a run");
    }
    await expect(
      readRunAutonomyBudgetFixture(context, rootRun.body.runId),
    ).resolves.toBe(10);
    const rootToken = runs.okouTokenForRunWithCapabilities(
      actor,
      rootRun.body.runId,
      ["agent:write"],
    );

    const derivedAutomation = await accept(
      automationsClient().create({
        headers: { authorization: `Bearer ${rootToken}` },
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3601 },
        },
      }),
      [201],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, derivedAutomation.body.id),
    ).resolves.toMatchObject({ autonomyBudget: 9 });

    await setRunAutonomyBudgetFixture(context, rootRun.body.runId, 1);
    const zeroBudgetAutomation = await accept(
      automationsClient().create({
        headers: { authorization: `Bearer ${rootToken}` },
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3602 },
        },
      }),
      [201],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(
        context,
        zeroBudgetAutomation.body.id,
      ),
    ).resolves.toMatchObject({ autonomyBudget: 0 });
    await runs.requestCancelRun(actor, rootRun.body.runId, [200]);
    await flushWaitUntilForTest();

    const exhaustedRun = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: zeroBudgetAutomation.body.id },
      }),
      [201],
    );
    if (!exhaustedRun.body.runId) {
      throw new Error("Expected the zero-budget automation to start its run");
    }
    await expect(
      readRunAutonomyBudgetFixture(context, exhaustedRun.body.runId),
    ).resolves.toBe(0);
    const exhaustedToken = runs.okouTokenForRunWithCapabilities(
      actor,
      exhaustedRun.body.runId,
      ["agent:write"],
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: derivedAutomation.body.id },
      }),
      [200],
    );
    const blockedEnable = await accept(
      automationsClient().enable({
        headers: { authorization: `Bearer ${exhaustedToken}` },
        params: { id: derivedAutomation.body.id },
      }),
      [409],
    );
    expect(blockedEnable.body.error.code).toBe("AUTONOMY_BUDGET_EXHAUSTED");
    await expect(
      readWorkflowAutomationAutonomyFixture(context, derivedAutomation.body.id),
    ).resolves.toMatchObject({ autonomyBudget: 9, enabled: false });

    await setRunAutonomyBudgetFixture(context, exhaustedRun.body.runId, 2);
    await accept(
      automationsClient().enable({
        headers: { authorization: `Bearer ${exhaustedToken}` },
        params: { id: derivedAutomation.body.id },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, derivedAutomation.body.id),
    ).resolves.toMatchObject({ autonomyBudget: 1, enabled: true });

    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: derivedAutomation.body.id },
      }),
      [200],
    );
    await setRunAutonomyBudgetFixture(context, exhaustedRun.body.runId, 5);
    await accept(
      automationsClient().enable({
        headers: { authorization: `Bearer ${exhaustedToken}` },
        params: { id: derivedAutomation.body.id },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, derivedAutomation.body.id),
    ).resolves.toMatchObject({ autonomyBudget: 4, enabled: true });
    await setRunAutonomyBudgetFixture(context, exhaustedRun.body.runId, 0);

    const blocked = await accept(
      automationsClient().create({
        headers: { authorization: `Bearer ${exhaustedToken}` },
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 7200 },
        },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("AUTONOMY_BUDGET_EXHAUSTED");
    await runs.requestCancelRun(actor, exhaustedRun.body.runId, [200]);
  });

  it("derives manual run budgets from the source and rejects exhausted agent callers", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const { actor, workflowId } = await setupFixture();
    const automation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );
    await setWorkflowAutomationAutonomyBudgetFixture(
      context,
      automation.body.id,
      0,
    );
    const sourceRun = await accept(
      automationsClient().run({
        headers: authHeaders(),
        params: { id: automation.body.id },
      }),
      [201],
    );
    if (!sourceRun.body.runId) {
      throw new Error("Expected the source automation run to start");
    }
    const sourceToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sourceRun.body.runId,
      ["agent:write"],
    );
    await runs.requestCancelRun(actor, sourceRun.body.runId, [200]);
    await flushWaitUntilForTest();

    await setRunAutonomyBudgetFixture(context, sourceRun.body.runId, 2);
    const childRun = await accept(
      automationsClient().run({
        headers: { authorization: `Bearer ${sourceToken}` },
        params: { id: automation.body.id },
      }),
      [201],
    );
    if (!childRun.body.runId) {
      throw new Error("Expected a budget-two caller to start a child run");
    }
    await expect(
      readRunAutonomyBudgetFixture(context, childRun.body.runId),
    ).resolves.toBe(1);
    await expect(
      readWorkflowAutomationAutonomyFixture(context, automation.body.id),
    ).resolves.toMatchObject({ autonomyBudget: 0 });
    await runs.requestCancelRun(actor, childRun.body.runId, [200]);
    await flushWaitUntilForTest();

    await setRunAutonomyBudgetFixture(context, sourceRun.body.runId, 0);
    const blocked = await accept(
      automationsClient().run({
        headers: { authorization: `Bearer ${sourceToken}` },
        params: { id: automation.body.id },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("AUTONOMY_BUDGET_EXHAUSTED");
  });
});
