import { createHash } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { expect } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { webhooksGoogleCalendarRoutes } from "../webhooks-google-calendar";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksGoogleCalendarRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

async function completeRunThroughSandbox(
  sandboxToken: string,
  runId: string,
): Promise<void> {
  const sandboxHeaders = { authorization: `Bearer ${sandboxToken}` };
  await webhooksApi.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `calendar-webhook-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`calendar webhook history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    { runId, exitCode: 0 },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

const WORKFLOW_NAME = "calendar-webhook-workflow";
const CALENDAR_EMAIL = "calendar-webhook-user@example.com";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
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

interface GoogleCalendarWatchChannel {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
}

interface GoogleCalendarApiRecorder {
  /** Watch channels registered against the provider, in order. */
  readonly channels: GoogleCalendarWatchChannel[];
  baselineCalls: number;
  incrementalCalls: number;
}

function configureGoogleCalendarApiMock(args: {
  readonly baselineItems?: readonly Record<string, unknown>[];
  readonly incrementalItems?: readonly Record<string, unknown>[];
  readonly incrementalNextSyncToken?: string;
  readonly incrementalResponses?: readonly {
    readonly items: readonly Record<string, unknown>[];
    readonly nextSyncToken: string;
  }[];
}): GoogleCalendarApiRecorder {
  const recorder: GoogleCalendarApiRecorder = {
    channels: [],
    baselineCalls: 0,
    incrementalCalls: 0,
  };
  let incrementalCallCount = 0;
  mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
  server.use(
    http.post(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
      async ({ request, params }) => {
        expect(params.calendarId).toBe("primary");
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
        if (!body.id || !body.token) {
          throw new Error("Expected calendar watch id and token");
        }
        recorder.channels.push({
          channelId: body.id,
          channelToken: body.token,
          resourceId: "calendar-resource-1",
        });
        return HttpResponse.json({
          id: body.id,
          resourceId: "calendar-resource-1",
          resourceUri:
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
      ({ request, params }) => {
        expect(params.calendarId).toBe("primary");
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const url = new URL(request.url);
        expect(url.searchParams.get("showDeleted")).toBe("true");
        expect(url.searchParams.get("maxResults")).toBe("2500");
        const syncToken = url.searchParams.get("syncToken");
        if (!syncToken) {
          recorder.baselineCalls += 1;
          return HttpResponse.json({
            items: args.baselineItems ?? [],
            nextSyncToken: "calendar-sync-baseline",
          });
        }
        recorder.incrementalCalls += 1;
        expect(syncToken).toBeTruthy();
        const sequentialResponse =
          args.incrementalResponses?.[
            Math.min(incrementalCallCount, args.incrementalResponses.length - 1)
          ];
        incrementalCallCount += 1;
        if (sequentialResponse) {
          return HttpResponse.json({
            items: sequentialResponse.items,
            nextSyncToken: sequentialResponse.nextSyncToken,
          });
        }
        return HttpResponse.json({
          items: args.incrementalItems ?? [],
          nextSyncToken: args.incrementalNextSyncToken ?? "calendar-sync-next",
        });
      },
    ),
  );
  return recorder;
}

interface CalendarScenario {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly runnerGroup: string;
  readonly workflowId: string;
}

async function setupFixture(): Promise<CalendarScenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  const { actor } = await wf.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Calendar Webhook Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor: { ...actor, orgId: actor.orgId },
    runnerGroup,
    workflowId,
  };
}

async function expectAutomationDisplayMessage(
  threadId: string,
  expectedMessage: string,
): Promise<void> {
  const events = await wf.readThreadEvents(threadId);
  const visibleEvent = events.find((event) => {
    return (
      event.eventType === "input.automation" ||
      event.eventType === "input.prompt"
    );
  });
  if (!visibleEvent) {
    throw new Error("Expected a visible calendar automation event");
  }
  expect(chatEventDisplayText(visibleEvent)).toBe(expectedMessage);
}

async function connectGoogleCalendar(
  scenario: CalendarScenario,
): Promise<void> {
  mockGoogleCalendarConnectorOAuth({ email: CALENDAR_EMAIL });
  await wf.connectConnector(scenario.actor, "google-calendar");
  if (!scenario.actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  mocks.clerk.session(
    scenario.actor.userId,
    scenario.actor.orgId,
    "org:member",
  );
}

async function postGoogleCalendarWebhook(
  headers: NonNullable<RequestInit["headers"]>,
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/webhooks/google-calendar", {
    method: "POST",
    headers,
    body: "",
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function webhookHeaders(
  state: GoogleCalendarWatchChannel,
  overrides?: Record<string, string>,
): Record<string, string> {
  return {
    "x-goog-channel-id": state.channelId,
    "x-goog-channel-token": state.channelToken,
    "x-goog-resource-id": state.resourceId,
    "x-goog-resource-state": "exists",
    "x-goog-message-number": "2",
    ...overrides,
  };
}

describe("POST /api/webhooks/google-calendar", () => {
  it("short-circuits before Calendar event reads when no consumer remains", async () => {
    const recorder = configureGoogleCalendarApiMock({});
    server.use(
      http.post("https://www.googleapis.com/calendar/v3/channels/stop", () => {
        return HttpResponse.json({ error: "stop failed" }, { status: 500 });
      }),
    );
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
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
    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    const response = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    expect(recorder.baselineCalls).toBe(1);
    expect(recorder.incrementalCalls).toBe(0);

    server.use(
      http.post("https://www.googleapis.com/calendar/v3/channels/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("dispatches newly created calendar events and de-duplicates retries", async () => {
    const recorder = configureGoogleCalendarApiMock({
      incrementalItems: [
        {
          id: "event-created-1",
          etag: '"created-etag"',
          status: "confirmed",
          summary: "Planning",
          htmlLink: "https://calendar.google.com/event?eid=1",
          created: "2026-06-29T01:00:00.000Z",
          updated: "2026-06-29T01:00:00.000Z",
          start: { dateTime: "2026-06-30T09:00:00-07:00" },
          end: { dateTime: "2026-06-30T09:30:00-07:00" },
          organizer: { email: CALENDAR_EMAIL, self: true },
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await updateFeatureSwitchesForUser(context, scenario.actor, {
      [FeatureSwitchKey.ConnectorAccounts]: true,
    });
    await connectGoogleCalendar(scenario);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    await expectAutomationDisplayMessage(
      created.body.chatThreadId,
      'Google Calendar event "Planning" was created.',
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(),
        params: { id: created.body.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    const firstRunId = firstJob.body.job!.runId;
    await runsApi.claimRunnerJob(firstRunId);
    const timingEvents = sandboxOperationEventsForRun(firstRunId);
    const actionTypes = new Set(
      timingEvents.map((event) => {
        return event.op_type;
      }),
    );
    for (const actionType of [
      "api_dispatch_pre_create_zero_workflow_automation_entrypoint_gap",
      "api_dispatch_pre_create_zero_automation_event_load_source_state",
      "api_dispatch_pre_create_zero_automation_event_load_external_events",
      "api_dispatch_pre_create_zero_automation_event_load_automations",
      "api_dispatch_pre_create_zero_automation_event_match_automations",
      "api_dispatch_pre_create_zero_automation_event_record_processed_event",
      "api_dispatch_pre_create_zero_automation_event_build_run_input",
      "api_dispatch_pre_create_zero_automation_event_handoff_run",
    ]) {
      expect(actionTypes).toContain(actionType);
    }
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_automation_event_handoff_run",
          automation_event_source: "google_calendar",
          trigger_source: "automation-event",
          agent_run_origin: "workflow_automation",
          span_kind: "nested",
        }),
      ]),
    );
    const serializedTiming = JSON.stringify(timingEvents);
    expect(serializedTiming).not.toContain(CALENDAR_EMAIL);
    expect(serializedTiming).not.toContain("event-created-1");
    expect(serializedTiming).not.toContain("Planning");
    expect(serializedTiming).not.toContain(
      "https://calendar.google.com/event?eid=1",
    );
    expect(serializedTiming).not.toContain(watch.channelId);
    expect(serializedTiming).not.toContain(watch.resourceId);
    expect(serializedTiming).not.toContain(created.body.id);
    expect(serializedTiming).not.toContain(WORKFLOW_NAME);

    // A redelivery for the same event revision dispatches nothing and no new
    // runner job appears.
    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const idleAfterDuplicate = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterDuplicate.body.job).toBeNull();
  });

  it("ignores updated and cancelled calendar events", async () => {
    const recorder = configureGoogleCalendarApiMock({
      baselineItems: [
        {
          id: "event-existing",
          etag: '"existing-etag"',
          status: "confirmed",
          summary: "Existing",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
        },
      ],
      incrementalItems: [
        {
          id: "event-existing",
          etag: '"updated-etag"',
          status: "confirmed",
          summary: "Existing updated",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-29T01:00:00.000Z",
        },
        {
          id: "event-cancelled",
          status: "cancelled",
          created: "2026-06-29T01:00:00.000Z",
          updated: "2026-06-29T01:00:00.000Z",
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await connectGoogleCalendar(scenario);

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const response = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    await runsApi.heartbeatRunner(runnerGroup);
    const idle = await runsApi.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();
  });

  it("dispatches updated calendar events once per event revision", async () => {
    const recorder = configureGoogleCalendarApiMock({
      baselineItems: [
        {
          id: "event-existing",
          etag: '"existing-etag-1"',
          status: "confirmed",
          summary: "Existing",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
        },
      ],
      incrementalResponses: [
        {
          items: [
            {
              id: "event-existing",
              etag: '"existing-etag-2"',
              status: "confirmed",
              summary: "Existing updated",
              created: "2026-06-01T00:00:00.000Z",
              updated: "2026-06-29T01:00:00.000Z",
            },
          ],
          nextSyncToken: "calendar-sync-updated-1",
        },
        {
          items: [
            {
              id: "event-existing",
              etag: '"existing-etag-2"',
              status: "confirmed",
              summary: "Existing updated",
              created: "2026-06-01T00:00:00.000Z",
              updated: "2026-06-29T01:00:00.000Z",
            },
          ],
          nextSyncToken: "calendar-sync-updated-2",
        },
        {
          items: [
            {
              id: "event-existing",
              etag: '"existing-etag-3"',
              status: "confirmed",
              summary: "Existing updated again",
              created: "2026-06-01T00:00:00.000Z",
              updated: "2026-06-29T02:00:00.000Z",
            },
          ],
          nextSyncToken: "calendar-sync-updated-3",
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await connectGoogleCalendar(scenario);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-updated",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    await expectAutomationDisplayMessage(
      created.body.chatThreadId,
      'Google Calendar event "Existing updated" was updated.',
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    const firstClaim = await runsApi.claimRunnerJob(firstJob.body.job!.runId);

    // The same revision (same etag) arriving again dispatches nothing.
    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const idleAfterSameRevision = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterSameRevision.body.job).toBeNull();

    // Finish the first run so the workflow queue can dispatch the next event.
    await completeRunThroughSandbox(
      firstClaim.sandboxToken,
      firstJob.body.job!.runId,
    );

    // A new revision (new etag) dispatches exactly one more run.
    const third = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(third.status).toBe(200);
    expect(third.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    const thirdJob = await runsApi.pollRunner(runnerGroup);
    expect(thirdJob.body.job?.runId).toStrictEqual(expect.any(String));
    expect(thirdJob.body.job?.runId).not.toBe(firstJob.body.job?.runId);
    await runsApi.claimRunnerJob(thirdJob.body.job!.runId);
    const idleAfterThird = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterThird.body.job).toBeNull();
  });

  it("dispatches cancelled calendar events and de-duplicates minimal deleted payloads", async () => {
    const recorder = configureGoogleCalendarApiMock({
      baselineItems: [
        {
          id: "event-existing",
          etag: '"existing-etag"',
          status: "confirmed",
          summary: "Existing",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
        },
      ],
      incrementalResponses: [
        {
          items: [
            {
              id: "event-existing",
              status: "cancelled",
            },
          ],
          nextSyncToken: "calendar-sync-cancelled-1",
        },
        {
          items: [
            {
              id: "event-existing",
              status: "cancelled",
            },
          ],
          nextSyncToken: "calendar-sync-cancelled-2",
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await connectGoogleCalendar(scenario);
    const cancelled = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-cancelled",
        },
      }),
      [201],
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-updated",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    if (!cancelled.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    await expectAutomationDisplayMessage(
      cancelled.body.chatThreadId,
      "A Google Calendar event was cancelled.",
    );
    // Only the cancelled automation dispatched a run; the minimal deleted
    // payload never reaches the updated automation.
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    await runsApi.claimRunnerJob(firstJob.body.job!.runId);
    const idleAfterFirst = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterFirst.body.job).toBeNull();

    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const idleAfterSecond = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterSecond.body.job).toBeNull();
  });

  it("rejects webhook notifications with the wrong channel token", async () => {
    const recorder = configureGoogleCalendarApiMock({});

    const scenario = await setupFixture();
    const { workflowId } = scenario;
    await connectGoogleCalendar(scenario);

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const response = await postGoogleCalendarWebhook(
      webhookHeaders(watch, { "x-goog-channel-token": "wrong-token" }),
    );

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({ error: "Unauthorized" });
  });
});
