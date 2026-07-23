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
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { storages } from "@vm0/db/schema/storage";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { eq, sql } from "drizzle-orm";
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

type StorageStateAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "remove-run-canonical-storage-state"
      | "remove-session-canonical-storage-state"
      | "remove-checkpoint-canonical-storage-state"
      | "delete-storage-row";
  }
>;

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
      await db
        .update(agentSessions)
        .set({ storageMounts: null })
        .where(eq(agentSessions.id, body.session_id));
      break;
    }
    case "remove-checkpoint-canonical-storage-state": {
      await db
        .update(checkpoints)
        .set({ storageMounts: null })
        .where(eq(checkpoints.id, body.checkpoint_id));
      break;
    }
    case "delete-storage-row": {
      await db.delete(storages).where(eq(storages.id, body.storage_id));
      break;
    }
  }
  signal.throwIfAborted();
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
      case "remove-run-canonical-storage-state":
      case "remove-session-canonical-storage-state":
      case "remove-checkpoint-canonical-storage-state":
      case "delete-storage-row": {
        await mutateStorageState(db, body, signal);
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
