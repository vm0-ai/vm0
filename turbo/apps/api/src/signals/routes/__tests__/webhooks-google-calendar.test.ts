import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import {
  googleCalendarEventSnapshots,
  googleCalendarProcessedEvents,
  googleCalendarWatchStates,
} from "@vm0/db/schema/google-calendar-event";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { expect, onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptStoredSecretValue } from "../../services/crypto.utils";
import {
  setGoogleCalendarWorkflowRunStarterForTests,
  type GoogleCalendarWorkflowRunStartTestInput,
} from "../../services/google-calendar-workflow-event.service";
import {
  deleteWorkflowsForFixture$,
  seedAgentForInstructions$,
  seedWorkflowsFixture$,
  type WorkflowsFixture,
} from "./helpers/zero-workflows";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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
  await store
    .set(writeDb$)
    .insert(userFeatureSwitches)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: {
        [FeatureSwitchKey.WorkflowGoogleCalendarEventTriggers]: true,
      },
    });
}

async function seedGoogleCalendarConnector(
  fixture: WorkflowsFixture,
): Promise<string> {
  const db = store.set(writeDb$);
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "google-calendar",
      authMethod: "oauth",
      externalEmail: CALENDAR_EMAIL,
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      oauthScopes: JSON.stringify(["https://www.googleapis.com/auth/calendar"]),
    })
    .returning({ id: connectors.id });
  if (!connector) {
    throw new Error("Expected Google Calendar connector to be created");
  }

  await db.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "GOOGLE_CALENDAR_ACCESS_TOKEN",
    encryptedValue: await encryptStoredSecretValue("calendar-access-token"),
    type: "connector",
  });
  return connector.id;
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
          nextSyncToken:
            args.incrementalNextSyncToken ?? "calendar-sync-next",
        });
      },
    ),
  );
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly workflowId: string;
}> {
  const fixture = await store.set(
    seedWorkflowsFixture$,
    undefined,
    context.signal,
  );
  context.mocks.s3.send.mockResolvedValue({});
  const { agentId } = await store.set(
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
  const [workflow] = await store
    .set(writeDb$)
    .select({ id: zeroWorkflows.id })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, fixture.orgId),
        eq(zeroWorkflows.agentId, agentId),
        eq(zeroWorkflows.name, WORKFLOW_NAME),
      ),
    );
  if (!workflow) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  return { fixture, workflowId: workflow.id };
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
  state: typeof googleCalendarWatchStates.$inferSelect,
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
    const db = store.set(writeDb$);
    await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
    await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
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

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);

    const runCalls: GoogleCalendarWorkflowRunStartTestInput[] = [];
    const restoreRunStarter = setGoogleCalendarWorkflowRunStarterForTests(
      (input) => {
        runCalls.push(input);
        return Promise.resolve("ok");
      },
    );
    onTestFinished(() => {
      restoreRunStarter();
    });

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

    const db = store.set(writeDb$);
    const [watch] = await db
      .select()
      .from(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.connectorId, connectorId));
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
    expect(runCalls).toStrictEqual([
      {
        triggerId: created.body.id,
        workflowName: WORKFLOW_NAME,
        calendarId: "primary",
        eventId: "event-created-1",
        summary: "Planning",
      },
    ]);

    const processed = await db
      .select({
        calendarEventId: googleCalendarProcessedEvents.calendarEventId,
      })
      .from(googleCalendarProcessedEvents)
      .where(eq(googleCalendarProcessedEvents.triggerId, created.body.id));
    expect(processed).toStrictEqual([
      { calendarEventId: "event-created-1" },
    ]);

    const snapshots = await db
      .select({
        calendarEventId: googleCalendarEventSnapshots.calendarEventId,
      })
      .from(googleCalendarEventSnapshots)
      .where(eq(googleCalendarEventSnapshots.watchStateId, watch.id));
    expect(snapshots).toStrictEqual([
      { calendarEventId: "event-created-1" },
    ]);

    const [updatedWatch] = await db
      .select({ syncToken: googleCalendarWatchStates.syncToken })
      .from(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.id, watch.id));
    expect(updatedWatch?.syncToken).toBe("calendar-sync-next");

    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    expect(runCalls).toHaveLength(1);
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

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);

    const runCalls: GoogleCalendarWorkflowRunStartTestInput[] = [];
    const restoreRunStarter = setGoogleCalendarWorkflowRunStarterForTests(
      (input) => {
        runCalls.push(input);
        return Promise.resolve("ok");
      },
    );
    onTestFinished(() => {
      restoreRunStarter();
    });

    await accept(
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

    const [watch] = await store
      .set(writeDb$)
      .select()
      .from(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.connectorId, connectorId));
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
    expect(runCalls).toHaveLength(0);
  });

  it("rejects webhook notifications with the wrong channel token", async () => {
    configureGoogleCalendarApiMock({});

    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);

    await accept(
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

    const [watch] = await store
      .set(writeDb$)
      .select()
      .from(googleCalendarWatchStates)
      .where(eq(googleCalendarWatchStates.connectorId, connectorId));
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
