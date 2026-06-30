import type {
  TestAutomationsStateActionBody,
  TestAutomationsStateActionResponse,
  TestAutomationsStatePatchBody,
  TestAutomationsStatePostBody,
  TestAutomationsStatePostResponse,
  TestAutomationsStateReadResponse,
  TestAutomationsStateTriggerRow,
} from "@vm0/api-contracts/contracts/test-automations-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testAutomationsStateRoutes } from "../../test-automations-state";

const AUTOMATIONS_STATE_ROUTE = "/api/test/automations-state";

interface AutomationSeed {
  readonly name: string;
  readonly prompt: string;
  readonly description?: string | null;
  readonly cronExpression?: string;
  readonly atTime?: Date;
  readonly intervalSeconds?: number;
  readonly triggerType?: "cron" | "once" | "loop";
  readonly enabled?: boolean;
  readonly nextRunAt?: Date | null;
  readonly lastRunId?: string | null;
  readonly appendSystemPrompt?: string | null;
  readonly timezone?: string;
  readonly consecutiveFailures?: number;
}

interface AutomationsScenarioValues {
  readonly automations: readonly AutomationSeed[];
  readonly displayName?: string;
  readonly agentName?: string;
  readonly userName?: string | null;
  readonly userEmail?: string | null;
  readonly timezone?: string | null;
  readonly framework?: "claude-code" | "codex";
}

export interface AutomationsFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly automationIds: readonly string[];
}

type AutomationState = NonNullable<
  TestAutomationsStateReadResponse["automation"]
>;
type AutomationRunState = NonNullable<TestAutomationsStateReadResponse["run"]>;
type AutomationTriggerRow = TestAutomationsStateTriggerRow;

function requestAutomationsState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testAutomationsStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function dateToWire(value: Date | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return value.toISOString();
}

function toPostBody(
  values: AutomationsScenarioValues,
): TestAutomationsStatePostBody {
  return {
    ...values,
    automations: values.automations.map((seed) => {
      return {
        ...seed,
        atTime: dateToWire(seed.atTime) ?? undefined,
        nextRunAt: dateToWire(seed.nextRunAt),
      };
    }),
  };
}

function fromPostResponse(
  response: TestAutomationsStatePostResponse,
): AutomationsFixture {
  return {
    orgId: response.org_id,
    userId: response.user_id,
    composeId: response.compose_id,
    automationIds: response.automation_ids,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  context: TestContext,
  body: TestAutomationsStateActionBody,
): Promise<TestAutomationsStateActionResponse> {
  const response = await requestAutomationsState(
    context,
    `${AUTOMATIONS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `automations action ${body.action}`);
  return await readJson<TestAutomationsStateActionResponse>(response);
}

export async function seedAutomationsScenario(
  context: TestContext,
  values: AutomationsScenarioValues,
): Promise<AutomationsFixture> {
  const response = await requestAutomationsState(
    context,
    AUTOMATIONS_STATE_ROUTE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toPostBody(values)),
    },
  );
  await expectOk(response, "seedAutomationsScenario");
  return fromPostResponse(
    await readJson<TestAutomationsStatePostResponse>(response),
  );
}

export async function deleteAutomationsScenario(
  context: TestContext,
  fixture: AutomationsFixture,
): Promise<void> {
  const query = new URLSearchParams({
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
  });
  if (fixture.automationIds.length > 0) {
    query.set("automation_ids", fixture.automationIds.join(","));
  }

  const response = await requestAutomationsState(
    context,
    `${AUTOMATIONS_STATE_ROUTE}?${query.toString()}`,
    { method: "DELETE" },
  );
  await expectOk(response, "deleteAutomationsScenario");
}

export async function readAutomationsState(
  context: TestContext,
  params: {
    readonly automationId?: string;
    readonly automationIds?: readonly string[];
    readonly runId?: string;
    readonly orgId?: string;
  },
): Promise<TestAutomationsStateReadResponse> {
  const query = new URLSearchParams();
  if (params.automationId) {
    query.set("automation_id", params.automationId);
  }
  if (params.automationIds && params.automationIds.length > 0) {
    query.set("automation_ids", params.automationIds.join(","));
  }
  if (params.runId) {
    query.set("run_id", params.runId);
  }
  if (params.orgId) {
    query.set("org_id", params.orgId);
  }
  const response = await requestAutomationsState(
    context,
    `${AUTOMATIONS_STATE_ROUTE}/read?${query.toString()}`,
  );
  await expectOk(response, "readAutomationsState");
  return await readJson<TestAutomationsStateReadResponse>(response);
}

export async function findAutomationTriggerRows(
  context: TestContext,
  automationId: string,
): Promise<readonly AutomationTriggerRow[]> {
  const state = await readAutomationsState(context, {
    automationIds: [automationId],
  });
  return state.triggers;
}

export async function patchAutomationTriggerState(
  context: TestContext,
  body: Omit<TestAutomationsStatePatchBody, "at_time" | "next_run_at"> & {
    readonly at_time?: Date | null;
    readonly next_run_at?: Date | null;
  },
): Promise<void> {
  const wireBody: TestAutomationsStatePatchBody = {
    ...body,
    at_time: dateToWire(body.at_time),
    next_run_at: dateToWire(body.next_run_at),
  };
  const response = await requestAutomationsState(
    context,
    `${AUTOMATIONS_STATE_ROUTE}/trigger`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wireBody),
    },
  );
  await expectOk(response, "patchAutomationTriggerState");
}

export async function cleanupCreatedAutomations(
  context: TestContext,
  fixture: AutomationsFixture,
): Promise<void> {
  await postAction(context, {
    action: "cleanup-created-automations",
    org_id: fixture.orgId,
  });
}

export async function seedExtraCompose(
  context: TestContext,
  fixture: AutomationsFixture,
  composeId: string,
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-compose",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: composeId,
  });
  if (!response.compose_id) {
    throw new Error("seedExtraCompose did not return compose_id");
  }
  return response.compose_id;
}

export async function deleteExtraCompose(
  context: TestContext,
  composeId: string,
): Promise<void> {
  await postAction(context, {
    action: "delete-compose",
    compose_id: composeId,
  });
}

export async function seedAutomationRun(
  context: TestContext,
  fixture: AutomationsFixture,
  options: { readonly status?: string; readonly prompt?: string } = {},
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-run",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
    status: options.status,
    prompt: options.prompt,
  });
  if (!response.run_id) {
    throw new Error("seedAutomationRun did not return run_id");
  }
  return response.run_id;
}

export async function deleteOrgMembership(
  context: TestContext,
  fixture: AutomationsFixture,
): Promise<void> {
  await postAction(context, {
    action: "delete-org-member",
    org_id: fixture.orgId,
    user_id: fixture.userId,
  });
}

export async function readAutomationComposeHeadVersion(
  context: TestContext,
  composeId: string,
): Promise<string> {
  const response = await postAction(context, {
    action: "read-compose-head-version",
    compose_id: composeId,
  });
  if (!response.head_version_id) {
    throw new Error("readAutomationComposeHeadVersion missing head_version_id");
  }
  return response.head_version_id;
}

export async function seedVm0ManagedDefaultModelKey(
  context: TestContext,
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-vm0-managed-default-model-key",
  });
  if (!response.selected_model) {
    throw new Error("seedVm0ManagedDefaultModelKey missing selected_model");
  }
  return response.selected_model;
}

export async function deleteVm0ManagedDefaultModelKey(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "delete-vm0-managed-default-model-key" });
}

export async function enableAutomationsFakeKms(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "enable-fake-kms" });
}

export async function resetAutomationsFakeKms(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "reset-fake-kms" });
}

export async function readAutomationsFakeKmsDecryptCallCount(
  context: TestContext,
): Promise<number> {
  const response = await postAction(context, { action: "read-fake-kms-state" });
  return response.decrypt_call_count ?? 0;
}
