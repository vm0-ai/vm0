import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  setWorkflowWebhookRunStarterForTests,
  sha256Hex,
  type WorkflowWebhookRunStartTestInput,
} from "../../services/workflow-webhook-trigger.service";
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
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const WORKFLOW_NAME = "webhook-trigger-workflow";
const RUN_ID = "00000000-0000-4000-a000-000000000123";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
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
      name: "webhook-trigger-agent",
      workflowNames: [WORKFLOW_NAME],
      composeContent: {
        version: "1",
        agents: {
          "webhook-trigger-agent": {
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
  return { fixture, agentId, workflowId: workflow.id };
}

async function markTriggerWithActiveRun(args: {
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
  readonly triggerId: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: args.fixture.userId,
      orgId: args.fixture.orgId,
      agentComposeId: args.agentId,
    })
    .returning({ id: agentSessions.id });
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: args.fixture.userId,
      orgId: args.fixture.orgId,
      sessionId: session!.id,
      status: "running",
      prompt: "active event run",
    })
    .returning({ id: agentRuns.id });

  await db
    .update(zeroWorkflowTriggers)
    .set({ lastRunId: run!.id })
    .where(eq(zeroWorkflowTriggers.id, args.triggerId));

  return run!.id;
}

async function enableWebhookWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowWebhookTriggers]: true,
  });
}

async function postWorkflowWebhook(args: {
  readonly token: string;
  readonly rawBody: string;
  readonly secret: string;
  readonly timestamp?: number;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const timestamp = args.timestamp ?? Math.floor(now() / 1000);
  const response = await createApp({ signal: context.signal }).request(
    `/api/webhooks/workflow-triggers/${args.token}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VM0-Timestamp": String(timestamp),
        "X-VM0-Signature": computeHmacSignature(
          args.rawBody,
          args.secret,
          timestamp,
        ),
      },
      body: args.rawBody,
    },
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe("POST /api/webhooks/workflow-triggers/:token", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("dispatches signed webhook deliveries and de-duplicates retries", async () => {
    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableWebhookWorkflowTriggers(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "webhook-received" ||
      !created.body.webhookSecret
    ) {
      throw new Error("Expected a webhook trigger with a one-time secret");
    }

    const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }

    const runCalls: WorkflowWebhookRunStartTestInput[] = [];
    const restoreRunStarter = setWorkflowWebhookRunStarterForTests((input) => {
      runCalls.push(input);
      return Promise.resolve({ kind: "ok", runId: RUN_ID });
    });
    onTestFinished(() => {
      restoreRunStarter();
    });

    const rawBody = JSON.stringify({ event: "ping", value: 42 });
    const timestamp = Math.floor(now() / 1000);
    const first = await postWorkflowWebhook({
      token,
      rawBody,
      secret: created.body.webhookSecret,
      timestamp,
    });

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      duplicate: false,
      runId: RUN_ID,
    });
    expect(runCalls).toStrictEqual([
      {
        triggerId: created.body.id,
        workflowName: WORKFLOW_NAME,
        deliveryKey: expect.any(String),
        bodySha256: sha256Hex(rawBody),
        contentType: "application/json",
      },
    ]);

    const second = await postWorkflowWebhook({
      token,
      rawBody,
      secret: created.body.webhookSecret,
      timestamp,
    });

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      duplicate: true,
    });
    expect(runCalls).toHaveLength(1);
  });

  it("rejects invalid signatures", async () => {
    const { fixture, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableWebhookWorkflowTriggers(fixture);

    const created = await accept(
      triggersClient().create({
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
      throw new Error("Expected a webhook trigger");
    }

    const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }

    const response = await createApp({ signal: context.signal }).request(
      `/api/webhooks/workflow-triggers/${token}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Timestamp": String(Math.floor(now() / 1000)),
          "X-VM0-Signature": "not-valid",
        },
        body: JSON.stringify({ event: "ping" }),
      },
    );

    expect(response.status).toBe(401);
  });

  it("starts an event run when the trigger's previous run is still active", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const { fixture, agentId, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableWebhookWorkflowTriggers(fixture);

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "webhook-received" ||
      !created.body.webhookSecret
    ) {
      throw new Error("Expected a webhook trigger with a one-time secret");
    }

    const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }
    const activeRunId = await markTriggerWithActiveRun({
      fixture,
      agentId,
      triggerId: created.body.id,
    });

    const response = await postWorkflowWebhook({
      token,
      rawBody: JSON.stringify({ event: "active-run" }),
      secret: created.body.webhookSecret,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      duplicate: false,
      runId: expect.any(String),
    });

    const db = store.set(writeDb$);
    const runs = await db
      .select({ id: zeroRuns.id, triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.workflowTriggerId, created.body.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("workflow-event");

    const [trigger] = await db
      .select({
        lastRunId: zeroWorkflowTriggers.lastRunId,
        lastRunAt: zeroWorkflowTriggers.lastRunAt,
      })
      .from(zeroWorkflowTriggers)
      .where(eq(zeroWorkflowTriggers.id, created.body.id));
    expect(trigger?.lastRunId).toBe(activeRunId);
    expect(trigger?.lastRunAt).toBeInstanceOf(Date);
  });
});
