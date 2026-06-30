import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { expect } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  deleteWorkflowsForFixture$,
  getWorkflowGoogleCalendarWatchState$,
  seedAgentForInstructions$,
  seedWorkflowConnector$,
  seedWorkflowsFixture$,
  type GoogleCalendarWatchState,
  type WorkflowsFixture,
} from "./helpers/zero-workflows";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const runsApi = createRunsAutomationsApi(context);

const WORKFLOW_NAME = "calendar-webhook-workflow";
const CALENDAR_EMAIL = "calendar-webhook-user@example.com";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

async function enableGoogleCalendarWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowGoogleCalendarEventTriggers]: true,
  });
}

async function seedGoogleCalendarConnector(
  fixture: WorkflowsFixture,
): Promise<string> {
  return await store.set(
    seedWorkflowConnector$,
    {
      fixture,
      connectorType: "google-calendar",
      externalEmail: CALENDAR_EMAIL,
      accessToken: "calendar-access-token",
    },
    context.signal,
  );
}

function configureGoogleCalendarApiMock(args: {
  readonly baselineItems?: readonly Record<string, unknown>[];
  readonly incrementalItems?: readonly Record<string, unknown>[];
  readonly incrementalNextSyncToken?: string;
}): void {
  mockOptionalEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");
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
        expect(body.id).toBeTruthy();
        expect(body.token).toBeTruthy();
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
          return HttpResponse.json({
            items: args.baselineItems ?? [],
            nextSyncToken: "calendar-sync-baseline",
          });
        }
        expect(["calendar-sync-baseline", "calendar-sync-next"]).toContain(
          syncToken,
        );
        return HttpResponse.json({
          items: args.incrementalItems ?? [],
          nextSyncToken: args.incrementalNextSyncToken ?? "calendar-sync-next",
        });
      },
    ),
  );
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly runnerGroup: string;
  readonly workflowId: string;
}> {
  const runnerGroup = runsApi.configureRunnerGroup();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  const fixture = await store.set(
    seedWorkflowsFixture$,
    undefined,
    context.signal,
  );
  context.mocks.s3.send.mockResolvedValue({});
  const seededAgent = await store.set(
    seedAgentForInstructions$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "calendar-webhook-agent",
      workflowNames: [WORKFLOW_NAME],
      composeContent: {
        version: "1",
        agents: {
          "calendar-webhook-agent": {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
    },
    context.signal,
  );
  const workflowId = seededAgent.workflowIdsByName[WORKFLOW_NAME];
  if (!workflowId) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  return { fixture, runnerGroup, workflowId };
}

async function postGoogleCalendarWebhook(headers: HeadersInit): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await createApp({ signal: context.signal }).request(
    "/api/webhooks/google-calendar",
    {
      method: "POST",
      headers,
      body: "",
    },
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

function webhookHeaders(
  state: GoogleCalendarWatchState,
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
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("dispatches newly created calendar events and de-duplicates retries", async () => {
    configureGoogleCalendarApiMock({
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

    const { fixture, runnerGroup, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watchState = await store.set(
      getWorkflowGoogleCalendarWatchState$,
      { connectorId, triggerId: created.body.id },
      context.signal,
    );
    const watch = watchState.watches[0];
    if (!watch) {
      throw new Error("Expected Google Calendar watch state");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    await runsApi.claimRunnerJob(firstJob.body.job!.runId);

    const updatedWatchState = await store.set(
      getWorkflowGoogleCalendarWatchState$,
      { connectorId, triggerId: created.body.id },
      context.signal,
    );
    expect(updatedWatchState.processed).toStrictEqual([
      { calendarEventId: "event-created-1" },
    ]);
    expect(updatedWatchState.snapshots).toStrictEqual([
      { calendarEventId: "event-created-1" },
    ]);
    expect(updatedWatchState.watches[0]?.syncToken).toBe("calendar-sync-next");

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
    configureGoogleCalendarApiMock({
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

    const { fixture, runnerGroup, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watchState = await store.set(
      getWorkflowGoogleCalendarWatchState$,
      { connectorId, triggerId: created.body.id },
      context.signal,
    );
    const watch = watchState.watches[0];
    if (!watch) {
      throw new Error("Expected Google Calendar watch state");
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

  it("rejects webhook notifications with the wrong channel token", async () => {
    configureGoogleCalendarApiMock({});

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watchState = await store.set(
      getWorkflowGoogleCalendarWatchState$,
      { connectorId, triggerId: created.body.id },
      context.signal,
    );
    const watch = watchState.watches[0];
    if (!watch) {
      throw new Error("Expected Google Calendar watch state");
    }

    const response = await postGoogleCalendarWebhook(
      webhookHeaders(watch, { "x-goog-channel-token": "wrong-token" }),
    );

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({ error: "Unauthorized" });
  });
});
