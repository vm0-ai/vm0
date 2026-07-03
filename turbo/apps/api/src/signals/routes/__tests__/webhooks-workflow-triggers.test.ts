import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  deleteWorkflowsForFixture$,
  getWorkflowTriggerRunState$,
  getWorkflowTriggerState$,
  seedAgentForInstructions$,
  seedWorkflowActiveRun$,
  seedWorkflowsFixture$,
  setWorkflowTriggerRunState$,
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

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
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

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
  readonly workflowId: string;
}> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
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
  const workflowId = seededAgent.workflowIdsByName[WORKFLOW_NAME];
  if (!workflowId) {
    throw new Error("Expected the agent to own the seeded workflow");
  }
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  return { fixture, agentId: seededAgent.agentId, workflowId };
}

async function markTriggerWithActiveRun(args: {
  readonly fixture: WorkflowsFixture;
  readonly agentId: string;
  readonly triggerId: string;
}): Promise<string> {
  const runId = await store.set(
    seedWorkflowActiveRun$,
    { fixture: args.fixture, agentId: args.agentId },
    context.signal,
  );
  await store.set(
    setWorkflowTriggerRunState$,
    { triggerId: args.triggerId, lastRunId: runId },
    context.signal,
  );
  return runId;
}

async function enableWebhookWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.WorkflowAutomation]: true,
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

    const rawBody = JSON.stringify({
      event: "vm0-timing-sensitive-ping",
      value: "vm0-timing-secret-value",
    });
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
      runId: expect.any(String),
    });
    if (
      typeof first.body !== "object" ||
      first.body === null ||
      !("runId" in first.body) ||
      typeof first.body.runId !== "string"
    ) {
      throw new Error("Expected webhook dispatch response to include runId");
    }

    const runsAfterFirst = await store.set(
      getWorkflowTriggerRunState$,
      { triggerId: created.body.id },
      context.signal,
    );
    expect(runsAfterFirst).toStrictEqual([
      { id: first.body.runId, triggerSource: "workflow-event" },
    ]);
    const timingEvents = sandboxOperationEventsForRun(first.body.runId);
    const actionTypes = new Set(
      timingEvents.map((event) => {
        return event.op_type;
      }),
    );
    for (const actionType of [
      "api_dispatch_pre_create_zero_workflow_trigger_entrypoint_gap",
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
      "api_dispatch_pre_create_zero_workflow_event_check_feature_gate",
      "api_dispatch_pre_create_zero_workflow_event_match_triggers",
      "api_dispatch_pre_create_zero_workflow_event_record_processed_event",
      "api_dispatch_pre_create_zero_workflow_event_build_run_input",
      "api_dispatch_pre_create_zero_workflow_event_handoff_run",
    ]) {
      expect(actionTypes).toContain(actionType);
    }
    expect(timingEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_zero_workflow_event_handoff_run",
          workflow_event_source: "webhook",
          trigger_source: "workflow-event",
          zero_run_origin: "workflow_trigger",
          span_kind: "nested",
        }),
      ]),
    );
    const serializedTiming = JSON.stringify(timingEvents);
    expect(serializedTiming).not.toContain("vm0-timing-sensitive-ping");
    expect(serializedTiming).not.toContain("vm0-timing-secret-value");
    expect(serializedTiming).not.toContain(created.body.id);
    expect(serializedTiming).not.toContain(WORKFLOW_NAME);
    expect(serializedTiming).not.toContain(token);
    expect(serializedTiming).not.toContain(created.body.webhookSecret);

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
    const runsAfterDuplicate = await store.set(
      getWorkflowTriggerRunState$,
      { triggerId: created.body.id },
      context.signal,
    );
    expect(runsAfterDuplicate).toHaveLength(1);
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

    const runs = await store.set(
      getWorkflowTriggerRunState$,
      { triggerId: created.body.id },
      context.signal,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe("workflow-event");

    const trigger = await store.set(
      getWorkflowTriggerState$,
      { triggerId: created.body.id },
      context.signal,
    );
    expect(trigger?.lastRunId).toBe(activeRunId);
    expect(trigger?.lastRunAt).toStrictEqual(expect.any(String));
  });
});
