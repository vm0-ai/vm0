import type {
  TestRuntimeStateActionBody,
  TestRuntimeStateActionResponse,
} from "@vm0/api-contracts/contracts/test-runtime-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testRuntimeStateRoutes } from "../../test-runtime-state";

const RUNTIME_STATE_ROUTE = "/api/test/runtime-state";

function requestRuntimeState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testRuntimeStateRoutes,
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
  body: TestRuntimeStateActionBody,
): Promise<TestRuntimeStateActionResponse> {
  const response = await requestRuntimeState(
    context,
    `${RUNTIME_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `runtime state action ${body.action}`);
  return await readJson<TestRuntimeStateActionResponse>(response);
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

export async function enableFakeKms(context: TestContext): Promise<void> {
  await postAction(context, { action: "enable-fake-kms" });
}

export async function resetFakeKms(context: TestContext): Promise<void> {
  await postAction(context, { action: "reset-fake-kms" });
}

export async function readFakeKmsDecryptCallCount(
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

export async function mutateRunnerJobConnectorPermissionBaseline(
  context: TestContext,
  runId: string,
  mode:
    | "remove"
    | "malformed"
    | "catalog-mismatch"
    | "authority-mismatch"
    | "inconsistent"
    | "incomplete",
): Promise<void> {
  await postAction(context, {
    action: "mutate-runner-job-connector-permission-baseline",
    run_id: runId,
    mode,
  });
}

export async function setRunnerJobContextProfileAsPreviousApi(
  context: TestContext,
  runId: string,
  profile: string,
): Promise<void> {
  await postAction(context, {
    action: "set-runner-job-context-profile-as-previous-api",
    run_id: runId,
    profile,
  });
}

export async function removeRunCanonicalStorageState(
  context: TestContext,
  runId: string,
): Promise<void> {
  await postAction(context, {
    action: "remove-run-canonical-storage-state",
    run_id: runId,
  });
}

export async function readRunnerJobStorageState(
  context: TestContext,
  runId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["runner_job_storage_state"]>
> {
  const response = await postAction(context, {
    action: "read-runner-job-storage-state",
    run_id: runId,
  });
  if (!response.runner_job_storage_state) {
    throw new Error(
      "readRunnerJobStorageState missing runner_job_storage_state",
    );
  }
  return response.runner_job_storage_state;
}

export async function readStoragePersistenceState(
  context: TestContext,
  ids: {
    readonly runId: string;
    readonly sessionId: string;
    readonly checkpointId: string;
  },
): Promise<NonNullable<TestRuntimeStateActionResponse["storage_persistence"]>> {
  const response = await postAction(context, {
    action: "read-storage-persistence-state",
    run_id: ids.runId,
    session_id: ids.sessionId,
    checkpoint_id: ids.checkpointId,
  });
  if (!response.storage_persistence) {
    throw new Error("readStoragePersistenceState missing storage_persistence");
  }
  return response.storage_persistence;
}

export async function replaceCustomConnectorPrefixes(
  context: TestContext,
  connectorId: string,
  prefixes: readonly string[],
): Promise<void> {
  await postAction(context, {
    action: "replace-custom-connector-prefixes",
    connector_id: connectorId,
    prefixes: [...prefixes],
  });
}

export async function holdOrgAdmissionLock(
  context: TestContext,
  orgId: string,
): Promise<void> {
  await postAction(context, {
    action: "hold-org-admission-lock",
    org_id: orgId,
  });
}

export async function readOrgAdmissionLockState(
  context: TestContext,
): Promise<{ readonly held: boolean; readonly waiting: boolean }> {
  const response = await postAction(context, {
    action: "read-org-admission-lock-state",
  });
  if (
    response.admission_lock_held === undefined ||
    response.admission_lock_waiting === undefined
  ) {
    throw new Error("readOrgAdmissionLockState missing lock state");
  }
  return {
    held: response.admission_lock_held,
    waiting: response.admission_lock_waiting,
  };
}

export async function releaseOrgAdmissionLock(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "release-org-admission-lock" });
}

export async function readRunUploadedFileSources(
  context: TestContext,
  runId: string,
): Promise<readonly string[]> {
  const response = await postAction(context, {
    action: "read-run-uploaded-file-sources",
    run_id: runId,
  });
  return response.uploaded_file_sources ?? [];
}

export async function clearRunApiStart(
  context: TestContext,
  runId: string,
): Promise<void> {
  await postAction(context, {
    action: "clear-run-api-start",
    run_id: runId,
  });
}

export async function readRunApiStart(
  context: TestContext,
  runId: string,
): Promise<string | null> {
  const response = await postAction(context, {
    action: "read-run-api-start",
    run_id: runId,
  });
  if (!("api_started_at" in response)) {
    throw new Error("readRunApiStart missing api_started_at");
  }
  return response.api_started_at ?? null;
}

export async function readThreadSessionBinding(
  context: TestContext,
  threadId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["thread_session_binding"]>
> {
  const response = await postAction(context, {
    action: "read-thread-session-binding",
    thread_id: threadId,
  });
  if (!response.thread_session_binding) {
    throw new Error("readThreadSessionBinding missing thread_session_binding");
  }
  return response.thread_session_binding;
}

export async function clearThreadSessionBinding(
  context: TestContext,
  threadId: string,
): Promise<void> {
  await postAction(context, {
    action: "clear-thread-session-binding",
    thread_id: threadId,
  });
}

export async function insertLegacyArtifactCatalogFile(
  context: TestContext,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly filename: string;
    readonly url: string;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "insert-legacy-artifact-catalog-file",
    user_id: args.userId,
    org_id: args.orgId,
    filename: args.filename,
    url: args.url,
  });
  if (!response.file_id) {
    throw new Error("insertLegacyArtifactCatalogFile missing file_id");
  }
  return response.file_id;
}

export async function setComputerUseHostAsPreviousApi(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly computerUseHostId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-computer-use-host-as-previous-api",
    thread_id: args.threadId,
    computer_use_host_id: args.computerUseHostId,
  });
}

export async function readBrowserProfileAsPreviousApi(
  context: TestContext,
  args: {
    readonly browserId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<{
  readonly browserProfileId: string;
  readonly providerProfileId: string;
}> {
  const response = await postAction(context, {
    action: "read-browser-profile-as-previous-api",
    browser_id: args.browserId,
    user_id: args.userId,
    org_id: args.orgId,
  });
  if (!response.previous_api_browser_profile) {
    throw new Error(
      "readBrowserProfileAsPreviousApi missing previous_api_browser_profile",
    );
  }
  return {
    browserProfileId: response.previous_api_browser_profile.browser_profile_id,
    providerProfileId:
      response.previous_api_browser_profile.provider_profile_id,
  };
}
