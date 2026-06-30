import { createHash } from "node:crypto";

import { networkPoliciesSchema } from "@vm0/connectors/firewall-types";
import type {
  TestWorkflowTriggerStateActionBody,
  TestWorkflowTriggerStateActionResponse,
} from "@vm0/api-contracts/contracts/test-workflow-trigger-state";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const runsApi = createRunsAutomationsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const WORKFLOW_NAME = "scheduler-workflow";
const TEST_WORKFLOW_STATE_ACTION_ROUTE =
  "/api/test/workflow-trigger-state/action";
const CRON_EXECUTE_WORKFLOW_TRIGGERS_ROUTE =
  "/api/cron/execute-workflow-triggers";
const CRON_SECRET = "test-cron-secret";

afterEach(() => {
  clearMockedEnv();
});

interface WorkflowFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly workflowName: string;
}

interface Scenario {
  readonly fixture: WorkflowFixture;
  readonly agentId: string;
  readonly workflowId: string;
}

const track = createFixtureTracker<WorkflowFixture>((fixture) => {
  return deleteWorkflowFixture(fixture);
});

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postWorkflowStateAction(
  body: TestWorkflowTriggerStateActionBody,
): Promise<TestWorkflowTriggerStateActionResponse> {
  const response = await createApp({ signal: context.signal }).request(
    TEST_WORKFLOW_STATE_ACTION_ROUTE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `workflow trigger state action ${body.action}`);
  return await readJson<TestWorkflowTriggerStateActionResponse>(response);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return record(value, label);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return field;
}

function optionalStringField(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function dateField(value: Record<string, unknown> | null, key: string): Date {
  const field = optionalStringField(value, key);
  if (!field) {
    throw new Error(`Expected ${key} to be a date string`);
  }
  return new Date(field);
}

function numberField(
  value: Record<string, unknown> | null,
  key: string,
): number {
  const field = value?.[key];
  if (typeof field !== "number") {
    throw new Error(`Expected ${key} to be a number`);
  }
  return field;
}

function booleanField(
  value: Record<string, unknown> | null,
  key: string,
): boolean {
  const field = value?.[key];
  if (typeof field !== "boolean") {
    throw new Error(`Expected ${key} to be a boolean`);
  }
  return field;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => {
    return typeof item === "object" && item !== null && !Array.isArray(item);
  });
}

async function deleteWorkflowFixture(fixture: WorkflowFixture): Promise<void> {
  await postWorkflowStateAction({
    action: "delete-scenario",
    org_id: fixture.orgId,
  });
}

async function setup(): Promise<Scenario> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("CRON_SECRET", CRON_SECRET);
  context.mocks.s3.send.mockResolvedValue({});
  const response = await postWorkflowStateAction({
    action: "seed-scenario",
    workflow_name: WORKFLOW_NAME,
    agent_name: "scheduler-agent",
  });
  const seeded = record(response.fixture, "seeded workflow fixture");
  const fixture: WorkflowFixture = {
    orgId: stringField(seeded, "org_id"),
    userId: stringField(seeded, "user_id"),
    agentId: stringField(seeded, "agent_id"),
    workflowId: stringField(seeded, "workflow_id"),
    workflowName: stringField(seeded, "workflow_name"),
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await track(Promise.resolve(fixture));
  return {
    fixture,
    agentId: fixture.agentId,
    workflowId: fixture.workflowId,
  };
}

async function seedTrigger(
  scenario: Scenario,
  opts: {
    readonly scheduleType: "cron" | "loop" | "once";
    readonly cronExpression?: string;
    readonly intervalSeconds?: number;
    readonly nextRunAt: Date | null;
    readonly enabled?: boolean;
    readonly consecutiveFailures?: number;
    readonly lastRunId?: string;
  },
): Promise<{ triggerId: string; threadId: string }> {
  const response = await postWorkflowStateAction({
    action: "seed-trigger",
    org_id: scenario.fixture.orgId,
    user_id: scenario.fixture.userId,
    agent_id: scenario.agentId,
    workflow_id: scenario.workflowId,
    schedule_type: opts.scheduleType,
    cron_expression: opts.cronExpression,
    interval_seconds: opts.intervalSeconds,
    next_run_at: opts.nextRunAt?.toISOString() ?? null,
    enabled: opts.enabled,
    consecutive_failures: opts.consecutiveFailures,
    last_run_id: opts.lastRunId,
    bind_thread: true,
  });
  if (
    typeof response.trigger_id !== "string" ||
    typeof response.thread_id !== "string"
  ) {
    throw new Error("Expected seeded trigger and thread ids");
  }
  return { triggerId: response.trigger_id, threadId: response.thread_id };
}

async function seedTriggerWithoutThread(
  scenario: Scenario,
  opts: {
    readonly scheduleType: "cron" | "loop" | "once";
    readonly cronExpression?: string;
    readonly intervalSeconds?: number;
    readonly nextRunAt: Date | null;
  },
): Promise<{ triggerId: string }> {
  const response = await postWorkflowStateAction({
    action: "seed-trigger",
    org_id: scenario.fixture.orgId,
    user_id: scenario.fixture.userId,
    agent_id: scenario.agentId,
    workflow_id: scenario.workflowId,
    schedule_type: opts.scheduleType,
    cron_expression: opts.cronExpression,
    interval_seconds: opts.intervalSeconds,
    next_run_at: opts.nextRunAt?.toISOString() ?? null,
    bind_thread: false,
  });
  if (typeof response.trigger_id !== "string") {
    throw new Error("Expected seeded trigger id");
  }
  return { triggerId: response.trigger_id };
}

async function loadTrigger(
  triggerId: string,
): Promise<Record<string, unknown> | null> {
  const response = await postWorkflowStateAction({
    action: "get-trigger",
    trigger_id: triggerId,
  });
  return optionalRecord(response.trigger, "trigger state");
}

function pastDate(): Date {
  return new Date(now() - 3_600_000);
}

async function runNetworkPolicies(runId: string) {
  const state = await postWorkflowStateAction({
    action: "get-run-state",
    run_id: runId,
  });
  const job = optionalRecord(state.job, "runner job");
  if (!job) {
    throw new Error("Expected a runner job for the trigger run");
  }
  return z
    .object({ networkPolicies: networkPoliciesSchema.optional() })
    .parse(job.executionContext).networkPolicies;
}

async function runEnvironment(runId: string) {
  const state = await postWorkflowStateAction({
    action: "get-run-state",
    run_id: runId,
  });
  const job = optionalRecord(state.job, "runner job");
  if (!job) {
    throw new Error("Expected a runner job for the trigger run");
  }
  return z
    .object({ environment: z.record(z.string(), z.string()) })
    .parse(job.executionContext).environment;
}

async function setOwnerTimezone(
  scenario: Scenario,
  timezone: string,
): Promise<void> {
  await postWorkflowStateAction({
    action: "set-owner-timezone",
    org_id: scenario.fixture.orgId,
    user_id: scenario.fixture.userId,
    timezone,
  });
}

async function workflowUserMessageBrief(args: {
  readonly runId: string;
}): Promise<string | undefined> {
  const state = await postWorkflowStateAction({
    action: "get-run-state",
    run_id: args.runId,
  });
  const messages = records(state.messages);
  const message = messages.find((candidate) => {
    return (
      candidate.role === "user" &&
      candidate.runId === args.runId &&
      candidate.content === `/${WORKFLOW_NAME}`
    );
  });
  expect(message).toMatchObject({
    role: "user",
    content: `/${WORKFLOW_NAME}`,
  });
  const run = records(state.runs)[0];
  return optionalStringField(run ?? null, "triggerBrief") ?? undefined;
}

function friendlyTriggeredAtPattern(timezone: string): string {
  return String.raw`Triggered at \d{1,2}:\d{2} [AP]M, [A-Z][a-z]{2} \d{1,2}, \d{4} \(${timezone.replace(
    /\//gu,
    String.raw`\/`,
  )}\)`;
}

async function runIdForTrigger(triggerId: string): Promise<string> {
  const state = await postWorkflowStateAction({
    action: "get-run-state",
    trigger_id: triggerId,
  });
  const run = records(state.runs)[0];
  if (!run) {
    throw new Error("Expected a run for the trigger");
  }
  return stringField(run, "id");
}

async function runStateForTrigger(triggerId: string) {
  return await postWorkflowStateAction({
    action: "get-run-state",
    trigger_id: triggerId,
  });
}

async function seedActiveRun(scenario: Scenario): Promise<string> {
  const response = await postWorkflowStateAction({
    action: "seed-active-run",
    org_id: scenario.fixture.orgId,
    user_id: scenario.fixture.userId,
    agent_id: scenario.agentId,
  });
  if (typeof response.run_id !== "string") {
    throw new Error("Expected active run id");
  }
  return response.run_id;
}

async function completeRunThroughSandbox(
  runId: string,
  exitCode: number,
): Promise<void> {
  await runsApi.heartbeatRunner("vm0/test");
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooksApi.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `workflow-trigger-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`workflow trigger history ${runId}`)
        .digest("hex"),
    },
    sandboxHeaders,
    [200],
  );
  await webhooksApi.requestAgentComplete(
    { runId, exitCode },
    sandboxHeaders,
    [200],
  );
}

async function deleteWorkflowViaApi(scenario: Scenario): Promise<void> {
  const response = await createApp({ signal: context.signal }).request(
    `/api/zero/workflows/${scenario.workflowId}`,
    {
      method: "DELETE",
      headers: { authorization: "Bearer clerk-session" },
    },
  );
  await expectOk(response, "delete workflow");
}

async function executeDueWorkflowTriggers(): Promise<{
  readonly success: true;
  readonly executed: number;
  readonly skipped: number;
}> {
  const response = await createApp({ signal: context.signal }).request(
    CRON_EXECUTE_WORKFLOW_TRIGGERS_ROUTE,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  await expectOk(response, "execute workflow triggers cron");
  return await readJson<{
    readonly success: true;
    readonly executed: number;
    readonly skipped: number;
  }>(response);
}

describe("zero workflow trigger scheduler", () => {
  it("uses agent connector authorization and permission grants for trigger runs", async () => {
    const scenario = await setup();

    // A real Gmail connection so the gmail firewall is built into the manifest.
    await postWorkflowStateAction({
      action: "seed-gmail-authorization",
      org_id: scenario.fixture.orgId,
      user_id: scenario.fixture.userId,
      agent_id: scenario.agentId,
    });

    const trigger = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 60,
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);

    const policies = await runNetworkPolicies(
      await runIdForTrigger(trigger.triggerId),
    );
    expect(policies?.gmail?.allow ?? []).toContain("messages.write");
  });

  it("does not expose workflow permission deep-link ids to the run environment", async () => {
    const scenario = await setup();
    const trigger = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 60,
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);

    const environment = await runEnvironment(
      await runIdForTrigger(trigger.triggerId),
    );
    expect(environment.ZERO_WORKFLOW_TRIGGER_ID).toBeUndefined();
    expect(environment.ZERO_WORKFLOW_ID).toBeUndefined();
  });

  it("fires a due cron trigger: creates a run, posts to the thread, sets last_run_id", async () => {
    const scenario = await setup();
    await setOwnerTimezone(scenario, "Asia/Shanghai");
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);

    const state = await runStateForTrigger(triggerId);
    const runs = records(state.runs);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    const runId = stringField(run, "id");
    expect(run.triggerSource).toBe("workflow-schedule");
    expect(run.triggerBrief).toMatch(
      new RegExp(
        `^${friendlyTriggeredAtPattern(
          "Asia/Shanghai",
        )}\\nSchedule: Every day at 5:00 PM$`,
        "u",
      ),
    );

    const trigger = await loadTrigger(triggerId);
    expect(trigger?.nextRunAt).toBeNull();
    expect(trigger?.lastRunId).toBe(runId);

    const messages = records(state.messages);
    expect(
      messages.some((m) => {
        return m.role === "user" && m.content === `/${WORKFLOW_NAME}`;
      }),
    ).toBeTruthy();
    await expect(
      workflowUserMessageBrief({
        runId,
      }),
    ).resolves.toBe(run.triggerBrief);

    const callbacks = records(state.callbacks);
    const kinds = callbacks.map((c) => {
      return c.internalKind;
    });
    expect(kinds).toContain("workflow-trigger:cron");
    expect(kinds).toContain("chat");
  });

  it("creates the shared workflow-user thread when a due trigger has no binding yet", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTriggerWithoutThread(scenario, {
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);

    const state = await runStateForTrigger(triggerId);
    const binding = optionalRecord(state.binding, "workflow trigger binding");
    expect(binding?.chatThreadId).toStrictEqual(expect.any(String));

    const messages = records(state.messages);
    expect(
      messages.some((m) => {
        return m.role === "user" && m.content === `/${WORKFLOW_NAME}`;
      }),
    ).toBeTruthy();

    const trigger = await loadTrigger(triggerId);
    expect(trigger?.lastRunId).not.toBeNull();
  });

  it("disables a one-time trigger when it fires", async () => {
    const scenario = await setup();
    await setOwnerTimezone(scenario, "Asia/Shanghai");
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "once",
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);

    const trigger = await loadTrigger(triggerId);
    expect(trigger?.enabled).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
    const [run] = records((await runStateForTrigger(triggerId)).runs);
    expect(run?.triggerBrief).toMatch(
      new RegExp(
        `^Once at \\d{1,2}:\\d{2} [AP]M, [A-Z][a-z]{2} \\d{1,2}, \\d{4} \\(Asia\\/Shanghai\\)$`,
        "u",
      ),
    );
    const runId = stringField(run!, "id");
    await expect(
      workflowUserMessageBrief({
        runId,
      }),
    ).resolves.toBe(run?.triggerBrief);
  });

  it("fires a due loop trigger with a persisted friendly trigger brief", async () => {
    const scenario = await setup();
    await setOwnerTimezone(scenario, "Asia/Shanghai");
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 3600,
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);

    const [run] = records((await runStateForTrigger(triggerId)).runs);
    expect(run?.triggerBrief).toMatch(
      new RegExp(
        `^${friendlyTriggeredAtPattern("Asia/Shanghai")}\\nEvery 1 hour$`,
        "u",
      ),
    );
    const runId = stringField(run!, "id");
    await expect(
      workflowUserMessageBrief({
        runId,
      }),
    ).resolves.toBe(run?.triggerBrief);
  });

  it("skips a trigger whose previous run is still active", async () => {
    const scenario = await setup();
    const activeRunId = await seedActiveRun(scenario);
    const due = pastDate();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: due,
      lastRunId: activeRunId,
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(0);

    const trigger = await loadTrigger(triggerId);
    expect(dateField(trigger, "nextRunAt").getTime()).toBe(due.getTime());
  });

  it("advances a cron trigger on the completion callback", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);
    await completeRunThroughSandbox(await runIdForTrigger(triggerId), 0);

    await expect
      .poll(async () => {
        return optionalStringField(await loadTrigger(triggerId), "nextRunAt");
      })
      .not.toBeNull();
    const trigger = await loadTrigger(triggerId);
    expect(trigger?.consecutiveFailures).toBe(0);
  });

  it("reschedules a loop trigger by its interval on completion", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: pastDate(),
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);
    const before = now();
    await completeRunThroughSandbox(await runIdForTrigger(triggerId), 0);

    await expect
      .poll(async () => {
        return optionalStringField(await loadTrigger(triggerId), "nextRunAt");
      })
      .not.toBeNull();
    const trigger = await loadTrigger(triggerId);
    expect(dateField(trigger, "nextRunAt").getTime()).toBeGreaterThanOrEqual(
      before + 290_000,
    );
  });

  it("auto-disables a trigger after three consecutive failures", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: pastDate(),
      consecutiveFailures: 2,
    });

    const result = await executeDueWorkflowTriggers();
    expect(result.executed).toBe(1);
    await completeRunThroughSandbox(await runIdForTrigger(triggerId), 1);

    await expect
      .poll(async () => {
        return numberField(await loadTrigger(triggerId), "consecutiveFailures");
      })
      .toBe(3);
    const trigger = await loadTrigger(triggerId);
    expect(booleanField(trigger, "enabled")).toBeFalsy();
    expect(trigger?.nextRunAt).toBeNull();
  });

  it("cascade-deletes a workflow's triggers when the workflow is removed", async () => {
    const scenario = await setup();
    const { triggerId } = await seedTrigger(scenario, {
      scheduleType: "loop",
      intervalSeconds: 300,
      nextRunAt: pastDate(),
    });

    // Under the hard 1:N model a workflow belongs to exactly one agent; removing
    // the workflow cascade-deletes its triggers (FK onDelete: cascade).
    await deleteWorkflowViaApi(scenario);

    const trigger = await loadTrigger(triggerId);
    expect(trigger).toBeNull();
  });
});
