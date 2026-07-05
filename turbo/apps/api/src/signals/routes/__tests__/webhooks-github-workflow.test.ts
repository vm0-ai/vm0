import { createHmac } from "node:crypto";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  deleteWorkflowsForFixture$,
  getWorkflowGithubProcessedEvents$,
  getWorkflowTriggerRunState$,
  seedAgentForInstructions$,
  seedWorkflowGithubInstallation$,
  seedWorkflowGithubUserLink$,
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

const WORKFLOW_NAME = "github-webhook-workflow";
const GITHUB_WEBHOOK_SECRET = "github-webhook-secret";
const GITHUB_INSTALLATION_REMOTE_ID = "123456";

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

async function enableGithubWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {});
}

async function seedGithubInstallation(args: {
  readonly fixture: WorkflowsFixture;
  readonly composeId: string;
}): Promise<string> {
  return await store.set(
    seedWorkflowGithubInstallation$,
    {
      fixture: args.fixture,
      composeId: args.composeId,
      installationId: GITHUB_INSTALLATION_REMOTE_ID,
    },
    context.signal,
  );
}

async function seedGithubUserLink(args: {
  readonly installationId: string;
  readonly userId: string;
}): Promise<void> {
  await store.set(
    seedWorkflowGithubUserLink$,
    {
      installationId: args.installationId,
      userId: args.userId,
      githubUserId: "101",
    },
    context.signal,
  );
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
      name: "github-webhook-agent",
      workflowNames: [WORKFLOW_NAME],
      composeContent: {
        version: "1",
        agents: {
          "github-webhook-agent": {
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

function githubPayload(action: "labeled" | "opened"): string {
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
    installation: { id: Number(GITHUB_INSTALLATION_REMOTE_ID) },
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

describe("POST /api/webhooks/github for workflow triggers", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await store.set(deleteWorkflowsForFixture$, fixture, context.signal);
  });

  it("dispatches matching label events and de-duplicates deliveries", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);
    const { fixture, agentId, workflowId } = await setupFixture();
    await track(Promise.resolve(fixture));
    await enableGithubWorkflowTriggers(fixture);
    const installationId = await seedGithubInstallation({
      fixture,
      composeId: agentId,
    });
    await seedGithubUserLink({ installationId, userId: fixture.userId });

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
      triggersClient().create({
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

    const labeled = await postGithubWebhook({
      event: "issues",
      deliveryId: "delivery-1",
      rawBody: githubPayload("labeled"),
    });
    expect(labeled).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    const duplicate = await postGithubWebhook({
      event: "issues",
      deliveryId: "delivery-1",
      rawBody: githubPayload("labeled"),
    });
    expect(duplicate).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();

    const opened = await postGithubWebhook({
      event: "issues",
      deliveryId: "delivery-2",
      rawBody: githubPayload("opened"),
    });
    expect(opened).toStrictEqual({ status: 200, text: "OK" });
    await flushWaitUntilForTest();
    await flushWaitUntilForTest();

    const runs = await store.set(
      getWorkflowTriggerRunState$,
      { triggerId: created.body.id },
      context.signal,
    );
    expect(runs).toHaveLength(2);
    expect(
      runs.map((run) => {
        return run.triggerSource;
      }),
    ).toStrictEqual(["workflow-event", "workflow-event"]);
    const secondRuns = await store.set(
      getWorkflowTriggerRunState$,
      { triggerId: createdSecond.body.id },
      context.signal,
    );
    expect(secondRuns).toHaveLength(2);
    expect(
      secondRuns.map((run) => {
        return run.triggerSource;
      }),
    ).toStrictEqual(["workflow-event", "workflow-event"]);

    const allRunIds = [...runs, ...secondRuns].map((run) => {
      return run.id;
    });
    expect(new Set(allRunIds).size).toBe(4);
    for (const runId of allRunIds) {
      const timingEvents = sandboxOperationEventsForRun(runId);
      const actionTypes = new Set(
        timingEvents.map((event) => {
          return event.op_type;
        }),
      );
      for (const actionType of [
        "api_dispatch_pre_create_zero_workflow_trigger_entrypoint_gap",
        "api_dispatch_pre_create_zero_workflow_event_background_start_gap",
        "api_dispatch_pre_create_zero_workflow_event_load_source_state",
        "api_dispatch_pre_create_zero_workflow_event_load_triggers",
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
            workflow_event_source: "github",
            trigger_source: "workflow-event",
            zero_run_origin: "workflow_trigger",
            span_kind: "nested",
          }),
        ]),
      );
      const serializedTiming = JSON.stringify(timingEvents);
      expect(serializedTiming).not.toContain("delivery-1");
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

    const processed = await store.set(
      getWorkflowGithubProcessedEvents$,
      { triggerId: created.body.id },
      context.signal,
    );
    expect(processed).toStrictEqual([
      {
        githubDeliveryId: "delivery-1",
        action: "labeled",
        labelNameNormalized: "triage",
      },
      {
        githubDeliveryId: "delivery-2",
        action: "opened",
        labelNameNormalized: "triage",
      },
    ]);
    const secondProcessed = await store.set(
      getWorkflowGithubProcessedEvents$,
      { triggerId: createdSecond.body.id },
      context.signal,
    );
    expect(secondProcessed).toStrictEqual(processed);
  });
});
