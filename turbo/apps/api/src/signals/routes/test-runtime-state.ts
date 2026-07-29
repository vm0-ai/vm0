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
import { compatibleStoredExecutionContextSchema } from "@vm0/api-contracts/contracts/runners";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  browserProfiles,
  browserSessionInstances,
  browserSessions,
} from "@vm0/db/schema/browser-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, sql, type SQL } from "drizzle-orm";
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
type AnyStorageStateAction =
  | StorageStateAction
  | ReadStorageStateAction
  | ReadRunnerJobStorageStateAction;

function isStorageStateAction(
  body: TestRuntimeStateActionBody,
): body is AnyStorageStateAction {
  switch (body.action) {
    case "remove-run-canonical-storage-state":
    case "read-storage-persistence-state": {
      return true;
    }
    case "read-runner-job-storage-state": {
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

async function storageStateActionResponse(
  db: Db,
  body: AnyStorageStateAction,
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
    case "remove-run-canonical-storage-state": {
      await mutateStorageState(db, body, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
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

type PreviousApiBrowserProfileAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-browser-profile-as-previous-api" }
>;

type PreviousApiBrowserInstanceAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-browser-instance-as-previous-api" }
>;

async function setBrowserInstanceAsPreviousApi(
  db: Db,
  body: PreviousApiBrowserInstanceAction,
  signal: AbortSignal,
) {
  // The previous API created provider sessions with resizing disabled. Its
  // insert receives the migration's false/default 1440x900 resize state.
  const [updated] = await db
    .update(browserSessionInstances)
    .set({ resizable: false })
    .where(
      and(
        eq(browserSessionInstances.browserSessionId, body.browser_id),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .returning({
      providerSessionId: browserSessionInstances.providerSessionId,
    });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected an active previous API browser instance");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function readBrowserProfileAsPreviousApi(
  db: Db,
  body: PreviousApiBrowserProfileAction,
  signal: AbortSignal,
) {
  // Keep this query limited to the columns and owner checks understood by the
  // API version immediately before browser_thread_profiles existed.
  const [browser] = await db
    .select({ browserProfileId: browserSessions.browserProfileId })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.id, body.browser_id),
        eq(browserSessions.orgId, body.org_id),
        eq(browserSessions.userId, body.user_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!browser) {
    throw new Error("Expected a browser session for previous API read");
  }
  const [profile] = await db
    .select({
      id: browserProfiles.id,
      providerProfileId: browserProfiles.providerProfileId,
    })
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.id, browser.browserProfileId),
        eq(browserProfiles.orgId, body.org_id),
        eq(browserProfiles.userId, body.user_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!profile) {
    throw new Error("Expected a browser profile for previous API read");
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      previous_api_browser_profile: {
        browser_profile_id: profile.id,
        provider_profile_id: profile.providerProfileId,
      },
    },
  };
}

type CompatibilityFixtureAction =
  | LegacyArtifactCatalogFileAction
  | PreviousApiComputerAccessAction
  | PreviousApiRunnerJobContextProfileAction
  | PreviousApiBrowserProfileAction
  | PreviousApiBrowserInstanceAction
  | ConnectorPermissionBaselineMutationAction;

function isCompatibilityFixtureAction(
  body: TestRuntimeStateActionBody,
): body is CompatibilityFixtureAction {
  return [
    "insert-legacy-artifact-catalog-file",
    "set-computer-use-host-as-previous-api",
    "set-runner-job-context-profile-as-previous-api",
    "read-browser-profile-as-previous-api",
    "set-browser-instance-as-previous-api",
    "mutate-runner-job-connector-permission-baseline",
  ].includes(body.action);
}

async function compatibilityFixtureActionResponse(
  db: Db,
  body: CompatibilityFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "insert-legacy-artifact-catalog-file": {
      return await insertLegacyArtifactCatalogFile(db, body, signal);
    }
    case "set-computer-use-host-as-previous-api": {
      return await setComputerUseHostAsPreviousApi(db, body, signal);
    }
    case "set-runner-job-context-profile-as-previous-api": {
      return await setRunnerJobContextProfileAsPreviousApi(db, body, signal);
    }
    case "read-browser-profile-as-previous-api": {
      return await readBrowserProfileAsPreviousApi(db, body, signal);
    }
    case "set-browser-instance-as-previous-api": {
      return await setBrowserInstanceAsPreviousApi(db, body, signal);
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
    if (isStorageStateAction(body)) {
      return await storageStateActionResponse(db, body, signal);
    }
    if (isTimingStateAction(body)) {
      return await timingStateActionResponse(db, body, signal);
    }
    if (isThreadSessionStateAction(body)) {
      return await threadSessionStateActionResponse(db, body, signal);
    }
    if (isCompatibilityFixtureAction(body)) {
      return await compatibilityFixtureActionResponse(db, body, signal);
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
