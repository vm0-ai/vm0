import {
  getProviderRuntimeModel,
  getVm0Vendor,
  MODEL_PROVIDER_TYPES,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { command } from "ccstate";
import {
  testRuntimeStateContract,
  type TestRuntimeStateActionBody,
} from "@vm0/api-contracts/contracts/test-runtime-state";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../lib/secret-kms-client";
import { testOverride } from "../../lib/singleton";
import type { RouteEntry } from "../route-entry";
import { createDeferredPromise, onRejection } from "../utils";
import { projectLegacyWritebackArtifacts } from "../services/storage-legacy-projection.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

// Test-only support actions for generic infrastructure fixtures.

const actionBody$ = bodyResultOf(testRuntimeStateContract.action);
const fakeKmsDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY =
  "vm0-key-run-lifecycle-bdd-default-model";
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
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: fakeKmsDataKey,
      });
    }
    fakeKmsDecryptCallCount.set(fakeKmsDecryptCallCount.get() + 1);
    return Promise.resolve({ $metadata: {}, Plaintext: fakeKmsDataKey });
  }
  return { send };
}

async function seedVm0ManagedDefaultModelKey(
  db: Db,
  signal: AbortSignal,
): Promise<string> {
  const selectedModel = MODEL_PROVIDER_TYPES.vm0.defaultModel;
  if (!selectedModel) {
    throw new Error("Expected vm0 to define a default model");
  }
  return await seedVm0ManagedModelKey(db, selectedModel, signal);
}

async function seedVm0ManagedModelKey(
  db: Db,
  selectedModel: string,
  signal: AbortSignal,
): Promise<string> {
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY));
  signal.throwIfAborted();
  await db.insert(vm0ApiKeys).values({
    vendor: getVm0Vendor(selectedModel),
    model: getProviderRuntimeModel("vm0", selectedModel),
    apiKey: RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY,
    label: "run-lifecycle-bdd",
  });
  signal.throwIfAborted();
  return selectedModel;
}

async function deleteVm0ManagedDefaultModelKey(
  db: Db,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY));
  signal.throwIfAborted();
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

async function clearChatMessageQueueApiStart(
  db: Db,
  chatMessageId: string,
  signal: AbortSignal,
): Promise<void> {
  const [cleared] = await db
    .update(chatMessageQueue)
    .set({ apiStartedAt: null })
    .where(eq(chatMessageQueue.chatMessageId, chatMessageId))
    .returning({ id: chatMessageQueue.id });
  signal.throwIfAborted();
  if (!cleared) {
    throw new Error("Expected a queued chat message timing row");
  }
}

async function clearWorkflowQueueApiStart(
  db: Db,
  automationId: string,
  signal: AbortSignal,
): Promise<void> {
  const cleared = await db
    .update(chatMessageQueue)
    .set({ apiStartedAt: null })
    .where(
      and(
        eq(chatMessageQueue.automationId, automationId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    )
    .returning({ id: chatMessageQueue.id });
  signal.throwIfAborted();
  if (cleared.length !== 1) {
    throw new Error("Expected one queued workflow event timing row");
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

async function removeSessionCanonicalStorageState(
  db: Db,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const [session] = await db
    .select({
      artifacts: agentSessions.artifacts,
      storageMounts: agentSessions.storageMounts,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  signal.throwIfAborted();
  if (!session) {
    throw new Error("Agent session not found");
  }
  await db
    .update(agentSessions)
    .set({
      artifacts:
        session.storageMounts === null
          ? session.artifacts
          : [...projectLegacyWritebackArtifacts(session.storageMounts)],
      storageMounts: null,
    })
    .where(eq(agentSessions.id, sessionId));
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
        additionalVolumes: agentRuns.additionalVolumes,
        storageMounts: agentRuns.storageMounts,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, ids.runId))
      .limit(1),
    db
      .select({
        artifacts: agentSessions.artifacts,
        storageMounts: agentSessions.storageMounts,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, ids.sessionId))
      .limit(1),
    db
      .select({
        artifactSnapshots: checkpoints.artifactSnapshots,
        volumeVersionsSnapshot: checkpoints.volumeVersionsSnapshot,
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
    run_legacy: (run.additionalVolumes?.length ?? 0) > 0,
    session_canonical: session.storageMounts !== null,
    session_legacy: session.artifacts.length > 0,
    checkpoint_canonical: checkpoint.storageMounts !== null,
    checkpoint_legacy_artifacts:
      (checkpoint.artifactSnapshots?.length ?? 0) > 0,
    checkpoint_legacy_volumes: checkpoint.volumeVersionsSnapshot !== null,
  };
}

type StorageStateAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "remove-run-canonical-storage-state"
      | "remove-session-canonical-storage-state";
  }
>;

type ReadStorageStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-storage-persistence-state" }
>;
type AnyStorageStateAction = StorageStateAction | ReadStorageStateAction;

function isStorageStateAction(
  body: TestRuntimeStateActionBody,
): body is AnyStorageStateAction {
  switch (body.action) {
    case "remove-run-canonical-storage-state":
    case "remove-session-canonical-storage-state":
    case "read-storage-persistence-state": {
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
  switch (body.action) {
    case "remove-run-canonical-storage-state": {
      await removeRunCanonicalStorageState(db, body.run_id, signal);
      return;
    }
    case "remove-session-canonical-storage-state": {
      await removeSessionCanonicalStorageState(db, body.session_id, signal);
      break;
    }
  }
  signal.throwIfAborted();
}

async function storageStateActionResponse(
  db: Db,
  body: AnyStorageStateAction,
  signal: AbortSignal,
) {
  if (body.action === "read-storage-persistence-state") {
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
  await mutateStorageState(db, body, signal);
  return { status: 200 as const, body: { ok: true as const } };
}

type TimingStateAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "clear-run-api-start"
      | "clear-chat-message-queue-api-start"
      | "clear-workflow-queue-api-start"
      | "read-run-api-start";
  }
>;

function isTimingStateAction(
  body: TestRuntimeStateActionBody,
): body is TimingStateAction {
  return (
    body.action === "clear-run-api-start" ||
    body.action === "clear-chat-message-queue-api-start" ||
    body.action === "clear-workflow-queue-api-start" ||
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
    case "clear-chat-message-queue-api-start": {
      await clearChatMessageQueueApiStart(db, body.chat_message_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "clear-workflow-queue-api-start": {
      await clearWorkflowQueueApiStart(db, body.automation_id, signal);
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
    if (isStorageStateAction(body)) {
      return await storageStateActionResponse(db, body, signal);
    }
    if (isTimingStateAction(body)) {
      return await timingStateActionResponse(db, body, signal);
    }
    switch (body.action) {
      case "seed-vm0-managed-default-model-key": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            selected_model: await seedVm0ManagedDefaultModelKey(db, signal),
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
              body.selected_model,
              signal,
            ),
          },
        };
      }
      case "delete-vm0-managed-default-model-key": {
        await deleteVm0ManagedDefaultModelKey(db, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
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
