import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const WORKFLOW_TRIGGER_STATE_PATH = "/api/test/workflow-trigger-state/action";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
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

const WORKFLOW_NAME = "trigger-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_EMAIL = "workflow-user@example.com";
const GOOGLE_CALENDAR_EMAIL = "calendar-user@example.com";

interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

function futureIso(offsetMs: number): string {
  return new Date(now() + offsetMs).toISOString();
}

async function workflowTriggerStateAction(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await createApp({ signal: context.signal }).request(
    WORKFLOW_TRIGGER_STATE_PATH,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function seedAgentWithWorkflow(
  fixture: WorkflowsFixture,
  options: {
    readonly agentName?: string;
    readonly workflowName?: string;
    readonly visibility?: "public" | "private";
    readonly userId?: string;
  } = {},
): Promise<{ agentId: string; workflowId: string }> {
  const result = await workflowTriggerStateAction({
    action: "seed-agent-workflow",
    org_id: fixture.orgId,
    user_id: options.userId ?? fixture.userId,
    agent_name: options.agentName ?? "trigger-agent",
    workflow_name: options.workflowName ?? WORKFLOW_NAME,
    visibility: options.visibility,
  });
  expect(typeof result.agent_id).toBe("string");
  expect(typeof result.workflow_id).toBe("string");
  return {
    agentId: result.agent_id as string,
    workflowId: result.workflow_id as string,
  };
}

async function enableGmailWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowGmailEventTriggers]: true,
  });
}

async function enableGoogleCalendarWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowGoogleCalendarEventTriggers]: true,
  });
}

async function enableWebhookWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowWebhookTriggers]: true,
  });
}

async function enableGithubWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowGithubLabelEventTriggers]: true,
  });
}

async function seedGithubInstallation(args: {
  readonly fixture: WorkflowsFixture;
  readonly composeId: string;
  readonly installationId?: string;
}): Promise<string> {
  const result = await workflowTriggerStateAction({
    action: "seed-github-installation",
    org_id: args.fixture.orgId,
    compose_id: args.composeId,
    installation_id: args.installationId,
  });
  expect(typeof result.installation_id).toBe("string");
  return result.installation_id as string;
}

async function seedGithubUserLink(args: {
  readonly installationId: string;
  readonly userId: string;
  readonly githubUserId?: string;
}): Promise<void> {
  await workflowTriggerStateAction({
    action: "seed-github-user-link",
    installation_id: args.installationId,
    user_id: args.userId,
    github_user_id: args.githubUserId,
  });
}

async function seedGmailConnector(fixture: WorkflowsFixture): Promise<string> {
  const result = await workflowTriggerStateAction({
    action: "seed-connector",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    connector_type: "gmail",
    external_email: GMAIL_EMAIL,
    access_token: "gmail-access-token",
  });
  expect(typeof result.connector_id).toBe("string");
  return result.connector_id as string;
}

async function seedGoogleCalendarConnector(
  fixture: WorkflowsFixture,
): Promise<string> {
  const result = await workflowTriggerStateAction({
    action: "seed-connector",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    connector_type: "google-calendar",
    external_email: GOOGLE_CALENDAR_EMAIL,
    access_token: "calendar-access-token",
  });
  expect(typeof result.connector_id).toBe("string");
  return result.connector_id as string;
}

function configureGmailWatchMock(historyId = "100"): void {
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      async ({ request }) => {
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
}

function configureGoogleCalendarWatchMock(args?: {
  readonly calendarId?: string;
  readonly baselineItems?: readonly Record<string, unknown>[];
}): void {
  const calendarId = args?.calendarId ?? "primary";
  mockOptionalEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");
  server.use(
    http.post(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
      async ({ request, params }) => {
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

describe("zero workflow triggers", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await workflowTriggerStateAction({
      action: "delete-scenario",
      org_id: fixture.orgId,
    });
  });

  async function setupFixture(): Promise<{
    fixture: WorkflowsFixture;
    agentId: string;
    workflowId: string;
  }> {
    const seeded = await workflowTriggerStateAction({
      action: "seed-scenario",
      workflow_name: WORKFLOW_NAME,
      agent_name: "trigger-agent",
    });
    const rawFixture = seeded.fixture as {
      readonly org_id: string;
      readonly user_id: string;
      readonly agent_id: string;
      readonly workflow_id: string;
    };
    const fixture = await track(
      Promise.resolve({
        orgId: rawFixture.org_id,
        userId: rawFixture.user_id,
      }),
    );
    const agentId = rawFixture.agent_id;
    const workflowId = rawFixture.workflow_id;
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    return { fixture, agentId, workflowId };
  }

  it("creates a cron trigger and eagerly binds a chat thread", async () => {
    const { workflowId } = await setupFixture();

    const created = await accept(
      triggersClient().create({
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
    if (created.body.kind !== "schedule") {
      throw new Error("Expected a schedule trigger");
    }
    expect(created.body.scheduleSummary.length).toBeGreaterThan(0);
  });

  it("lists thread-bound workflow triggers", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [201],
    );
    const second = await accept(
      triggersClient().create({
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
      throw new Error("Expected the workflow trigger to bind a chat thread");
    }
    expect(second.body.chatThreadId).toBe(threadId);

    const listed = await accept(
      triggersClient().listForChatThread({
        headers: authHeaders(),
        params: { threadId },
      }),
      [200],
    );

    expect(listed.body).toHaveLength(2);
    expect(
      listed.body.map((trigger) => {
        return {
          id: trigger.id,
          kind: trigger.kind,
          scheduleSummary: trigger.scheduleSummary,
          chatThreadId: trigger.chatThreadId,
          workflow: trigger.workflow,
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

  it("stores trigger chat threads at the workflow-user level", async () => {
    const { workflowId } = await setupFixture();
    const first = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [201],
    );
    const second = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 120 } },
      }),
      [201],
    );

    expect(second.body.chatThreadId).toBe(first.body.chatThreadId);

    const workflowState = await workflowTriggerStateAction({
      action: "get-workflow-state",
      workflow_id: workflowId,
    });
    expect(workflowState.binding).toStrictEqual({
      chatThreadId: first.body.chatThreadId,
    });
    expect(workflowState.triggers).toHaveLength(2);
  });

  it("creates and updates one-time schedules from local atTime and timezone", async () => {
    mockNow(Date.parse("2026-06-22T07:50:00.000Z"));
    const { workflowId } = await setupFixture();

    const created = await accept(
      triggersClient().create({
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
      triggersClient().update({
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
  });

  it("rejects creation on a workflow the caller cannot see", async () => {
    const { fixture } = await setupFixture();
    // A private workflow under another user's private agent is invisible to
    // this member, so trigger creation is rejected as not-found.
    const otherUserId = `user_${randomUUID()}`;
    const hidden = await seedAgentWithWorkflow(fixture, {
      userId: otherUserId,
      agentName: "private-agent",
      workflowName: "hidden-workflow",
      visibility: "private",
    });

    await accept(
      triggersClient().create({
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
      triggersClient().create({
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
      triggersClient().create({
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

  it("makes a loop trigger due immediately when enabled", async () => {
    const { workflowId } = await setupFixture();

    const created = await accept(
      triggersClient().create({
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

  it("rejects Gmail event triggers before the feature is enabled", async () => {
    const { workflowId } = await setupFixture();

    const rejected = await accept(
      triggersClient().create({
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
      "Gmail workflow event triggers are not enabled",
    );
  });

  it("rejects Google Calendar event triggers before the feature is enabled", async () => {
    const { workflowId } = await setupFixture();

    const rejected = await accept(
      triggersClient().create({
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
      "Google Calendar workflow event triggers are not enabled",
    );
  });

  it("rejects webhook event triggers before the feature is enabled", async () => {
    const { workflowId } = await setupFixture();

    const rejected = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Workflow webhook triggers are not enabled",
    );
  });

  it("lists owned workflow triggers across visible workflows", async () => {
    const { fixture, agentId, workflowId } = await setupFixture();
    const { agentId: secondAgentId, workflowId: secondWorkflowId } =
      await seedAgentWithWorkflow(fixture, {
        agentName: "second-trigger-agent",
      });

    const first = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 60 } },
      }),
      [201],
    );
    const second = await accept(
      triggersClient().create({
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
      triggersClient().listWorkspace({ headers: authHeaders() }),
      [200],
    );

    expect(
      listed.body.map((entry) => {
        return {
          triggerId: entry.trigger.id,
          workflowId: entry.workflow.id,
          workflowName: entry.workflow.name,
          agentId: entry.workflow.agentId,
        };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        {
          triggerId: first.body.id,
          workflowId,
          workflowName: WORKFLOW_NAME,
          agentId,
        },
        {
          triggerId: second.body.id,
          workflowId: secondWorkflowId,
          workflowName: WORKFLOW_NAME,
          agentId: secondAgentId,
        },
      ]),
    );
    expect("files" in listed.body[0]!.workflow).toBeFalsy();
    expect("fileContents" in listed.body[0]!.workflow).toBeFalsy();
  });

  it("creates webhook event triggers with a signed endpoint secret shown once", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableWebhookWorkflowTriggers(fixture);

    const created = await accept(
      triggersClient().create({
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
      throw new Error("Expected a webhook trigger");
    }
    expect(created.body.webhookUrl).toContain(
      "/api/webhooks/workflow-triggers/whk_",
    );
    expect(created.body.webhookSecret).toBeTruthy();
    expect(created.body.secretLastFour).toBe(
      created.body.webhookSecret?.slice(-4),
    );

    const listed = await accept(
      triggersClient().list({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    const listedWebhook = listed.body.find((trigger) => {
      return trigger.id === created.body.id;
    });
    if (
      !listedWebhook ||
      listedWebhook.kind !== "event" ||
      listedWebhook.eventType !== "webhook-received"
    ) {
      throw new Error("Expected created webhook trigger to be listed");
    }
    expect(listedWebhook.webhookUrl).toBe(created.body.webhookUrl);
    expect(listedWebhook.secretLastFour).toBe(created.body.secretLastFour);
    expect(listedWebhook.webhookSecret).toBeUndefined();
  });

  it("requires a connected Gmail account for Gmail event triggers", async () => {
    const { fixture, workflowId } = await setupFixture();
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    await enableGmailWorkflowTriggers(fixture);

    const rejected = await accept(
      triggersClient().create({
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
      "Connect Gmail before adding a Gmail event trigger",
    );
  });

  it("requires a connected Google Calendar account for Google Calendar event triggers", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableGoogleCalendarWorkflowTriggers(fixture);

    const rejected = await accept(
      triggersClient().create({
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
      "Connect Google Calendar before adding a Google Calendar event trigger",
    );
  });

  it("rejects removed Gmail event trigger match fields", async () => {
    const { workflowId } = await setupFixture();

    const response = await createApp({ signal: context.signal }).request(
      `/api/zero/workflows/${workflowId}/triggers`,
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

  it("creates Gmail event triggers with a watch and agent connector grant", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableGmailWorkflowTriggers(fixture);
    const connectorId = await seedGmailConnector(fixture);
    configureGmailWatchMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
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
    const watchState = await workflowTriggerStateAction({
      action: "get-gmail-watch",
      connector_id: connectorId,
    });
    const watches = watchState.watches as readonly Record<string, unknown>[];
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      orgId: fixture.orgId,
      userId: fixture.userId,
      emailAddress: GMAIL_EMAIL,
      topicName: GMAIL_TOPIC_NAME,
      lastHistoryId: "100",
      needsRewatch: false,
    });

    const updated = await accept(
      triggersClient().update({
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
      throw new Error("Expected a Gmail event trigger");
    }
    expect(updated.body.eventConfig.match).toStrictEqual({
      from: { contains: "billing@example.com" },
    });
  });

  it("creates Google Calendar event-created triggers with a watch and baseline", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableGoogleCalendarWorkflowTriggers(fixture);
    const connectorId = await seedGoogleCalendarConnector(fixture);
    configureGoogleCalendarWatchMock({
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

    const watchState = await workflowTriggerStateAction({
      action: "get-google-calendar-watch",
      connector_id: connectorId,
    });
    const watches = watchState.watches as readonly Record<string, unknown>[];
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      orgId: fixture.orgId,
      userId: fixture.userId,
      calendarId: "primary",
      resourceId: "calendar-resource-1",
      syncToken: "calendar-sync-baseline",
      needsRewatch: false,
    });

    const snapshots = watchState.snapshots as readonly Record<
      string,
      unknown
    >[];
    expect(snapshots).toStrictEqual([
      {
        watchStateId: watches[0]!.id,
        calendarEventId: "existing-event",
        summary: "Already on calendar",
      },
    ]);
  });

  it("creates and updates Gmail label applied triggers by label name", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableGmailWorkflowTriggers(fixture);
    await seedGmailConnector(fixture);
    configureGmailLabelsMock([{ id: "Label_support", name: "Support" }]);
    configureGmailWatchMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
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
      triggersClient().update({
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
      throw new Error("Expected a Gmail label applied trigger");
    }
    expect(updated.body.eventConfig).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelName: "Escalated",
      resolvedLabelId: "Label_escalated",
    });
  });

  it("creates and updates GitHub label applied triggers", async () => {
    const { fixture, agentId, workflowId } = await setupFixture();
    await enableGithubWorkflowTriggers(fixture);
    const installationId = await seedGithubInstallation({
      fixture,
      composeId: agentId,
    });
    await seedGithubUserLink({
      installationId,
      userId: fixture.userId,
      githubUserId: "101",
    });

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
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
      triggersClient().update({
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
      throw new Error("Expected a GitHub label applied trigger");
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

  it("rejects GitHub label applied triggers with actor me when GitHub user is not connected", async () => {
    const { fixture, agentId, workflowId } = await setupFixture();
    await enableGithubWorkflowTriggers(fixture);
    await seedGithubInstallation({
      fixture,
      composeId: agentId,
    });

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
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
          "Connect your GitHub account before using Triggered by me for GitHub label workflow triggers",
      },
    });
  });

  it("returns created triggers from list and workflow detail", async () => {
    const { workflowId } = await setupFixture();

    await accept(
      triggersClient().create({
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
      triggersClient().list({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    const [listedTrigger] = listed.body;
    expect(listedTrigger?.kind).toBe("schedule");
    if (listedTrigger?.kind !== "schedule") {
      throw new Error("Expected a schedule trigger");
    }
    expect(listedTrigger.schedule.type).toBe("once");

    const detail = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { workflowId },
      }),
      [200],
    );
    expect(detail.body.triggers).toHaveLength(1);
  });

  it("updates the schedule of an existing trigger", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 600 },
        },
      }),
      [201],
    );

    const updated = await accept(
      triggersClient().update({
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

  it("schedules updated loop triggers from the last run interval", async () => {
    mockNow(Date.parse("2026-06-28T06:00:00.000Z"));
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 600 },
        },
      }),
      [201],
    );

    await workflowTriggerStateAction({
      action: "set-trigger-run-state",
      trigger_id: created.body.id,
      last_run_at: "2026-06-28T06:05:00.000Z",
      next_run_at: null,
    });

    mockNow(Date.parse("2026-06-28T06:10:00.000Z"));
    const updated = await accept(
      triggersClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [200],
    );

    expect(updated.body.nextRunAt).toBe("2026-06-28T07:05:00.000Z");
  });

  it("clears next run on disable and recomputes it on enable", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
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
      triggersClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    expect(disabled.body.nextRunAt).toBeNull();

    const enabled = await accept(
      triggersClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    expect(enabled.body.nextRunAt).toBeTruthy();
  });

  it("keeps enabled loop triggers scheduled from the last run interval", async () => {
    mockNow(Date.parse("2026-06-28T06:00:00.000Z"));
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 1800 },
        },
      }),
      [201],
    );

    await workflowTriggerStateAction({
      action: "set-trigger-run-state",
      trigger_id: created.body.id,
      last_run_at: "2026-06-28T06:05:00.000Z",
      next_run_at: null,
    });

    mockNow(Date.parse("2026-06-28T06:10:00.000Z"));
    const enabled = await accept(
      triggersClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    expect(enabled.body.enabled).toBeTruthy();
    expect(enabled.body.nextRunAt).toBe("2026-06-28T06:35:00.000Z");
  });

  it("treats a deleted workflow's trigger as not found on enable", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );

    await accept(
      triggersClient().disable({
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
      triggersClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [404],
    );
  });

  it("allows another org member to manage only their own triggers", async () => {
    const { fixture, workflowId } = await setupFixture();
    const ownerTrigger = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );

    // A different member of the same org can create their own trigger on the
    // public workflow + public agent, but cannot modify the owner's trigger.
    const otherUserId = `user_${randomUUID()}`;
    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");

    await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 7200 },
        },
      }),
      [201],
    );

    await accept(
      triggersClient().delete({
        headers: authHeaders(),
        params: { id: ownerTrigger.body.id },
      }),
      [403],
    );
  });

  it("keeps the bound chat thread when a trigger is deleted", async () => {
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
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

    await accept(
      triggersClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );

    const threadState = await workflowTriggerStateAction({
      action: "get-chat-thread",
      thread_id: threadId,
    });
    expect(threadState.thread).toStrictEqual({ id: threadId });
  });

  it("runs a trigger immediately in its bound chat thread", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const { workflowId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
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
      throw new Error("Expected trigger creation to bind a chat thread");
    }

    const run = await accept(
      triggersClient().run({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [201],
    );

    expect(run.body.chatThreadId).toBe(threadId);
    const runState = await workflowTriggerStateAction({
      action: "get-run-state",
      trigger_id: created.body.id,
      run_id: run.body.runId,
    });
    const zeroRun = (runState.runs as readonly Record<string, unknown>[])[0];
    expect(zeroRun).toMatchObject({
      id: run.body.runId,
      workflowTriggerId: created.body.id,
      triggerSource: "workflow-schedule",
    });
    expect(sandboxOperationEventsForRun(run.body.runId)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_agent_run",
          trigger_source: "workflow-schedule",
          zero_run_origin: "workflow_trigger",
        }),
      ]),
    );

    const triggerState = await workflowTriggerStateAction({
      action: "get-trigger",
      trigger_id: created.body.id,
    });
    const trigger = triggerState.trigger as Record<string, unknown> | null;
    expect(trigger?.lastRunId).toBe(run.body.runId);
    expect(typeof trigger?.lastRunAt).toBe("string");
    expect(trigger?.nextRunAt).toBe(created.body.nextRunAt);

    const threadState = await workflowTriggerStateAction({
      action: "get-chat-thread",
      thread_id: threadId,
    });
    const messages = threadState.messages as readonly Record<string, unknown>[];
    expect(messages).toContainEqual({
      role: "user",
      content: `/${WORKFLOW_NAME}`,
    });

    const callbacks = runState.callbacks as readonly Record<string, unknown>[];
    const callbackKinds = callbacks.map((callback) => {
      return callback.internalKind;
    });
    expect(callbackKinds).toStrictEqual(["chat"]);
  });
});
