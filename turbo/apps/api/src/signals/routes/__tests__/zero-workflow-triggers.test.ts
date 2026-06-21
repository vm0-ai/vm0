import { randomUUID } from "node:crypto";

import {
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
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

describe("zero workflow triggers", () => {
  const track = createFixtureTracker<WorkflowsFixture>((fixture) => {
    return store.set(deleteWorkflowsForFixture$, fixture, context.signal);
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
    expect(created.body.scheduleSummary.length).toBeGreaterThan(0);
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
    expect(listed.body[0]?.schedule.type).toBe("once");

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
