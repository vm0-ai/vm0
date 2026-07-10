import type {
  TestAutomationsStateActionBody,
  TestAutomationsStateActionResponse,
} from "@vm0/api-contracts/contracts/test-automations-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testAutomationsStateRoutes } from "../../test-automations-state";

const AUTOMATIONS_STATE_ROUTE = "/api/test/automations-state";

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

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
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

export async function seedVm0ManagedModelKey(
  context: TestContext,
  selectedModel: string,
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-vm0-managed-model-key",
    selected_model: selectedModel,
  });
  if (!response.selected_model) {
    throw new Error("seedVm0ManagedModelKey missing selected_model");
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

export async function mutateRunnerJobSecretValueEnvironmentKeys(
  context: TestContext,
  runId: string,
  mode: "remove" | "invalid",
): Promise<void> {
  await postAction(context, {
    action: "mutate-runner-job-secret-value-environment-keys",
    run_id: runId,
    mode,
  });
}
