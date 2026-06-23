import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { gmailWatchStates } from "@vm0/db/schema/gmail-event";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptStoredSecretValue } from "../../services/crypto.utils";
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

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

function detailClient() {
  return setupApp({ context })(zeroWorkflowsDetailContract);
}

const WORKFLOW_NAME = "trigger-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_EMAIL = "workflow-user@example.com";

function futureIso(offsetMs: number): string {
  return new Date(now() + offsetMs).toISOString();
}

async function loadWorkflowId(
  fixture: WorkflowsFixture,
  agentId: string,
): Promise<string> {
  const [row] = await store
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
  if (!row) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  return row.id;
}

async function seedAgentWithWorkflow(
  fixture: WorkflowsFixture,
): Promise<{ agentId: string; workflowId: string }> {
  const { agentId } = await store.set(
    seedAgentForInstructions$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "trigger-agent",
      workflowNames: [WORKFLOW_NAME],
    },
    context.signal,
  );
  const workflowId = await loadWorkflowId(fixture, agentId);
  return { agentId, workflowId };
}

async function enableGmailWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(userFeatureSwitches)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.WorkflowGmailEventTriggers]: true },
    });
}

async function seedGmailConnector(fixture: WorkflowsFixture): Promise<string> {
  const db = store.set(writeDb$);
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "gmail",
      authMethod: "oauth",
      externalEmail: GMAIL_EMAIL,
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      oauthScopes: JSON.stringify([
        "https://www.googleapis.com/auth/gmail.modify",
      ]),
    })
    .returning({ id: connectors.id });
  if (!connector) {
    throw new Error("Expected Gmail connector to be created");
  }

  await db.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "GMAIL_ACCESS_TOKEN",
    encryptedValue: await encryptStoredSecretValue("gmail-access-token"),
    type: "connector",
  });
  return connector.id;
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

describe("zero workflow triggers", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    const db = store.set(writeDb$);
    await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
    await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  async function setupFixture(): Promise<{
    fixture: WorkflowsFixture;
    agentId: string;
    workflowId: string;
  }> {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const { agentId, workflowId } = await seedAgentWithWorkflow(fixture);
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
    const { agentId: privateAgentId } = await store.set(
      seedAgentForInstructions$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        name: "private-agent",
        visibility: "private",
        workflowNames: ["hidden-workflow"],
      },
      context.signal,
    );
    const [hidden] = await store
      .set(writeDb$)
      .select({ id: zeroWorkflows.id })
      .from(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, fixture.orgId),
          eq(zeroWorkflows.agentId, privateAgentId),
          eq(zeroWorkflows.name, "hidden-workflow"),
        ),
      );
    if (!hidden) {
      throw new Error("Expected the private agent to own the hidden workflow");
    }

    await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId: hidden.id },
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

  it("creates Gmail event triggers with a watch and agent connector grant", async () => {
    const { fixture, agentId, workflowId } = await setupFixture();
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

    const db = store.set(writeDb$);
    const watches = await db
      .select()
      .from(gmailWatchStates)
      .where(eq(gmailWatchStates.connectorId, connectorId));
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      orgId: fixture.orgId,
      userId: fixture.userId,
      emailAddress: GMAIL_EMAIL,
      topicName: GMAIL_TOPIC_NAME,
      lastHistoryId: "100",
      needsRewatch: false,
    });

    const grants = await db
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, fixture.orgId),
          eq(userConnectors.userId, fixture.userId),
          eq(userConnectors.agentId, agentId),
        ),
      );
    expect(grants).toStrictEqual([{ connectorType: "gmail" }]);

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
    if (updated.body.kind !== "event") {
      throw new Error("Expected a Gmail event trigger");
    }
    expect(updated.body.eventConfig.match).toStrictEqual({
      from: { contains: "billing@example.com" },
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

  it("treats a deleted workflow's trigger as not found on enable", async () => {
    const { fixture, agentId, workflowId } = await setupFixture();
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

    // Removing the workflow (cascade-deletes its triggers) leaves nothing to
    // enable; the trigger is reported as not found.
    await store
      .set(writeDb$)
      .delete(zeroWorkflows)
      .where(
        and(
          eq(zeroWorkflows.orgId, fixture.orgId),
          eq(zeroWorkflows.agentId, agentId),
          eq(zeroWorkflows.id, workflowId),
        ),
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

    const threads = await store
      .set(writeDb$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId!));
    expect(threads).toHaveLength(1);
  });
});
