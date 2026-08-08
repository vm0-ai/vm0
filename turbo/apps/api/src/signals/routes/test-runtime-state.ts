import {
  getVm0Vendor,
  MODEL_PROVIDER_TYPES,
} from "@vm0/api-contracts/contracts/model-providers";
import { command } from "ccstate";
import {
  testRuntimeStateContract,
  type TestRuntimeStateActionBody,
} from "@vm0/api-contracts/contracts/test-runtime-state";
import { compatibleStoredExecutionContextSchema } from "@vm0/api-contracts/contracts/runners";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  browserSessionTabSnapshots,
  browserSessions,
} from "@vm0/db/schema/browser-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatEventSnapshots } from "@vm0/db/schema/chat-event-snapshot";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { hostedSites } from "@vm0/db/schema/hosted-site";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import {
  chatEventAssetRefs,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { closeDbPool } from "../../lib/db";
import { executeRawRows } from "../../lib/db-raw-rows";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
  type SecretKmsDataKey,
  type SecretKmsGenerateDataKeyRequest,
} from "../../lib/secret-kms-client";
import { testOverride } from "../../lib/singleton";
import type { RouteEntry } from "../route-entry";
import {
  createDeferredPromise,
  onRejection,
  settleIncludingAbort,
} from "../utils";
import {
  acquireVm0ManagedModelKeyFixture,
  releaseVm0ManagedModelKeyFixture,
} from "../services/test-vm0-managed-model-key-fixture.service";
import { browserScreenshotSchemaAvailable } from "../services/browser-screenshot-schema.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

// Test-only support actions for generic infrastructure fixtures.

const actionBody$ = bodyResultOf(testRuntimeStateContract.action);
const fakeKmsDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const VM0_MANAGED_MODEL_KEY_FIXTURE_PREFIX = "vm0-key-runtime-fixture-";
const fakeKmsDecryptCallCount = testOverride<number>(() => {
  return 0;
});

interface OrgAdmissionLockGate {
  holderPid: number | null;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
  readonly release: () => void;
}

const orgAdmissionLockGate = testOverride<OrgAdmissionLockGate | null>(() => {
  return null;
});

const orgAdmissionLockHolderRowSchema = z.object({ holderPid: z.int() });
const orgAdmissionLockStateRowSchema = z.object({
  held: z.boolean(),
  waiting: z.boolean(),
});

function createOrgAdmissionLockGate(signal: AbortSignal): OrgAdmissionLockGate {
  const released = createDeferredPromise<void>(signal);
  return {
    holderPid: null,
    released,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  };
}

function clearOrgAdmissionLockGate(gate: OrgAdmissionLockGate): void {
  if (orgAdmissionLockGate.get() === gate) {
    orgAdmissionLockGate.clear();
  }
}

async function holdOrgAdmissionLock(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  if (orgAdmissionLockGate.get()) {
    throw new Error("An org admission lock gate is already active");
  }
  const gate = createOrgAdmissionLockGate(signal);
  orgAdmissionLockGate.set(gate);
  await onRejection(
    db.transaction(async (tx) => {
      const rows = await executeRawRows(
        tx,
        sql`
          SELECT
            pg_backend_pid() AS "holderPid",
            pg_advisory_xact_lock(hashtext(${orgId}))
        `,
        orgAdmissionLockHolderRowSchema,
      );
      signal.throwIfAborted();
      const holder = rows[0];
      if (!holder) {
        throw new Error("Failed to acquire org admission lock");
      }
      gate.holderPid = holder.holderPid;
      await gate.released.promise;
    }),
    () => {
      clearOrgAdmissionLockGate(gate);
    },
  );
  clearOrgAdmissionLockGate(gate);
}

async function readOrgAdmissionLockState(
  db: Db,
  signal: AbortSignal,
): Promise<{ readonly held: boolean; readonly waiting: boolean }> {
  const holderPid = orgAdmissionLockGate.get()?.holderPid;
  if (holderPid === null || holderPid === undefined) {
    return { held: false, waiting: false };
  }
  const rows = await executeRawRows(
    db,
    sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_locks held
          WHERE
            held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
        ) AS "held",
        EXISTS (
          SELECT 1
          FROM pg_locks held
          INNER JOIN pg_locks waiting
            ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid IS NOT DISTINCT FROM held.classid
            AND waiting.objid IS NOT DISTINCT FROM held.objid
            AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          WHERE
            held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
            AND NOT waiting.granted
        ) AS "waiting"
    `,
    orgAdmissionLockStateRowSchema,
  );
  signal.throwIfAborted();
  const state = rows[0];
  if (!state) {
    throw new Error("Failed to read org admission lock state");
  }
  return state;
}

function fakeSecretKmsClient(): SecretKmsClient {
  return {
    generateDataKey(
      request: SecretKmsGenerateDataKeyRequest,
    ): Promise<SecretKmsDataKey> {
      return Promise.resolve({
        keyId: request.keyId,
        plaintext: fakeKmsDataKey,
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      });
    },
    decrypt(): Promise<Uint8Array> {
      fakeKmsDecryptCallCount.set(fakeKmsDecryptCallCount.get() + 1);
      return Promise.resolve(fakeKmsDataKey);
    },
  };
}

async function seedVm0ManagedDefaultModelKey(
  db: Db,
  fixtureId: string,
  signal: AbortSignal,
): Promise<string> {
  const selectedModel = MODEL_PROVIDER_TYPES.vm0.defaultModel;
  if (!selectedModel) {
    throw new Error("Expected vm0 to define a default model");
  }
  return await seedVm0ManagedModelKey(db, fixtureId, selectedModel, signal);
}

async function seedVm0ManagedModelKey(
  db: Db,
  fixtureId: string,
  selectedModel: string,
  signal: AbortSignal,
): Promise<string> {
  const vendor = getVm0Vendor(selectedModel);
  await acquireVm0ManagedModelKeyFixture(db, fixtureId, [
    {
      vendor,
      apiKey: `${VM0_MANAGED_MODEL_KEY_FIXTURE_PREFIX}${fixtureId}`,
    },
  ]);
  signal.throwIfAborted();
  return selectedModel;
}

async function deleteVm0ManagedModelKey(
  db: Db,
  fixtureId: string,
  signal: AbortSignal,
): Promise<void> {
  await releaseVm0ManagedModelKeyFixture(db, fixtureId);
  signal.throwIfAborted();
}

type Vm0ManagedModelKeyAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "seed-vm0-managed-default-model-key"
      | "seed-vm0-managed-model-key"
      | "delete-vm0-managed-model-key";
  }
>;

function isVm0ManagedModelKeyAction(
  body: TestRuntimeStateActionBody,
): body is Vm0ManagedModelKeyAction {
  return (
    body.action === "seed-vm0-managed-default-model-key" ||
    body.action === "seed-vm0-managed-model-key" ||
    body.action === "delete-vm0-managed-model-key"
  );
}

async function vm0ManagedModelKeyActionResponse(
  db: Db,
  body: Vm0ManagedModelKeyAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-vm0-managed-default-model-key": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedVm0ManagedDefaultModelKey(
            db,
            body.fixture_id,
            signal,
          ),
        },
      };
    }
    case "seed-vm0-managed-model-key": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedVm0ManagedModelKey(
            db,
            body.fixture_id,
            body.selected_model,
            signal,
          ),
        },
      };
    }
    case "delete-vm0-managed-model-key": {
      await deleteVm0ManagedModelKey(db, body.fixture_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

async function clearRunApiStart(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const [cleared] = await db
    .update(zeroRuns)
    .set({ apiStartedAt: null })
    .where(eq(zeroRuns.id, runId))
    .returning({ id: zeroRuns.id });
  signal.throwIfAborted();
  if (!cleared) {
    throw new Error("Expected a Zero run timing row");
  }
}

async function readRunApiStart(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const [run] = await db
    .select({ apiStartedAt: zeroRuns.apiStartedAt })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    throw new Error("Expected a Zero run timing row");
  }
  return run.apiStartedAt?.toISOString() ?? null;
}

async function readThreadSessionBinding(
  db: Db,
  threadId: string,
  signal: AbortSignal,
): Promise<{
  readonly agent_session_id: string | null;
  readonly agent_session_run_id: string | null;
  readonly run_session_id: string | null;
}> {
  const [thread] = await db
    .select({
      agentSessionId: chatThreads.agentSessionId,
      agentSessionRunId: chatThreads.agentSessionRunId,
      runSessionId: agentRuns.sessionId,
    })
    .from(chatThreads)
    .leftJoin(agentRuns, eq(chatThreads.agentSessionRunId, agentRuns.id))
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Expected a chat thread session binding row");
  }
  return {
    agent_session_id: thread.agentSessionId,
    agent_session_run_id: thread.agentSessionRunId,
    run_session_id: thread.runSessionId,
  };
}

async function clearThreadSessionBinding(
  db: Db,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  const [thread] = await db
    .update(chatThreads)
    .set({ agentSessionId: null, agentSessionRunId: null })
    .where(eq(chatThreads.id, threadId))
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Expected a chat thread session binding row");
  }
}

type AutonomyBudgetFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "set-run-autonomy-budget"
      | "read-run-autonomy-budget"
      | "set-workflow-automation-autonomy-budget"
      | "read-workflow-automation-autonomy-state"
      | "read-latest-workflow-automation-run"
      | "read-thread-goal-autonomy-budget";
  }
>;

function isAutonomyBudgetFixtureAction(
  body: TestRuntimeStateActionBody,
): body is AutonomyBudgetFixtureAction {
  return [
    "set-run-autonomy-budget",
    "read-run-autonomy-budget",
    "set-workflow-automation-autonomy-budget",
    "read-workflow-automation-autonomy-state",
    "read-latest-workflow-automation-run",
    "read-thread-goal-autonomy-budget",
  ].includes(body.action);
}

async function autonomyBudgetFixtureActionResponse(
  db: Db,
  body: AutonomyBudgetFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "set-run-autonomy-budget": {
      const [run] = await db
        .update(zeroRuns)
        .set({ autonomyBudget: body.autonomy_budget })
        .where(eq(zeroRuns.id, body.run_id))
        .returning({ id: zeroRuns.id });
      signal.throwIfAborted();
      if (!run) {
        throw new Error("Expected the autonomy-budget run fixture");
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-run-autonomy-budget": {
      const [run] = await db
        .select({ autonomyBudget: zeroRuns.autonomyBudget })
        .from(zeroRuns)
        .where(eq(zeroRuns.id, body.run_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          autonomy_budget: run?.autonomyBudget ?? null,
        },
      };
    }
    case "set-workflow-automation-autonomy-budget": {
      const [automation] = await db
        .update(zeroWorkflowAutomations)
        .set({ autonomyBudget: body.autonomy_budget })
        .where(eq(zeroWorkflowAutomations.id, body.automation_id))
        .returning({ id: zeroWorkflowAutomations.id });
      signal.throwIfAborted();
      if (!automation) {
        throw new Error("Expected the autonomy-budget automation fixture");
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-workflow-automation-autonomy-state": {
      const [automation] = await db
        .select({
          autonomyBudget: zeroWorkflowAutomations.autonomyBudget,
          enabled: zeroWorkflowAutomations.enabled,
          lastRunId: zeroWorkflowAutomations.lastRunId,
        })
        .from(zeroWorkflowAutomations)
        .where(eq(zeroWorkflowAutomations.id, body.automation_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          workflow_automation_state: automation
            ? {
                autonomy_budget: automation.autonomyBudget,
                enabled: automation.enabled,
                last_run_id: automation.lastRunId,
              }
            : null,
        },
      };
    }
    case "read-latest-workflow-automation-run": {
      const [run] = await db
        .select({
          runId: zeroRuns.id,
          autonomyBudget: zeroRuns.autonomyBudget,
        })
        .from(zeroRuns)
        .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
        .where(eq(zeroRuns.workflowAutomationId, body.automation_id))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          workflow_automation_run: run
            ? {
                run_id: run.runId,
                autonomy_budget: run.autonomyBudget,
              }
            : null,
        },
      };
    }
    case "read-thread-goal-autonomy-budget": {
      const [goal] = await db
        .select({ autonomyBudget: threadGoals.autonomyBudget })
        .from(threadGoals)
        .where(eq(threadGoals.chatThreadId, body.thread_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          autonomy_budget: goal?.autonomyBudget ?? null,
        },
      };
    }
  }
}

async function mutateRunnerJobSecretValueEnvironmentKeys(
  db: Db,
  runId: string,
  mode: "remove" | "invalid",
  signal: AbortSignal,
): Promise<void> {
  const executionContext =
    mode === "remove"
      ? sql`${runnerJobQueue.executionContext} - 'secretValueEnvironmentKeys'`
      : sql`jsonb_set(
          ${runnerJobQueue.executionContext},
          '{secretValueEnvironmentKeys}',
          '["__missing_secret_value_environment_key__"]'::jsonb,
          true
        )`;
  await db
    .update(runnerJobQueue)
    .set({ executionContext })
    .where(eq(runnerJobQueue.runId, runId));
  signal.throwIfAborted();
}

type ConnectorPermissionBaselineMutationAction = Extract<
  TestRuntimeStateActionBody,
  { action: "mutate-runner-job-connector-permission-baseline" }
>;

async function mutateRunnerJobConnectorPermissionBaseline(
  db: Db,
  body: ConnectorPermissionBaselineMutationAction,
  signal: AbortSignal,
): Promise<void> {
  let executionContext: SQL;
  switch (body.mode) {
    case "remove": {
      executionContext = sql`${runnerJobQueue.executionContext} - 'connectorPermissionBaseline'`;
      break;
    }
    case "malformed": {
      executionContext = sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorPermissionBaseline}',
        '{"version":2}'::jsonb,
        true
      )`;
      break;
    }
    case "capability-mismatch": {
      executionContext = sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorPermissionBaseline,catalogIdentity,capabilityDigest}',
        '"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"'::jsonb,
        true
      )`;
      break;
    }
    case "catalog-mismatch": {
      executionContext = sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorPermissionBaseline,catalogIdentity,catalogDigest}',
        '"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'::jsonb,
        true
      )`;
      break;
    }
    case "authority-mismatch": {
      executionContext = sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorPermissionBaseline,validationAuthority,backendVersion}',
        '"999.0.0"'::jsonb,
        true
      )`;
      break;
    }
    case "inconsistent": {
      executionContext = sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorPermissionBaseline,connectors,constructor}',
        '{
          "permissionNames": [],
          "defaultPolicy": {
            "permissionDefault": "allow",
            "unknownPolicy": "allow"
          }
        }'::jsonb,
        true
      )`;
      break;
    }
    case "incomplete": {
      executionContext = sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorPermissionBaseline,connectors}',
        '{}'::jsonb,
        true
      )`;
      break;
    }
  }
  const [updated] = await db
    .update(runnerJobQueue)
    .set({ executionContext })
    .where(eq(runnerJobQueue.runId, body.run_id))
    .returning({ runId: runnerJobQueue.runId });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a runner job permission baseline");
  }
}

async function removeRunCanonicalStorageState(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ storageMounts: null })
    .where(eq(agentRuns.id, runId));
  signal.throwIfAborted();
  await db
    .update(runnerJobQueue)
    .set({
      executionContext: sql`${runnerJobQueue.executionContext} - 'storageMounts'`,
    })
    .where(eq(runnerJobQueue.runId, runId));
  signal.throwIfAborted();
}

async function readStoragePersistenceState(
  db: Db,
  ids: {
    readonly runId: string;
    readonly sessionId: string;
    readonly checkpointId: string;
  },
  signal: AbortSignal,
) {
  const [[run], [session], [checkpoint]] = await Promise.all([
    db
      .select({
        storageMounts: agentRuns.storageMounts,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, ids.runId))
      .limit(1),
    db
      .select({
        storageMounts: agentSessions.storageMounts,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, ids.sessionId))
      .limit(1),
    db
      .select({
        storageMounts: checkpoints.storageMounts,
      })
      .from(checkpoints)
      .where(eq(checkpoints.id, ids.checkpointId))
      .limit(1),
  ]);
  signal.throwIfAborted();
  if (!run || !session || !checkpoint) {
    throw new Error("Storage persistence row not found");
  }
  return {
    run_canonical: run.storageMounts !== null,
    session_canonical: session.storageMounts !== null,
    checkpoint_canonical: checkpoint.storageMounts !== null,
  };
}

async function readRunnerJobStorageState(
  db: Db,
  runId: string,
  signal: AbortSignal,
) {
  const [job] = await db
    .select({ executionContext: runnerJobQueue.executionContext })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!job) {
    throw new Error("Runner job queue row not found");
  }
  const rawContext = z
    .record(z.string(), z.unknown())
    .parse(job.executionContext);
  const context = compatibleStoredExecutionContextSchema.parse(rawContext);
  return {
    has_stored_storage_manifest: Object.hasOwn(rawContext, "storageManifest"),
    canonical_mount_count: context.storageMounts.length,
    has_run_context_storage: Object.hasOwn(rawContext, "runContextStorage"),
  };
}

type StorageStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "remove-run-canonical-storage-state" }
>;

type ReadStorageStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-storage-persistence-state" }
>;
type ReadRunnerJobStorageStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-runner-job-storage-state" }
>;
type ReadRunClaimOwnerAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-run-claim-owner" }
>;
type ReadBrowserScreenshotSchemaStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-browser-screenshot-schema-state" }
>;
type ResetDatabasePoolAction = Extract<
  TestRuntimeStateActionBody,
  { action: "reset-database-pool" }
>;
type PersistenceStateAction =
  | StorageStateAction
  | ReadStorageStateAction
  | ReadRunnerJobStorageStateAction
  | ReadRunClaimOwnerAction
  | ReadBrowserScreenshotSchemaStateAction
  | ResetDatabasePoolAction;

function isPersistenceStateAction(
  body: TestRuntimeStateActionBody,
): body is PersistenceStateAction {
  switch (body.action) {
    case "remove-run-canonical-storage-state":
    case "read-storage-persistence-state": {
      return true;
    }
    case "read-runner-job-storage-state":
    case "read-run-claim-owner": {
      return true;
    }
    case "read-browser-screenshot-schema-state": {
      return true;
    }
    case "reset-database-pool": {
      return true;
    }
    default: {
      return false;
    }
  }
}

async function mutateStorageState(
  db: Db,
  body: StorageStateAction,
  signal: AbortSignal,
): Promise<void> {
  await removeRunCanonicalStorageState(db, body.run_id, signal);
  signal.throwIfAborted();
}

async function persistenceStateActionResponse(
  db: Db,
  body: PersistenceStateAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-storage-persistence-state": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          storage_persistence: await readStoragePersistenceState(
            db,
            {
              runId: body.run_id,
              sessionId: body.session_id,
              checkpointId: body.checkpoint_id,
            },
            signal,
          ),
        },
      };
    }
    case "read-runner-job-storage-state": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          runner_job_storage_state: await readRunnerJobStorageState(
            db,
            body.run_id,
            signal,
          ),
        },
      };
    }
    case "read-run-claim-owner": {
      return await readRunClaimOwnerActionResponse(db, body, signal);
    }
    case "read-browser-screenshot-schema-state": {
      const available = await browserScreenshotSchemaAvailable(db);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          browser_screenshot_schema_available: available,
        },
      };
    }
    case "reset-database-pool": {
      await closeDbPool();
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "remove-run-canonical-storage-state": {
      await mutateStorageState(db, body, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

async function readRunClaimOwnerActionResponse(
  db: Db,
  body: ReadRunClaimOwnerAction,
  signal: AbortSignal,
) {
  const [run] = await db
    .select({
      runnerId: agentRuns.runnerId,
      heartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, body.run_id))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    throw new Error("Agent run not found");
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      runner_claim_owner: {
        runner_id: run.runnerId,
        heartbeat_generation: run.heartbeatGeneration,
      },
    },
  };
}

type TimingStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "clear-run-api-start" | "read-run-api-start" }
>;

function isTimingStateAction(
  body: TestRuntimeStateActionBody,
): body is TimingStateAction {
  return (
    body.action === "clear-run-api-start" ||
    body.action === "read-run-api-start"
  );
}

async function timingStateActionResponse(
  db: Db,
  body: TimingStateAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "clear-run-api-start": {
      await clearRunApiStart(db, body.run_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-run-api-start": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          api_started_at: await readRunApiStart(db, body.run_id, signal),
        },
      };
    }
  }
}

type ThreadSessionStateAction = Extract<
  TestRuntimeStateActionBody,
  {
    action: "read-thread-session-binding" | "clear-thread-session-binding";
  }
>;

function isThreadSessionStateAction(
  body: TestRuntimeStateActionBody,
): body is ThreadSessionStateAction {
  return (
    body.action === "read-thread-session-binding" ||
    body.action === "clear-thread-session-binding"
  );
}

async function threadSessionStateActionResponse(
  db: Db,
  body: ThreadSessionStateAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-thread-session-binding": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          thread_session_binding: await readThreadSessionBinding(
            db,
            body.thread_id,
            signal,
          ),
        },
      };
    }
    case "clear-thread-session-binding": {
      await clearThreadSessionBinding(db, body.thread_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

type LegacyArtifactCatalogFileAction = Extract<
  TestRuntimeStateActionBody,
  { action: "insert-legacy-artifact-catalog-file" }
>;

async function insertLegacyArtifactCatalogFile(
  db: Db,
  body: LegacyArtifactCatalogFileAction,
  signal: AbortSignal,
) {
  const [file] = await db
    .insert(runUploadedFiles)
    .values({
      source: "web",
      externalId: body.url,
      userId: body.user_id,
      orgId: body.org_id,
      filename: body.filename,
      contentType: "application/zip",
      sizeBytes: 512,
      url: body.url,
      metadata: {},
    })
    .returning({ id: runUploadedFiles.id });
  signal.throwIfAborted();
  if (!file) {
    throw new Error("Failed to insert a legacy artifact catalog file");
  }
  return {
    status: 200 as const,
    body: { ok: true as const, file_id: file.id },
  };
}

type PreviousApiHostedSiteAction = Extract<
  TestRuntimeStateActionBody,
  { action: "insert-hosted-site-as-previous-api" }
>;

async function insertHostedSiteAsPreviousApi(
  db: Db,
  body: PreviousApiHostedSiteAction,
  signal: AbortSignal,
) {
  // The previous API writes only the organization-level slug and originating
  // run. Migration 0742 derives the canonical requested slug and chat owner.
  const [site] = await db
    .insert(hostedSites)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      slug: body.site,
      publicSlug: body.public_slug,
      createdFromRunId: body.run_id,
    })
    .returning({ id: hostedSites.id });
  signal.throwIfAborted();
  if (!site) {
    throw new Error("Failed to insert a previous API hosted site");
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hosted_site_id: site.id },
  };
}

type PreviousApiHostedDeploymentAction = Extract<
  TestRuntimeStateActionBody,
  { action: "insert-hosted-deployment-as-previous-api" }
>;

function isHostedDeploymentScopeConflict(error: unknown): boolean {
  const databaseError =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  return (
    databaseError instanceof Error &&
    "code" in databaseError &&
    databaseError.code === "23514" &&
    databaseError.message.includes("Hosted site belongs to a different chat")
  );
}

async function writeHostedDeploymentAsPreviousApi(
  db: Db,
  body: PreviousApiHostedDeploymentAction,
): Promise<void> {
  await db.execute(sql`
      INSERT INTO "hosted_deployments" (
        "site_id",
        "org_id",
        "user_id",
        "run_id",
        "status",
        "r2_prefix",
        "manifest",
        "manifest_hash",
        "content_hash",
        "file_count",
        "size_bytes",
        "url"
      )
      VALUES (
        ${body.hosted_site_id},
        ${body.org_id},
        ${body.user_id},
        ${body.run_id},
        'uploading',
        'previous-api-scope-fixture',
        '{}'::jsonb,
        repeat('0', 64),
        repeat('0', 64),
        0,
        0,
        'https://previous-api-scope-fixture.invalid'
      )
    `);
}

async function insertHostedDeploymentAsPreviousApi(
  db: Db,
  body: PreviousApiHostedDeploymentAction,
  signal: AbortSignal,
) {
  const inserted = await settleIncludingAbort(
    writeHostedDeploymentAsPreviousApi(db, body),
  );
  signal.throwIfAborted();
  if (!inserted.ok && !isHostedDeploymentScopeConflict(inserted.error)) {
    throw inserted.error;
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      hosted_deployment_scope_blocked: !inserted.ok,
    },
  };
}

type PreviousApiComputerAccessAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-computer-use-host-as-previous-api" }
>;

async function setComputerUseHostAsPreviousApi(
  db: Db,
  body: PreviousApiComputerAccessAction,
  signal: AbortSignal,
) {
  // The API version immediately before cloud browser shipped updated only
  // computer_use_host_id. No current production route can reproduce that
  // mixed-version writer shape.
  const [updated] = await db
    .update(chatThreads)
    .set({ computerUseHostId: body.computer_use_host_id })
    .where(eq(chatThreads.id, body.thread_id))
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a chat thread for previous API host update");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

type PreviousApiRunnerJobContextProfileAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-runner-job-context-profile-as-previous-api" }
>;

type ChatEventAssetRefFixtureAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-chat-event-asset-refs" | "insert-chat-event-asset-ref" }
>;

type PreviousApiBrowserTabSnapshotAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-browser-tab-snapshot-as-previous-api" }
>;

async function setBrowserTabSnapshotAsPreviousApi(
  db: Db,
  body: PreviousApiBrowserTabSnapshotAction,
  signal: AbortSignal,
) {
  // Older snapshots may already contain duplicate URLs. No current production
  // API can reproduce that persisted input after capture-side deduplication.
  const [browser] = await db
    .select({ userId: browserSessions.userId })
    .from(browserSessions)
    .where(eq(browserSessions.chatThreadId, body.thread_id))
    .limit(1);
  signal.throwIfAborted();
  if (!browser) {
    throw new Error("Expected a managed browser for previous API tab snapshot");
  }
  const encryptedTabUrls = await encryptPersistentSecretValue(
    JSON.stringify(body.tab_urls),
    { userId: browser.userId },
  );
  signal.throwIfAborted();
  await db
    .insert(browserSessionTabSnapshots)
    .values({
      chatThreadId: body.thread_id,
      encryptedTabUrls,
    })
    .onConflictDoUpdate({
      target: browserSessionTabSnapshots.chatThreadId,
      set: {
        encryptedTabUrls,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
}

async function setRunnerJobContextProfileAsPreviousApi(
  db: Db,
  body: PreviousApiRunnerJobContextProfileAction,
  signal: AbortSignal,
) {
  // The previous API stored the routing profile in both the dedicated queue
  // column and execution-context JSON.
  const [updated] = await db
    .update(runnerJobQueue)
    .set({
      executionContext: sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{experimentalProfile}',
        to_jsonb(${body.profile}::text),
        true
      )`,
    })
    .where(eq(runnerJobQueue.runId, body.run_id))
    .returning({ runId: runnerJobQueue.runId });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a runner job for previous API profile update");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

type CompatibilityFixtureAction =
  | AutonomyBudgetFixtureAction
  | LegacyArtifactCatalogFileAction
  | PreviousApiHostedSiteAction
  | PreviousApiHostedDeploymentAction
  | PreviousApiComputerAccessAction
  | PreviousApiBrowserTabSnapshotAction
  | PreviousApiRunnerJobContextProfileAction
  | ChatEventAssetRefFixtureAction
  | ConnectorPermissionBaselineMutationAction;

type ChatEventSnapshotFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action: "read-chat-event-snapshot-head";
  }
>;

function isChatEventSnapshotFixtureAction(
  body: TestRuntimeStateActionBody,
): body is ChatEventSnapshotFixtureAction {
  return body.action === "read-chat-event-snapshot-head";
}

async function chatEventSnapshotFixtureActionResponse(
  db: Db,
  body: ChatEventSnapshotFixtureAction,
  signal: AbortSignal,
) {
  const [head] = await db
    .select({
      archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
      lastSeqId: chatEventSnapshots.lastSeqId,
      objectKey: chatEventSnapshots.objectKey,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, body.thread_id),
        eq(chatEventSnapshots.isHead, true),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      chat_event_snapshot_head: head
        ? {
            archive_schema_version: head.archiveSchemaVersion,
            last_seq_id: head.lastSeqId,
            object_key: head.objectKey,
          }
        : null,
    },
  };
}

function isCompatibilityFixtureAction(
  body: TestRuntimeStateActionBody,
): body is CompatibilityFixtureAction {
  return [
    "set-run-autonomy-budget",
    "read-run-autonomy-budget",
    "set-workflow-automation-autonomy-budget",
    "read-workflow-automation-autonomy-state",
    "read-latest-workflow-automation-run",
    "read-thread-goal-autonomy-budget",
    "insert-legacy-artifact-catalog-file",
    "insert-hosted-site-as-previous-api",
    "insert-hosted-deployment-as-previous-api",
    "set-computer-use-host-as-previous-api",
    "set-browser-tab-snapshot-as-previous-api",
    "set-runner-job-context-profile-as-previous-api",
    "read-chat-event-asset-refs",
    "insert-chat-event-asset-ref",
    "mutate-runner-job-connector-permission-baseline",
  ].includes(body.action);
}

async function compatibilityFixtureActionResponse(
  db: Db,
  body: CompatibilityFixtureAction,
  signal: AbortSignal,
) {
  if (isAutonomyBudgetFixtureAction(body)) {
    return await autonomyBudgetFixtureActionResponse(db, body, signal);
  }
  switch (body.action) {
    case "insert-legacy-artifact-catalog-file": {
      return await insertLegacyArtifactCatalogFile(db, body, signal);
    }
    case "insert-hosted-site-as-previous-api": {
      return await insertHostedSiteAsPreviousApi(db, body, signal);
    }
    case "insert-hosted-deployment-as-previous-api": {
      return await insertHostedDeploymentAsPreviousApi(db, body, signal);
    }
    case "set-computer-use-host-as-previous-api": {
      return await setComputerUseHostAsPreviousApi(db, body, signal);
    }
    case "set-browser-tab-snapshot-as-previous-api": {
      return await setBrowserTabSnapshotAsPreviousApi(db, body, signal);
    }
    case "set-runner-job-context-profile-as-previous-api": {
      return await setRunnerJobContextProfileAsPreviousApi(db, body, signal);
    }
    case "read-chat-event-asset-refs": {
      const rows = await db
        .select({ assetId: chatEventAssetRefs.assetId })
        .from(chatEventAssetRefs)
        .where(eq(chatEventAssetRefs.chatEventId, body.event_id))
        .orderBy(chatEventAssetRefs.position);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          chat_event_asset_ref_ids: rows.map((row) => {
            return row.assetId;
          }),
        },
      };
    }
    case "insert-chat-event-asset-ref": {
      await db.insert(chatEventAssetRefs).values({
        chatEventId: body.event_id,
        assetId: body.asset_id,
        position: body.position,
      });
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "mutate-runner-job-connector-permission-baseline": {
      await mutateRunnerJobConnectorPermissionBaseline(db, body, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

const postRuntimeStateAction$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const db = set(writeDb$);
    if (isPersistenceStateAction(body)) {
      return await persistenceStateActionResponse(db, body, signal);
    }
    if (isTimingStateAction(body)) {
      return await timingStateActionResponse(db, body, signal);
    }
    if (isThreadSessionStateAction(body)) {
      return await threadSessionStateActionResponse(db, body, signal);
    }
    if (isChatEventSnapshotFixtureAction(body)) {
      return await chatEventSnapshotFixtureActionResponse(db, body, signal);
    }
    if (isCompatibilityFixtureAction(body)) {
      return await compatibilityFixtureActionResponse(db, body, signal);
    }
    if (isVm0ManagedModelKeyAction(body)) {
      return await vm0ManagedModelKeyActionResponse(db, body, signal);
    }
    switch (body.action) {
      case "enable-fake-kms": {
        fakeKmsDecryptCallCount.set(0);
        setSecretKmsClientForTests(fakeSecretKmsClient());
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "reset-fake-kms": {
        resetSecretKmsClientForTests();
        fakeKmsDecryptCallCount.set(0);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-fake-kms-state": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            decrypt_call_count: fakeKmsDecryptCallCount.get(),
          },
        };
      }
      case "mutate-runner-job-secret-value-environment-keys": {
        await mutateRunnerJobSecretValueEnvironmentKeys(
          db,
          body.run_id,
          body.mode,
          signal,
        );
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "replace-custom-connector-prefixes": {
        await db
          .update(orgCustomConnectors)
          .set({
            prefixes: body.prefixes,
            prefixTemplates: body.prefixes,
          })
          .where(eq(orgCustomConnectors.id, body.connector_id));
        signal.throwIfAborted();
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "hold-org-admission-lock": {
        await holdOrgAdmissionLock(db, body.org_id, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-org-admission-lock-state": {
        const state = await readOrgAdmissionLockState(db, signal);
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            admission_lock_held: state.held,
            admission_lock_waiting: state.waiting,
          },
        };
      }
      case "release-org-admission-lock": {
        orgAdmissionLockGate.get()?.release();
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-run-uploaded-file-sources": {
        const rows = await db
          .select({ source: runUploadedFiles.source })
          .from(runUploadedFiles)
          .where(eq(runUploadedFiles.runId, body.run_id))
          .orderBy(runUploadedFiles.source);
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            uploaded_file_sources: rows.map((row) => {
              return row.source;
            }),
          },
        };
      }
    }
  },
);

export const testRuntimeStateRoutes: readonly RouteEntry[] = [
  {
    route: testRuntimeStateContract.action,
    handler: postRuntimeStateAction$,
  },
];
