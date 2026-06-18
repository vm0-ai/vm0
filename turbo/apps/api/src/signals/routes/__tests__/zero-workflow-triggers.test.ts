import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroWorkflowAgents } from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
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

function futureIso(offsetMs: number): string {
  return new Date(now() + offsetMs).toISOString();
}

async function seedAttachedAgent(fixture: WorkflowsFixture): Promise<string> {
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
  return agentId;
}

describe("zero workflow triggers", () => {
  const track = createFixtureTracker<WorkflowsFixture>((fixture) => {
    return store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  async function setupFixture(): Promise<{
    fixture: WorkflowsFixture;
    agentId: string;
  }> {
    const fixture = await track(
      store.set(seedWorkflowsFixture$, undefined, context.signal),
    );
    const agentId = await seedAttachedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    return { fixture, agentId };
  }

  it("creates a cron trigger and eagerly binds a chat thread", async () => {
    const { agentId } = await setupFixture();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
      agentId,
      enabled: true,
      schedule: {
        type: "cron",
        cronExpression: "0 9 * * 1-5",
        timezone: "UTC",
      },
    });
    expect(created.body.chatThreadId).toBeTruthy();
    expect(created.body.nextRunAt).toBeTruthy();
    expect(created.body.scheduleSummary.length).toBeGreaterThan(0);
  });

  it("rejects creation when the agent is not attached to the workflow", async () => {
    const { fixture } = await setupFixture();
    const { agentId: unattachedAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId, name: "other-agent" },
      context.signal,
    );

    await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId: unattachedAgentId,
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
  });

  it("rejects an invalid cron expression and a past one-time schedule", async () => {
    const { agentId } = await setupFixture();

    await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
    const { agentId } = await setupFixture();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: { agentId, schedule: { type: "loop", intervalSeconds: 1800 } },
      }),
      [201],
    );

    expect(created.body.schedule).toStrictEqual({
      type: "loop",
      intervalSeconds: 1800,
    });
    expect(created.body.nextRunAt).toBeTruthy();
  });

  it("returns created triggers from list and workflow detail", async () => {
    const { agentId } = await setupFixture();

    await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
        params: { name: WORKFLOW_NAME },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.schedule.type).toBe("once");

    const detail = await accept(
      detailClient().get({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
      }),
      [200],
    );
    expect(detail.body.triggers).toHaveLength(1);
  });

  it("updates the schedule of an existing trigger", async () => {
    const { agentId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
    const { agentId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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

  it("blocks enable when the agent is no longer attached", async () => {
    const { fixture, agentId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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

    // Simulate the workflow being detached from the agent.
    await store
      .set(writeDb$)
      .delete(zeroWorkflowAgents)
      .where(
        and(
          eq(zeroWorkflowAgents.orgId, fixture.orgId),
          eq(zeroWorkflowAgents.agentId, agentId),
        ),
      );

    await accept(
      triggersClient().enable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [409],
    );
  });

  it("allows another org member to manage only their own triggers", async () => {
    const { fixture, agentId } = await setupFixture();
    const ownerTrigger = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
    const { agentId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { name: WORKFLOW_NAME },
        body: {
          agentId,
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
