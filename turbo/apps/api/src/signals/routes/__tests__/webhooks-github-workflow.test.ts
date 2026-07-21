import { createHmac, randomUUID } from "node:crypto";

import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroWorkflowQueueContract } from "@vm0/api-contracts/contracts/zero-workflow-queue";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const gh = createGithubBddApi(context);
const runsApi = createRunsApi(context);

const WORKFLOW_NAME = "github-webhook-workflow";
const GITHUB_WEBHOOK_SECRET = "github-webhook-secret";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function queueClient() {
  return setupApp({ context })(zeroWorkflowQueueContract);
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
}> {
  const { actor } = await wf.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "GitHub Webhook Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  const fixture = { orgId: actor.orgId, userId: actor.userId };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  context.mocks.s3.send.mockResolvedValue({});
  return { fixture, actor, agentId: agent.agentId, workflowId };
}

function githubPayload(
  action: "labeled" | "opened",
  installationId: string,
): string {
  return JSON.stringify({
    action,
    issue: {
      number: 42,
      title: "Needs triage",
      body: null,
      labels: [{ id: 1001, name: "triage" }],
      user: { id: 202, login: "issue-author", type: "User" },
    },
    ...(action === "labeled" ? { label: { id: 1001, name: "triage" } } : {}),
    repository: { full_name: "vm0-ai/vm0" },
    installation: { id: Number(installationId) },
    sender: { id: 101, login: "lancy", type: "User" },
  });
}

async function postGithubWebhook(args: {
  readonly event: "issues" | "pull_request";
  readonly deliveryId: string;
  readonly rawBody: string;
}): Promise<{ readonly status: number; readonly text: string }> {
  const signature = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(args.rawBody)
    .digest("hex")}`;
  const response = await createApp({ signal: context.signal }).request(
    "/api/webhooks/github",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": args.event,
        "x-github-delivery": args.deliveryId,
        "x-hub-signature-256": signature,
      },
      body: args.rawBody,
    },
  );
  return {
    status: response.status,
    text: await response.text(),
  };
}

describe("POST /api/webhooks/github for workflow automations", () => {
  it("dispatches matching label events and de-duplicates deliveries", async () => {
    const { fixture, actor, agentId, workflowId } = await setupFixture();
    const runnerGroup = runsApi.configureRunnerGroup();
    const installed = await gh.installGithubApp(actor, agentId, {
      oauthCode: {
        code: `gh-workflow-${randomUUID().slice(0, 8)}`,
        githubUserId: "101",
      },
    });
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-label-applied",
          eventConfig: {
            provider: "github",
            event: "label_applied",
            labelName: "TriAge",
            filters: {
              subject: "both",
              actor: { type: "me" },
            },
          },
        },
      }),
      [201],
    );
    const createdSecond = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-label-applied",
          eventConfig: {
            provider: "github",
            event: "label_applied",
            labelName: "TriAge",
            filters: {
              subject: "both",
              actor: { type: "me" },
            },
          },
        },
      }),
      [201],
    );

    const labeledDeliveryId = `delivery-${randomUUID()}`;
    const openedDeliveryId = `delivery-${randomUUID()}`;
    const labeled = await postGithubWebhook({
      event: "issues",
      deliveryId: labeledDeliveryId,
      rawBody: githubPayload("labeled", installed.remoteInstallationId),
    });
    expect(labeled).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    const duplicate = await postGithubWebhook({
      event: "issues",
      deliveryId: labeledDeliveryId,
      rawBody: githubPayload("labeled", installed.remoteInstallationId),
    });
    expect(duplicate).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    const opened = await postGithubWebhook({
      event: "issues",
      deliveryId: openedDeliveryId,
      rawBody: githubPayload("opened", installed.remoteInstallationId),
    });
    expect(opened).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();
    await flushWaitUntilForTest();

    // Two deliveries matched two automations each; the duplicate redelivery
    // was recorded as processed and added nothing. Under the per-thread
    // workflow queue, the first matched event creates the only admitted run
    // and the remaining three wait as pending workflow queue events.
    await runsApi.heartbeatRunner(runnerGroup);
    const polled = await runsApi.pollRunner(runnerGroup);
    const admittedRunId = polled.body.job?.runId;
    if (!admittedRunId) {
      throw new Error("Expected an admitted workflow event run");
    }
    await runsApi.claimRunnerJob(admittedRunId);
    const idle = await runsApi.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();

    const queueState = await runsApi.readRunQueue(actor);
    expect(queueState.body.queue).toHaveLength(0);

    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    const queue = await accept(
      queueClient().get({
        headers: authHeaders(),
        params: { threadId: created.body.chatThreadId },
      }),
      [200],
    );
    expect(queue.body.pending).toHaveLength(3);

    for (const runId of [admittedRunId]) {
      const timingEvents = sandboxOperationEventsForRun(runId);
      const actionTypes = new Set(
        timingEvents.map((event) => {
          return event.op_type;
        }),
      );
      for (const actionType of [
        "api_dispatch_pre_create_zero_workflow_automation_entrypoint_gap",
        "api_dispatch_pre_create_zero_workflow_automation_queue_admission",
        "api_dispatch_pre_create_zero_workflow_event_background_start_gap",
        "api_dispatch_pre_create_zero_workflow_event_load_source_state",
        "api_dispatch_pre_create_zero_workflow_event_load_automations",
        "api_dispatch_pre_create_zero_workflow_event_match_automations",
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
            workflow_event_source: "github",
            trigger_source: "workflow-event",
            zero_run_origin: "workflow_automation",
            span_kind: "nested",
          }),
        ]),
      );
      const serializedTiming = JSON.stringify(timingEvents);
      expect(serializedTiming).not.toContain(labeledDeliveryId);
      expect(serializedTiming).not.toContain("vm0-ai/vm0");
      expect(serializedTiming).not.toContain("Needs triage");
      expect(serializedTiming).not.toContain("lancy");
      expect(serializedTiming).not.toContain("triage");
      expect(serializedTiming).not.toContain(created.body.id);
      expect(serializedTiming).not.toContain(createdSecond.body.id);
      expect(serializedTiming).not.toContain(WORKFLOW_NAME);
      expect(serializedTiming).not.toContain(fixture.orgId);
      expect(serializedTiming).not.toContain(fixture.userId);
    }
  });
});
