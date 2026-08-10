import { randomUUID } from "node:crypto";

import type {
  TestRuntimeStateActionBody,
  TestRuntimeStateActionResponse,
} from "@vm0/api-contracts/contracts/test-runtime-state";
import { onTestFinished } from "vitest";

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

interface Vm0ManagedModelKeyFixture {
  readonly selectedModel: string;
  release(): Promise<void>;
}

function vm0ManagedModelKeyFixture(
  context: TestContext,
  fixtureId: string,
  selectedModel: string,
): Vm0ManagedModelKeyFixture {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    await postAction(context, {
      action: "delete-vm0-managed-model-key",
      fixture_id: fixtureId,
    });
    released = true;
  };
  onTestFinished(release);
  return { selectedModel, release };
}

export async function seedVm0ManagedDefaultModelKey(
  context: TestContext,
): Promise<Vm0ManagedModelKeyFixture> {
  const fixtureId = randomUUID();
  const response = await postAction(context, {
    action: "seed-vm0-managed-default-model-key",
    fixture_id: fixtureId,
  });
  if (!response.selected_model) {
    throw new Error("seedVm0ManagedDefaultModelKey missing selected_model");
  }
  return vm0ManagedModelKeyFixture(context, fixtureId, response.selected_model);
}

export async function seedVm0ManagedModelKey(
  context: TestContext,
  selectedModel: string,
): Promise<Vm0ManagedModelKeyFixture> {
  const fixtureId = randomUUID();
  const response = await postAction(context, {
    action: "seed-vm0-managed-model-key",
    fixture_id: fixtureId,
    selected_model: selectedModel,
  });
  if (!response.selected_model) {
    throw new Error("seedVm0ManagedModelKey missing selected_model");
  }
  return vm0ManagedModelKeyFixture(context, fixtureId, response.selected_model);
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

export async function readBrowserScreenshotSchemaAvailable(
  context: TestContext,
): Promise<boolean> {
  const response = await postAction(context, {
    action: "read-browser-screenshot-schema-state",
  });
  if (response.browser_screenshot_schema_available === undefined) {
    throw new Error(
      "readBrowserScreenshotSchemaAvailable missing schema availability",
    );
  }
  return response.browser_screenshot_schema_available;
}

export async function readUsagePackInvitationSchemaAvailable(
  context: TestContext,
): Promise<boolean> {
  const response = await postAction(context, {
    action: "read-usage-pack-invitation-schema-state",
  });
  if (response.usage_pack_invitation_schema_available === undefined) {
    throw new Error(
      "readUsagePackInvitationSchemaAvailable missing schema availability",
    );
  }
  return response.usage_pack_invitation_schema_available;
}

export async function readRunAutonomyBudgetFixture(
  context: TestContext,
  runId: string,
): Promise<number | null> {
  const response = await postAction(context, {
    action: "read-run-autonomy-budget",
    run_id: runId,
  });
  if (!("autonomy_budget" in response)) {
    throw new Error("readRunAutonomyBudgetFixture missing autonomy_budget");
  }
  return response.autonomy_budget ?? null;
}

export async function setRunAutonomyBudgetFixture(
  context: TestContext,
  runId: string,
  autonomyBudget: number,
): Promise<void> {
  await postAction(context, {
    action: "set-run-autonomy-budget",
    run_id: runId,
    autonomy_budget: autonomyBudget,
  });
}

export async function readWorkflowAutomationAutonomyFixture(
  context: TestContext,
  automationId: string,
): Promise<{
  readonly autonomyBudget: number;
  readonly enabled: boolean;
  readonly lastRunId: string | null;
} | null> {
  const response = await postAction(context, {
    action: "read-workflow-automation-autonomy-state",
    automation_id: automationId,
  });
  if (!("workflow_automation_state" in response)) {
    throw new Error(
      "readWorkflowAutomationAutonomyFixture missing workflow_automation_state",
    );
  }
  const state = response.workflow_automation_state;
  return state
    ? {
        autonomyBudget: state.autonomy_budget,
        enabled: state.enabled,
        lastRunId: state.last_run_id,
      }
    : null;
}

export async function setWorkflowAutomationAutonomyBudgetFixture(
  context: TestContext,
  automationId: string,
  autonomyBudget: number,
): Promise<void> {
  await postAction(context, {
    action: "set-workflow-automation-autonomy-budget",
    automation_id: automationId,
    autonomy_budget: autonomyBudget,
  });
}

export async function readLatestWorkflowAutomationRunFixture(
  context: TestContext,
  automationId: string,
): Promise<{
  readonly runId: string;
  readonly autonomyBudget: number;
} | null> {
  const response = await postAction(context, {
    action: "read-latest-workflow-automation-run",
    automation_id: automationId,
  });
  if (!("workflow_automation_run" in response)) {
    throw new Error(
      "readLatestWorkflowAutomationRunFixture missing workflow_automation_run",
    );
  }
  const run = response.workflow_automation_run;
  return run
    ? { runId: run.run_id, autonomyBudget: run.autonomy_budget }
    : null;
}

export async function readThreadGoalAutonomyBudgetFixture(
  context: TestContext,
  threadId: string,
): Promise<number | null> {
  const response = await postAction(context, {
    action: "read-thread-goal-autonomy-budget",
    thread_id: threadId,
  });
  if (!("autonomy_budget" in response)) {
    throw new Error(
      "readThreadGoalAutonomyBudgetFixture missing autonomy_budget",
    );
  }
  return response.autonomy_budget ?? null;
}

export async function resetDatabasePool(context: TestContext): Promise<void> {
  await postAction(context, { action: "reset-database-pool" });
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
    | "legacy-targets"
    | "remove"
    | "malformed"
    | "capability-mismatch"
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

export async function readRunClaimOwner(
  context: TestContext,
  runId: string,
): Promise<NonNullable<TestRuntimeStateActionResponse["runner_claim_owner"]>> {
  const response = await postAction(context, {
    action: "read-run-claim-owner",
    run_id: runId,
  });
  if (!response.runner_claim_owner) {
    throw new Error("readRunClaimOwner missing runner_claim_owner");
  }
  return response.runner_claim_owner;
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

export async function setChatEventSnapshotHeadVersion(
  context: TestContext,
  threadId: string,
  archiveSchemaVersion: number,
): Promise<void> {
  await postAction(context, {
    action: "set-chat-event-snapshot-head-version",
    thread_id: threadId,
    archive_schema_version: archiveSchemaVersion,
  });
}

export async function readChatEventSnapshotHead(
  context: TestContext,
  threadId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["chat_event_snapshot_head"]>
> {
  const response = await postAction(context, {
    action: "read-chat-event-snapshot-head",
    thread_id: threadId,
  });
  if (!response.chat_event_snapshot_head) {
    throw new Error("readChatEventSnapshotHead missing snapshot head");
  }
  return response.chat_event_snapshot_head;
}

export async function insertHostedSiteAsPreviousApi(
  context: TestContext,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly runId: string;
    readonly site: string;
    readonly publicSlug: string;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "insert-hosted-site-as-previous-api",
    user_id: args.userId,
    org_id: args.orgId,
    run_id: args.runId,
    site: args.site,
    public_slug: args.publicSlug,
  });
  if (!response.hosted_site_id) {
    throw new Error("insertHostedSiteAsPreviousApi missing hosted_site_id");
  }
  return response.hosted_site_id;
}

export async function insertHostedDeploymentAsPreviousApi(
  context: TestContext,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly runId: string;
    readonly hostedSiteId: string;
  },
): Promise<boolean> {
  const response = await postAction(context, {
    action: "insert-hosted-deployment-as-previous-api",
    user_id: args.userId,
    org_id: args.orgId,
    run_id: args.runId,
    hosted_site_id: args.hostedSiteId,
  });
  return response.hosted_deployment_scope_blocked ?? false;
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

export async function setBrowserTabSnapshotAsPreviousApi(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly tabUrls: readonly string[];
  },
): Promise<void> {
  await postAction(context, {
    action: "set-browser-tab-snapshot-as-previous-api",
    thread_id: args.threadId,
    tab_urls: [...args.tabUrls],
  });
}
