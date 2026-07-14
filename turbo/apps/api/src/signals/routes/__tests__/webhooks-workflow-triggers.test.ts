import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);

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

interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly subscriptionId: string;
}> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const { actor, subscriptionId } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Webhook Trigger Agent",
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
    subscriptionId,
  };
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
  it("dispatches signed webhook deliveries and de-duplicates retries", async () => {
    const { workflowId } = await setupFixture();
    const runsApi = createRunsApi(context);
    const runnerGroup = runsApi.configureRunnerGroup();

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
      !created.body.webhookUrl ||
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

    await runsApi.heartbeatRunner(runnerGroup);
    const workflowClaim = await runsApi.claimRunnerJob(first.body.runId);
    const workflowPrompt = workflowClaim.appendSystemPrompt ?? "";
    expect(workflowPrompt).toContain("zero slack message send --help");
    expect(workflowPrompt).not.toContain(
      "normal replies are automatically sent to the originating thread",
    );
    expect(workflowPrompt).not.toContain("Never use SLACK_TOKEN directly");

    const timingEvents = sandboxOperationEventsForRun(first.body.runId);
    const actionTypes = new Set(
      timingEvents.map((event) => {
        return event.op_type;
      }),
    );
    for (const actionType of [
      "api_dispatch_pre_create_zero_workflow_trigger_entrypoint_gap",
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
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
    // The duplicate retry does not enqueue a second runner job.
    const idleAfterDuplicate = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterDuplicate.body.job).toBeNull();
  });

  it("rejects invalid signatures", async () => {
    const { workflowId } = await setupFixture();

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
      !created.body.webhookUrl
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

  it("auto-disables only enabled webhooks after an effective Stripe downgrade", async () => {
    const { fixture, workflowId, subscriptionId } = await setupFixture();
    const enabled = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      enabled.body.kind !== "event" ||
      enabled.body.eventType !== "webhook-received" ||
      !enabled.body.webhookUrl ||
      !enabled.body.webhookSecret
    ) {
      throw new Error("Expected a webhook trigger with credentials");
    }
    const manuallyDisabled = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    await accept(
      triggersClient().disable({
        headers: authHeaders(),
        params: { id: manuallyDisabled.body.id },
        body: undefined,
      }),
      [200],
    );

    const stripeApi = createWebhookCallbackApi(context);
    await stripeApi.postStripeEvent(
      {
        id: `evt_webhook_downgrade_${fixture.orgId}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId } },
      },
      [200],
    );

    const enabledAfter = await wf.readTrigger(enabled.body.id);
    expect(enabledAfter).toMatchObject({
      enabled: false,
      disabledReason: "paid_plan_required",
    });
    const manualAfter = await wf.readTrigger(manuallyDisabled.body.id);
    expect(manualAfter.enabled).toBeFalsy();
    if (
      manualAfter.kind !== "event" ||
      manualAfter.eventType !== "webhook-received"
    ) {
      throw new Error("Expected a webhook trigger");
    }
    expect(manualAfter.disabledReason).toBeNull();
    const token = new URL(enabled.body.webhookUrl).pathname.split("/").at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }
    const response = await postWorkflowWebhook({
      token,
      rawBody: JSON.stringify({ event: "after-downgrade" }),
      secret: enabled.body.webhookSecret,
    });
    expect(response.status).toBe(404);
  });

  it("keeps webhooks enabled through a scheduled cancellation period", async () => {
    const { fixture, workflowId, subscriptionId } = await setupFixture();
    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const stripeApi = createWebhookCallbackApi(context);
    await stripeApi.postStripeEvent(
      {
        id: `evt_webhook_cancel_scheduled_${fixture.orgId}`,
        type: "customer.subscription.updated",
        data: {
          object: {
            id: subscriptionId,
            status: "active",
            cancel_at_period_end: true,
            items: {
              data: [
                {
                  price: { id: "price_bdd_pro" },
                  current_period_end: Math.floor(now() / 1000) + 86_400,
                },
              ],
            },
          },
          previous_attributes: { cancel_at_period_end: false },
        },
      },
      [200],
    );

    const after = await wf.readTrigger(created.body.id);
    expect(after.enabled).toBeTruthy();
    if (after.kind !== "event" || after.eventType !== "webhook-received") {
      throw new Error("Expected a webhook trigger");
    }
    expect(after.disabledReason).toBeNull();
  });

  it("starts an event run when the trigger's previous run is still active", async () => {
    const { workflowId } = await setupFixture();

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
      !created.body.webhookUrl ||
      !created.body.webhookSecret
    ) {
      throw new Error("Expected a webhook trigger with a one-time secret");
    }

    const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }

    // The first delivery starts a run that stays active (nothing claims or
    // completes it).
    const first = await postWorkflowWebhook({
      token,
      rawBody: JSON.stringify({ event: "active-run" }),
      secret: created.body.webhookSecret,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      duplicate: false,
      runId: expect.any(String),
    });
    const firstRunId = isRecord(first.body) ? first.body.runId : null;

    // A second, distinct delivery still starts a new event run even though
    // the previous run is active.
    const second = await postWorkflowWebhook({
      token,
      rawBody: JSON.stringify({ event: "active-run-second" }),
      secret: created.body.webhookSecret,
    });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      success: true,
      duplicate: false,
      runId: expect.any(String),
    });
    expect(isRecord(second.body) ? second.body.runId : null).not.toBe(
      firstRunId,
    );

    const trigger = await wf.readTrigger(created.body.id);
    expect(typeof trigger.lastRunAt).toBe("string");
  });
});
