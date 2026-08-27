import {
  getVm0BuiltInModelRouteCandidates,
  getVm0Vendor,
  MODEL_PROVIDER_TYPES,
} from "@okouai/api-contracts/contracts/model-providers";
import { command } from "ccstate";
import {
  testRuntimeStateContract,
  type TestRuntimeStateActionBody,
} from "@okouai/api-contracts/contracts/test-runtime-state";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { compatibleStoredExecutionContextSchema } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import {
  browserSessionTabSnapshots,
  browserSessions,
} from "@okouai/db/schema/browser-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import { hostedSites } from "@okouai/db/schema/hosted-site";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { officialWorkflowDefinitionRevisions } from "@okouai/db/schema/official-workflow-catalog";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import {
  and,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { closeDbPool } from "../../lib/db";
import { executeRawRows } from "../../lib/db-raw-rows";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { testOverride } from "../../lib/singleton";
import type { RouteEntry } from "../route-entry";
import {
  createDeferredPromise,
  onRejection,
  settleIncludingAbort,
} from "../utils";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../services/built-in-model-key-fixture";
import {
  resolveBuiltInModelRuntimeRoute,
  type BuiltInModelRuntimeRoute,
} from "../services/built-in-model-runtime-route.service";
import { browserScreenshotSchemaAvailable } from "../services/browser-screenshot-schema.service";
import { usagePackInvitationPurchaseSchemaAvailable } from "../services/usage-pack-invitation-purchase.service";
import { usagePackPurchaseSerializationSchemaAvailable } from "../services/usage-pack-subscription.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { writeRunMetadata } from "../services/agent-run-metadata-write.service";
import { saveRunSummary } from "../services/run-summary.service";
import { steerRunNearTimeBudgetForTest } from "../services/cron-steer-run-time-budget.service";
import {
  acquireOfficialWorkflowRunCatalogAdmissionLock,
  clearOfficialWorkflowRunFinalAdmissionLockedHookForTest,
  clearOfficialWorkflowRunObservationResolvedHookForTest,
  resolveOfficialWorkflowRunObservation,
  setOfficialWorkflowRunFinalAdmissionLockedHookForTest,
  setOfficialWorkflowRunObservationResolvedHookForTest,
  validateOfficialWorkflowRunForInsert,
} from "../services/official-workflow-run.service";
import {
  clearOfficialWorkflowBootstrapRequirementHookForTest,
  setOfficialWorkflowBootstrapRequirementHookForTest,
  type OfficialWorkflowBootstrapRequirement,
} from "../services/agent-runs-create.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

// Test-only support actions for generic infrastructure fixtures.

const actionBody$ = bodyResultOf(testRuntimeStateContract.action);
const VM0_BUILT_IN_MODEL_KEY_FIXTURE_PREFIX = "vm0-key-runtime-fixture-";

interface OrgAdmissionLockGate {
  holderPid: number | null;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
  readonly release: () => void;
}

const orgAdmissionLockGate = testOverride<OrgAdmissionLockGate | null>(() => {
  return null;
});

type OfficialWorkflowRunGateKind =
  | "observation"
  | "final-admission"
  | "bootstrap-requirement";

interface OfficialWorkflowRunGate {
  readonly kind: OfficialWorkflowRunGateKind;
  arrivals: number;
  readonly backendPids: Set<number>;
  bootstrapRequirement: OfficialWorkflowBootstrapRequirement | null;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
  readonly release: () => void;
}

const officialWorkflowRunGate = testOverride<OfficialWorkflowRunGate | null>(
  () => {
    return null;
  },
);

const orgAdmissionLockHolderRowSchema = z.object({ holderPid: z.int() });
const orgAdmissionLockStateRowSchema = z.object({
  held: z.boolean(),
  waiting: z.boolean(),
});
const officialWorkflowRunGateBackendRowSchema = z.object({
  backendPid: z.int(),
});
const officialWorkflowRunGateLockStateRowSchema = z.object({
  sharedCatalogHolderCount: z.int().nonnegative(),
  exclusiveCatalogWaiterCount: z.int().nonnegative(),
  blockedWaiterCount: z.int().nonnegative(),
});
type RunSummaryFixtureAction = Extract<
  TestRuntimeStateActionBody,
  { action: "save-run-summary" }
>;

function isRunSummaryFixtureAction(
  body: TestRuntimeStateActionBody,
): body is RunSummaryFixtureAction {
  return body.action === "save-run-summary";
}

async function runSummaryFixtureActionResponse(
  db: Db,
  body: RunSummaryFixtureAction,
  signal: AbortSignal,
) {
  await saveRunSummary(
    db,
    {
      runId: body.run_id,
      triggerSource: body.trigger_source,
      prompt: body.prompt,
      resultText: body.result_text,
    },
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
}

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

function createOfficialWorkflowRunGate(
  kind: OfficialWorkflowRunGateKind,
  signal: AbortSignal,
): OfficialWorkflowRunGate {
  const released = createDeferredPromise<void>(signal);
  return {
    kind,
    arrivals: 0,
    backendPids: new Set<number>(),
    bootstrapRequirement: null,
    released,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  };
}

function clearOfficialWorkflowRunGateHooks(
  gate: OfficialWorkflowRunGate,
): void {
  switch (gate.kind) {
    case "observation": {
      clearOfficialWorkflowRunObservationResolvedHookForTest();
      break;
    }
    case "final-admission": {
      clearOfficialWorkflowRunFinalAdmissionLockedHookForTest();
      break;
    }
    case "bootstrap-requirement": {
      clearOfficialWorkflowBootstrapRequirementHookForTest();
      break;
    }
  }
  if (officialWorkflowRunGate.get() === gate) {
    officialWorkflowRunGate.clear();
  }
}

async function waitAtOfficialWorkflowRunGate(
  gate: OfficialWorkflowRunGate,
): Promise<void> {
  gate.arrivals++;
  await gate.released.promise;
}

async function holdOfficialWorkflowRunGate(
  kind: OfficialWorkflowRunGateKind,
  signal: AbortSignal,
): Promise<void> {
  if (officialWorkflowRunGate.get()) {
    throw new Error("An Official Workflow Run gate is already active");
  }
  const gate = createOfficialWorkflowRunGate(kind, signal);
  officialWorkflowRunGate.set(gate);
  switch (kind) {
    case "observation": {
      setOfficialWorkflowRunObservationResolvedHookForTest(async () => {
        await waitAtOfficialWorkflowRunGate(gate);
      });
      break;
    }
    case "final-admission": {
      setOfficialWorkflowRunFinalAdmissionLockedHookForTest(
        async (_observation, tx) => {
          const rows = await executeRawRows(
            tx,
            sql`SELECT pg_backend_pid() AS "backendPid"`,
            officialWorkflowRunGateBackendRowSchema,
          );
          const backend = rows[0];
          if (!backend) {
            throw new Error("Failed to read the Official Workflow Run backend");
          }
          gate.backendPids.add(backend.backendPid);
          await waitAtOfficialWorkflowRunGate(gate);
        },
      );
      break;
    }
    case "bootstrap-requirement": {
      setOfficialWorkflowBootstrapRequirementHookForTest(
        async (requirement) => {
          gate.bootstrapRequirement = requirement;
          await waitAtOfficialWorkflowRunGate(gate);
        },
      );
      break;
    }
  }

  await onRejection(gate.released.promise, () => {
    clearOfficialWorkflowRunGateHooks(gate);
  });
  signal.throwIfAborted();
  clearOfficialWorkflowRunGateHooks(gate);
}

function officialWorkflowBootstrapQueueFirstKind(
  requirement: OfficialWorkflowBootstrapRequirement,
): "user_message" | "automation_event" | null {
  if (
    requirement.queueFirstKind === null ||
    requirement.queueFirstKind === "user_message" ||
    requirement.queueFirstKind === "automation_event"
  ) {
    return requirement.queueFirstKind;
  }
  throw new Error("Unexpected Official Workflow queue-first source");
}

async function readOfficialWorkflowRunGateLockState(
  db: Db,
  gate: OfficialWorkflowRunGate,
  signal: AbortSignal,
): Promise<{
  readonly sharedCatalogHolderCount: number;
  readonly exclusiveCatalogWaiterCount: number;
  readonly blockedWaiterCount: number;
}> {
  const backendPids = [...gate.backendPids];
  if (backendPids.length === 0) {
    return {
      sharedCatalogHolderCount: 0,
      exclusiveCatalogWaiterCount: 0,
      blockedWaiterCount: 0,
    };
  }
  const backendPidList = sql.join(
    backendPids.map((backendPid) => {
      return sql`${backendPid}`;
    }),
    sql`, `,
  );
  const rows = await executeRawRows(
    db,
    sql`
      SELECT
        (
          SELECT COUNT(DISTINCT held.pid)::integer
          FROM pg_locks held
          WHERE
            held.pid IN (${backendPidList})
            AND held.locktype = 'advisory'
            AND held.mode = 'ShareLock'
            AND held.granted
        ) AS "sharedCatalogHolderCount",
        (
          SELECT COUNT(DISTINCT waiting.pid)::integer
          FROM pg_locks held
          INNER JOIN pg_locks waiting
            ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid IS NOT DISTINCT FROM held.classid
            AND waiting.objid IS NOT DISTINCT FROM held.objid
            AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          WHERE
            held.pid IN (${backendPidList})
            AND held.locktype = 'advisory'
            AND held.mode = 'ShareLock'
            AND held.granted
            AND waiting.mode = 'ExclusiveLock'
            AND NOT waiting.granted
        ) AS "exclusiveCatalogWaiterCount",
        (
          SELECT COUNT(DISTINCT waiting.pid)::integer
          FROM pg_stat_activity waiting
          WHERE EXISTS (
            SELECT 1
            FROM unnest(pg_blocking_pids(waiting.pid)) AS blocker(pid)
            WHERE blocker.pid IN (${backendPidList})
          )
        ) AS "blockedWaiterCount"
    `,
    officialWorkflowRunGateLockStateRowSchema,
  );
  signal.throwIfAborted();
  const state = rows[0];
  if (!state) {
    throw new Error("Failed to read the Official Workflow Run lock state");
  }
  return state;
}

async function readOfficialWorkflowRunGateState(db: Db, signal: AbortSignal) {
  const gate = officialWorkflowRunGate.get();
  if (!gate) {
    return null;
  }
  const lockState = await readOfficialWorkflowRunGateLockState(
    db,
    gate,
    signal,
  );
  return {
    gate: gate.kind,
    arrivals: gate.arrivals,
    shared_catalog_holder_count: lockState.sharedCatalogHolderCount,
    exclusive_catalog_waiter_count: lockState.exclusiveCatalogWaiterCount,
    blocked_waiter_count: lockState.blockedWaiterCount,
    bootstrap_requirement: gate.bootstrapRequirement
      ? {
          workflow_ids: [...gate.bootstrapRequirement.workflowIds],
          queue_first_kind: officialWorkflowBootstrapQueueFirstKind(
            gate.bootstrapRequirement,
          ),
          workflow_automation_id:
            gate.bootstrapRequirement.workflowAutomationId,
        }
      : null,
  };
}

async function seedVm0BuiltInDefaultModelKey(
  db: Db,
  fixtureId: string,
  signal: AbortSignal,
): Promise<string> {
  const selectedModel = MODEL_PROVIDER_TYPES.vm0.defaultModel;
  if (!selectedModel) {
    throw new Error("Expected vm0 to define a default model");
  }
  return await seedVm0BuiltInModelKey(db, fixtureId, selectedModel, signal);
}

async function seedVm0BuiltInModelKey(
  db: Db,
  fixtureId: string,
  selectedModel: string,
  signal: AbortSignal,
): Promise<string> {
  const vendor = getVm0Vendor(selectedModel);
  await acquireBuiltInModelKeyFixture(db, fixtureId, [
    {
      vendor,
      apiKey: `${VM0_BUILT_IN_MODEL_KEY_FIXTURE_PREFIX}${fixtureId}`,
    },
  ]);
  signal.throwIfAborted();
  return selectedModel;
}

async function seedVm0BuiltInModelCandidateKeys(
  db: Db,
  fixtureId: string,
  selectedModel: string,
  signal: AbortSignal,
): Promise<string> {
  const vendors = new Set(
    getVm0BuiltInModelRouteCandidates(selectedModel).map((candidate) => {
      return candidate.vendor;
    }),
  );
  await acquireBuiltInModelKeyFixture(
    db,
    fixtureId,
    [...vendors].map((vendor) => {
      return {
        vendor,
        apiKey: `${VM0_BUILT_IN_MODEL_KEY_FIXTURE_PREFIX}${fixtureId}-${vendor}`,
      };
    }),
  );
  signal.throwIfAborted();
  return selectedModel;
}

async function deleteVm0BuiltInModelKey(
  db: Db,
  fixtureId: string,
  signal: AbortSignal,
): Promise<void> {
  await releaseBuiltInModelKeyFixture(db, fixtureId);
  signal.throwIfAborted();
}

function serializeBuiltInModelRuntimeRoute(route: BuiltInModelRuntimeRoute) {
  return {
    provider_type: route.providerType,
    upstream_model: route.upstreamModel,
    model_key_id: route.modelKeyId,
  };
}

type BuiltInModelAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "seed-vm0-built-in-default-model-key"
      | "seed-vm0-built-in-model-key"
      | "seed-vm0-built-in-model-candidate-keys"
      | "delete-vm0-built-in-model-key"
      | "resolve-vm0-built-in-model-route"
      | "set-vm0-built-in-candidate-cooldown"
      | "delete-vm0-built-in-candidate-cooldown";
  }
>;

function isVm0BuiltInModelAction(
  body: TestRuntimeStateActionBody,
): body is BuiltInModelAction {
  return [
    "seed-vm0-built-in-default-model-key",
    "seed-vm0-built-in-model-key",
    "seed-vm0-built-in-model-candidate-keys",
    "delete-vm0-built-in-model-key",
    "resolve-vm0-built-in-model-route",
    "set-vm0-built-in-candidate-cooldown",
    "delete-vm0-built-in-candidate-cooldown",
  ].includes(body.action);
}

type SetVm0BuiltInCandidateCooldownAction = Extract<
  BuiltInModelAction,
  { action: "set-vm0-built-in-candidate-cooldown" }
>;

async function setVm0BuiltInCandidateCooldown(
  db: Db,
  body: SetVm0BuiltInCandidateCooldownAction,
): Promise<void> {
  const unavailableUntil = new Date(body.unavailable_until);
  await db
    .insert(builtInModelCandidateCooldown)
    .values({
      selectedModel: body.selected_model,
      providerType: body.provider_type,
      upstreamModel: body.upstream_model,
      unavailableUntil,
    })
    .onConflictDoUpdate({
      target: [
        builtInModelCandidateCooldown.selectedModel,
        builtInModelCandidateCooldown.providerType,
        builtInModelCandidateCooldown.upstreamModel,
      ],
      set: { unavailableUntil },
    });
}

type DeleteVm0BuiltInCandidateCooldownAction = Extract<
  BuiltInModelAction,
  { action: "delete-vm0-built-in-candidate-cooldown" }
>;

async function deleteVm0BuiltInCandidateCooldown(
  db: Db,
  body: DeleteVm0BuiltInCandidateCooldownAction,
): Promise<void> {
  await db
    .delete(builtInModelCandidateCooldown)
    .where(
      and(
        eq(builtInModelCandidateCooldown.selectedModel, body.selected_model),
        eq(builtInModelCandidateCooldown.providerType, body.provider_type),
        eq(builtInModelCandidateCooldown.upstreamModel, body.upstream_model),
      ),
    );
}

async function vm0BuiltInModelActionResponse(
  db: Db,
  body: BuiltInModelAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-vm0-built-in-default-model-key": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedVm0BuiltInDefaultModelKey(
            db,
            body.fixture_id,
            signal,
          ),
        },
      };
    }
    case "seed-vm0-built-in-model-key": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedVm0BuiltInModelKey(
            db,
            body.fixture_id,
            body.selected_model,
            signal,
          ),
        },
      };
    }
    case "seed-vm0-built-in-model-candidate-keys": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedVm0BuiltInModelCandidateKeys(
            db,
            body.fixture_id,
            body.selected_model,
            signal,
          ),
        },
      };
    }
    case "delete-vm0-built-in-model-key": {
      await deleteVm0BuiltInModelKey(db, body.fixture_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "resolve-vm0-built-in-model-route": {
      const route = await resolveBuiltInModelRuntimeRoute(
        db,
        body.selected_model,
        body.fallback_enabled,
      );
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          built_in_model_route: route
            ? serializeBuiltInModelRuntimeRoute(route)
            : null,
        },
      };
    }
    case "set-vm0-built-in-candidate-cooldown": {
      await setVm0BuiltInCandidateCooldown(db, body);
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "delete-vm0-built-in-candidate-cooldown": {
      await deleteVm0BuiltInCandidateCooldown(db, body);
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

async function clearRunApiStart(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const [cleared] = await writeRunMetadata(db, {
    patch: { apiStartedAt: null },
    where: eq(agentRuns.id, runId),
  });
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
    .select({ apiStartedAt: agentRuns.apiStartedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    throw new Error("Expected a Zero run timing row");
  }
  return run.apiStartedAt?.toISOString() ?? null;
}

/**
 * A running run cannot reach the time-budget boundary during an integration
 * test, so the test-only route moves exactly its owned run into that state.
 */
async function setRunTimeBudgetElapsed(
  db: Db,
  runId: string,
  elapsedMs: number,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = new Date(nowDate().getTime() - elapsedMs);
  const [updated] = await db
    .update(agentRuns)
    .set({ startedAt })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected one running time-budget run fixture");
  }
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

async function readThreadSessionConversation(
  db: Db,
  threadId: string,
  signal: AbortSignal,
): Promise<{
  readonly agent_session_id: string | null;
  readonly conversation_id: string | null;
  readonly conversation_run_id: string | null;
}> {
  const [thread] = await db
    .select({
      agentSessionId: chatThreads.agentSessionId,
      conversationId: agentSessions.conversationId,
      conversationRunId: conversations.runId,
    })
    .from(chatThreads)
    .leftJoin(agentSessions, eq(chatThreads.agentSessionId, agentSessions.id))
    .leftJoin(conversations, eq(agentSessions.conversationId, conversations.id))
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Expected a chat thread session binding row");
  }
  return {
    agent_session_id: thread.agentSessionId,
    conversation_id: thread.conversationId,
    conversation_run_id: thread.conversationRunId,
  };
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
      const rows = await writeRunMetadata(db, {
        patch: { autonomyBudget: body.autonomy_budget },
        where: eq(agentRuns.id, body.run_id),
      });
      signal.throwIfAborted();
      if (rows.length === 0) {
        throw new Error("Expected the autonomy-budget run fixture");
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-run-autonomy-budget": {
      const [run] = await db
        .select({ autonomyBudget: agentRuns.autonomyBudget })
        .from(agentRuns)
        .where(eq(agentRuns.id, body.run_id))
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
        .update(workflowAutomations)
        .set({ autonomyBudget: body.autonomy_budget })
        .where(eq(workflowAutomations.id, body.automation_id))
        .returning({ id: workflowAutomations.id });
      signal.throwIfAborted();
      if (!automation) {
        throw new Error("Expected the autonomy-budget automation fixture");
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-workflow-automation-autonomy-state": {
      const [automation] = await db
        .select({
          autonomyBudget: workflowAutomations.autonomyBudget,
          enabled: workflowAutomations.enabled,
          lastRunId: workflowAutomations.lastRunId,
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, body.automation_id))
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
          runId: agentRuns.id,
          autonomyBudget: agentRuns.autonomyBudget,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.workflowAutomationId, body.automation_id),
            isNotNull(agentRuns.triggerSource),
          ),
        )
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

type ConnectorRuntimeTargetsMutationAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-runner-job-connector-runtime-targets" }
>;

async function setRunnerJobConnectorRuntimeTargets(
  db: Db,
  body: ConnectorRuntimeTargetsMutationAction,
  signal: AbortSignal,
): Promise<void> {
  const [updated] = await db
    .update(runnerJobQueue)
    .set({
      executionContext: sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{connectorRuntimeTargets}',
        ${JSON.stringify(body.connector_runtime_targets)}::jsonb,
        true
      )`,
    })
    .where(eq(runnerJobQueue.runId, body.run_id))
    .returning({ runId: runnerJobQueue.runId });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a queued runner job for runtime targets");
  }
}

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
type ReadRunLaunchSnapshotAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-run-launch-snapshot" }
>;
type ReadBrowserScreenshotSchemaStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-browser-screenshot-schema-state" }
>;
type ReadUsagePackInvitationSchemaStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-usage-pack-invitation-schema-state" }
>;
type ReadUsagePackPurchaseSerializationSchemaStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-usage-pack-purchase-serialization-schema-state" }
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
  | ReadRunLaunchSnapshotAction
  | ReadBrowserScreenshotSchemaStateAction
  | ReadUsagePackInvitationSchemaStateAction
  | ReadUsagePackPurchaseSerializationSchemaStateAction
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
    case "read-run-claim-owner":
    case "read-run-launch-snapshot": {
      return true;
    }
    case "read-browser-screenshot-schema-state": {
      return true;
    }
    case "read-usage-pack-invitation-schema-state": {
      return true;
    }
    case "read-usage-pack-purchase-serialization-schema-state": {
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
    case "read-run-launch-snapshot": {
      const [run] = await db
        .select({ launchSnapshot: agentRuns.launchSnapshot })
        .from(agentRuns)
        .where(eq(agentRuns.id, body.run_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          run_launch_snapshot: {
            exists: run !== undefined,
            launch_snapshot: run?.launchSnapshot ?? null,
          },
        },
      };
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
    case "read-usage-pack-invitation-schema-state": {
      const available = await usagePackInvitationPurchaseSchemaAvailable(db);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          usage_pack_invitation_schema_available: available,
        },
      };
    }
    case "read-usage-pack-purchase-serialization-schema-state": {
      const available = await usagePackPurchaseSerializationSchemaAvailable(db);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          usage_pack_purchase_serialization_schema_available: available,
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
  {
    action:
      | "clear-run-api-start"
      | "read-run-api-start"
      | "steer-run-time-budget";
  }
>;

function isTimingStateAction(
  body: TestRuntimeStateActionBody,
): body is TimingStateAction {
  return (
    body.action === "clear-run-api-start" ||
    body.action === "read-run-api-start" ||
    body.action === "steer-run-time-budget"
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
    case "steer-run-time-budget": {
      await setRunTimeBudgetElapsed(db, body.run_id, body.elapsed_ms, signal);
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          run_time_budget: await steerRunNearTimeBudgetForTest(
            db,
            body.run_id,
            signal,
          ),
        },
      };
    }
  }
}

type ThreadSessionStateAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "read-thread-session-binding"
      | "read-thread-session-conversation"
      | "clear-thread-session-binding";
  }
>;

function isThreadSessionStateAction(
  body: TestRuntimeStateActionBody,
): body is ThreadSessionStateAction {
  return (
    body.action === "read-thread-session-binding" ||
    body.action === "read-thread-session-conversation" ||
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
    case "read-thread-session-conversation": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          thread_session_conversation: await readThreadSessionConversation(
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
      publicBrand: "vm0",
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
        "public_brand",
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
        'vm0',
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
  // column and execution-context JSON. The current reader must strip the
  // internal routing field before publishing the claim.
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
  | ConnectorPermissionBaselineMutationAction;

type CustomConnectorAuthTemplateFixtureAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-custom-connector-auth-template-fixture" }
>;

function isCustomConnectorAuthTemplateFixtureAction(
  body: TestRuntimeStateActionBody,
): body is CustomConnectorAuthTemplateFixtureAction {
  return body.action === "set-custom-connector-auth-template-fixture";
}

async function customConnectorAuthTemplateFixtureActionResponse(
  db: Db,
  body: CustomConnectorAuthTemplateFixtureAction,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(orgCustomConnectors)
    .set({
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: body.value_template,
        },
      ],
    })
    .where(eq(orgCustomConnectors.id, body.connector_id))
    .returning({ id: orgCustomConnectors.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a Custom Connector definition fixture");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

type ChatEventFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "advance-chat-event-sequence-as-previous-api"
      | "read-chat-event-rows-as-previous-api"
      | "read-chat-event-snapshot-head"
      | "set-chat-event-snapshot-head-version"
      | "simulate-chat-event-snapshot-rolling-deploy";
  }
>;

function isChatEventFixtureAction(
  body: TestRuntimeStateActionBody,
): body is ChatEventFixtureAction {
  return (
    body.action === "advance-chat-event-sequence-as-previous-api" ||
    body.action === "read-chat-event-rows-as-previous-api" ||
    body.action === "read-chat-event-snapshot-head" ||
    body.action === "set-chat-event-snapshot-head-version" ||
    body.action === "simulate-chat-event-snapshot-rolling-deploy"
  );
}

async function setChatEventSnapshotHeadVersionFixture(
  db: Db,
  body: Extract<
    TestRuntimeStateActionBody,
    { action: "set-chat-event-snapshot-head-version" }
  >,
  projection: ChatEventSnapshotProjection,
  signal: AbortSignal,
) {
  const [pointer] = await db
    .select({ id: chatEventSnapshots.id })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, body.thread_id),
        eq(chatEventSnapshots.projection, projection),
      ),
    )
    .orderBy(
      desc(chatEventSnapshots.archiveSchemaVersion),
      desc(chatEventSnapshots.lastSeqId),
      desc(chatEventSnapshots.createdAt),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!pointer) {
    throw new Error("set-chat-event-snapshot-head-version missing pointer");
  }
  const updated = await db
    .update(chatEventSnapshots)
    .set({
      archiveSchemaVersion: body.archive_schema_version,
      ...(body.archive_schema_version < CURRENT_CHAT_EVENT_SCHEMA_VERSION
        ? { terminalEventId: null, terminalSeqId: null }
        : body.last_seq_id === 0
          ? { terminalEventId: null, terminalSeqId: 0 }
          : {}),
      ...(body.object_key === undefined ? {} : { objectKey: body.object_key }),
      ...(body.last_seq_id === undefined
        ? {}
        : { lastSeqId: body.last_seq_id }),
      ...(body.last_event_id === undefined
        ? {}
        : { lastEventId: body.last_event_id }),
    })
    .where(eq(chatEventSnapshots.id, pointer.id))
    .returning({ id: chatEventSnapshots.id });
  signal.throwIfAborted();
  if (updated.length === 0) {
    throw new Error("set-chat-event-snapshot-head-version missing pointer");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function simulateChatEventSnapshotRollingDeployFixture(
  db: Db,
  body: Extract<
    TestRuntimeStateActionBody,
    { action: "simulate-chat-event-snapshot-rolling-deploy" }
  >,
  signal: AbortSignal,
) {
  const result = await db.transaction(async (tx) => {
    await tx.insert(chatEventSnapshots).values({
      chatThreadId: body.thread_id,
      lastSeqId: body.v6_pointer.last_seq_id,
      lastEventId: body.v6_pointer.last_event_id,
      archiveSchemaVersion: PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
      projection: CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
      objectKey: body.v6_pointer.object_key,
    });
    const updated = await tx
      .update(chatEventSnapshots)
      .set({
        lastSeqId: body.v7_pointer.last_seq_id,
        lastEventId: body.v7_pointer.last_event_id,
        terminalSeqId: body.v7_pointer.terminal_seq_id,
        terminalEventId: body.v7_pointer.terminal_event_id,
        objectKey: body.v7_pointer.object_key,
      })
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, body.thread_id),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          eq(
            chatEventSnapshots.projection,
            CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
          ),
        ),
      )
      .returning({ id: chatEventSnapshots.id });
    if (updated.length !== 1) {
      throw new Error("Expected exactly one canonical V7 snapshot head");
    }
    return await tx
      .delete(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, body.thread_id),
          gt(chatEvents.seqId, body.v7_pointer.last_seq_id),
          lte(chatEvents.seqId, body.v6_pointer.last_seq_id),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      deleted_chat_event_rows: result.length,
    },
  };
}

async function readChatEventRowsAsPreviousApiFixture(
  db: Db,
  body: Extract<
    TestRuntimeStateActionBody,
    { action: "read-chat-event-rows-as-previous-api" }
  >,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      runId: chatEvents.runId,
      revokesEventId: chatEvents.revokesEventId,
      eventType: chatEvents.eventType,
      payload: chatEvents.payload,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      runEventSequenceNumber: chatEvents.runEventSequenceNumber,
      runEventId: chatEvents.runEventId,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(eq(chatEvents.chatThreadId, body.thread_id))
    .orderBy(chatEvents.seqId);
  signal.throwIfAborted();
  // This is the exact strict raw/snapshot reader shape from the API version
  // immediately before the private Official queue column was introduced.
  const previousApiRows = rows.map((row) => {
    return chatEventRowSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
    });
  });
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      previous_api_chat_event_rows: previousApiRows.map((row) => {
        return {
          id: row.id,
          event_type: row.eventType,
          revokes_event_id: row.revokesEventId,
          payload_keys:
            row.payload === null ? [] : Object.keys(row.payload).sort(),
        };
      }),
    },
  };
}

async function chatEventFixtureActionResponse(
  db: Db,
  body: ChatEventFixtureAction,
  signal: AbortSignal,
) {
  const projection =
    "projection" in body && body.projection !== undefined
      ? body.projection
      : CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION;
  if (body.action === "advance-chat-event-sequence-as-previous-api") {
    const [updated] = await db
      .update(chatThreads)
      .set({
        lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + ${body.count}`,
      })
      .where(eq(chatThreads.id, body.thread_id))
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    if (!updated) {
      throw new Error(
        "advance-chat-event-sequence-as-previous-api missing thread",
      );
    }
    return { status: 200 as const, body: { ok: true as const } };
  }
  if (body.action === "read-chat-event-rows-as-previous-api") {
    return await readChatEventRowsAsPreviousApiFixture(db, body, signal);
  }
  if (body.action === "set-chat-event-snapshot-head-version") {
    return await setChatEventSnapshotHeadVersionFixture(
      db,
      body,
      projection,
      signal,
    );
  }
  if (body.action === "simulate-chat-event-snapshot-rolling-deploy") {
    return await simulateChatEventSnapshotRollingDeployFixture(
      db,
      body,
      signal,
    );
  }
  const [[head], [snapshotCount]] = await Promise.all([
    db
      .select({
        archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
        lastEventId: chatEventSnapshots.lastEventId,
        lastSeqId: chatEventSnapshots.lastSeqId,
        terminalEventId: chatEventSnapshots.terminalEventId,
        terminalSeqId: chatEventSnapshots.terminalSeqId,
        objectKey: chatEventSnapshots.objectKey,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, body.thread_id),
          eq(chatEventSnapshots.projection, projection),
        ),
      )
      .orderBy(
        desc(chatEventSnapshots.archiveSchemaVersion),
        desc(chatEventSnapshots.lastSeqId),
        desc(chatEventSnapshots.createdAt),
      )
      .limit(1),
    db
      .select({ value: count() })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, body.thread_id),
          eq(chatEventSnapshots.projection, projection),
        ),
      ),
  ]);
  signal.throwIfAborted();
  if (!snapshotCount) {
    throw new Error("read-chat-event-snapshot-head missing snapshot count");
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      chat_event_snapshot_head: head
        ? {
            archive_schema_version: head.archiveSchemaVersion,
            last_event_id: head.lastEventId,
            last_seq_id: head.lastSeqId,
            terminal_event_id: head.terminalEventId,
            terminal_seq_id: head.terminalSeqId,
            object_key: head.objectKey,
            snapshot_count: snapshotCount.value,
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
    case "mutate-runner-job-connector-permission-baseline": {
      await mutateRunnerJobConnectorPermissionBaseline(db, body, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

type ReadOfficialWorkflowRunStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-official-workflow-run-state" }
>;
type ReadAgentRunFamilyCountsAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-agent-run-family-counts" }
>;
type CorruptOfficialWorkflowRevisionPayloadAction = Extract<
  TestRuntimeStateActionBody,
  { action: "corrupt-official-workflow-revision-payload" }
>;
type SetOfficialWorkflowAutomationAdmissionStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-official-workflow-automation-admission-state" }
>;
type RetargetWorkflowAutomationAction = Extract<
  TestRuntimeStateActionBody,
  { action: "retarget-workflow-automation" }
>;
type AssertOfficialWorkflowAutomationFinalAdmissionRejectedAction = Extract<
  TestRuntimeStateActionBody,
  {
    action: "assert-official-workflow-automation-final-admission-rejected";
  }
>;
type OfficialWorkflowRunFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "read-official-workflow-run-state"
      | "read-agent-run-family-counts"
      | "corrupt-official-workflow-revision-payload"
      | "set-official-workflow-automation-admission-state"
      | "retarget-workflow-automation"
      | "assert-official-workflow-automation-final-admission-rejected"
      | "hold-official-workflow-run-gate"
      | "read-official-workflow-run-gate-state"
      | "release-official-workflow-run-gate";
  }
>;

function isOfficialWorkflowRunFixtureAction(
  body: TestRuntimeStateActionBody,
): body is OfficialWorkflowRunFixtureAction {
  return [
    "read-official-workflow-run-state",
    "read-agent-run-family-counts",
    "corrupt-official-workflow-revision-payload",
    "set-official-workflow-automation-admission-state",
    "retarget-workflow-automation",
    "assert-official-workflow-automation-final-admission-rejected",
    "hold-official-workflow-run-gate",
    "read-official-workflow-run-gate-state",
    "release-official-workflow-run-gate",
  ].includes(body.action);
}

async function readOfficialWorkflowRunStateActionResponse(
  db: Db,
  body: ReadOfficialWorkflowRunStateAction,
  signal: AbortSignal,
) {
  const [run] = await db
    .select({
      status: agentRuns.status,
      provenance: agentRuns.officialWorkflowProvenance,
      storageMounts: agentRuns.storageMounts,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, body.run_id))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return {
      status: 200 as const,
      body: { ok: true as const, official_workflow_run_state: null },
    };
  }
  const [[runnerJobs], [callbacks]] = await Promise.all([
    db
      .select({ value: count() })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, body.run_id)),
    db
      .select({ value: count() })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, body.run_id)),
  ]);
  signal.throwIfAborted();
  if (!runnerJobs || !callbacks) {
    throw new Error("Official Workflow Run state count is incomplete");
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      official_workflow_run_state: {
        status: run.status,
        provenance: run.provenance,
        storage_mounts:
          run.storageMounts?.map((mount) => {
            return {
              org_id: mount.orgId,
              user_id: mount.userId,
              name: mount.name,
              storage_id: mount.storageId,
              ...(mount.version ? { version: mount.version } : {}),
              mount_path: mount.mountPath,
              ...(mount.writeback === undefined
                ? {}
                : { writeback: mount.writeback }),
            };
          }) ?? null,
        runner_job_count: runnerJobs.value,
        callback_count: callbacks.value,
      },
    },
  };
}

async function readAgentRunFamilyCountsActionResponse(
  db: Db,
  body: ReadAgentRunFamilyCountsAction,
  signal: AbortSignal,
) {
  const agentRunJoin = eq(agentRuns.sessionId, agentSessions.id);
  const agentCondition = eq(agentSessions.agentId, body.agent_id);
  const [[runs], [callbacks], [runnerJobs], [launchQueue]] = await Promise.all([
    db
      .select({ value: count() })
      .from(agentRuns)
      .innerJoin(agentSessions, agentRunJoin)
      .where(agentCondition),
    db
      .select({ value: count() })
      .from(agentRunCallbacks)
      .innerJoin(agentRuns, eq(agentRunCallbacks.runId, agentRuns.id))
      .innerJoin(agentSessions, agentRunJoin)
      .where(agentCondition),
    db
      .select({ value: count() })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .innerJoin(agentSessions, agentRunJoin)
      .where(agentCondition),
    db
      .select({ value: count() })
      .from(agentRunQueue)
      .innerJoin(agentRuns, eq(agentRunQueue.runId, agentRuns.id))
      .innerJoin(agentSessions, agentRunJoin)
      .where(agentCondition),
  ]);
  signal.throwIfAborted();
  if (!runs || !callbacks || !runnerJobs || !launchQueue) {
    throw new Error("Agent Run-family count is incomplete");
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      agent_run_family_counts: {
        run_count: runs.value,
        callback_count: callbacks.value,
        runner_job_count: runnerJobs.value,
        launch_queue_count: launchQueue.value,
      },
    },
  };
}

async function corruptOfficialWorkflowRevisionPayloadActionResponse(
  db: Db,
  body: CorruptOfficialWorkflowRevisionPayloadAction,
  signal: AbortSignal,
) {
  const updated = await db
    .update(officialWorkflowDefinitionRevisions)
    .set({ payload: sql`'{}'::jsonb` })
    .where(
      eq(
        officialWorkflowDefinitionRevisions.definitionName,
        body.definition_name,
      ),
    )
    .returning({ revision: officialWorkflowDefinitionRevisions.revision });
  signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Official Workflow revision fixture is unavailable");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function setOfficialWorkflowAutomationAdmissionStateActionResponse(
  db: Db,
  body: SetOfficialWorkflowAutomationAdmissionStateAction,
  signal: AbortSignal,
) {
  const updated = await db
    .update(workflowAutomations)
    .set({
      officialReconciliationStatus: body.reconciliation_status,
      ...(body.applied_fingerprint
        ? { officialAppliedFingerprint: body.applied_fingerprint }
        : {}),
    })
    .where(eq(workflowAutomations.id, body.automation_id))
    .returning({ id: workflowAutomations.id });
  signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Official Workflow Automation is unavailable");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function retargetWorkflowAutomationActionResponse(
  db: Db,
  body: RetargetWorkflowAutomationAction,
  signal: AbortSignal,
) {
  const updated = await db
    .update(workflowAutomations)
    .set({ workflowId: body.workflow_id })
    .where(eq(workflowAutomations.id, body.automation_id))
    .returning({ id: workflowAutomations.id });
  signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Workflow Automation is unavailable");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function assertOfficialWorkflowAutomationFinalAdmissionRejected(
  db: Db,
  body: AssertOfficialWorkflowAutomationFinalAdmissionRejectedAction,
  signal: AbortSignal,
) {
  const [workflow] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      definitionName: workflows.officialDefinitionName,
      orgId: workflows.orgId,
      userId: workflows.ownerUserId,
      agentId: workflows.agentId,
    })
    .from(workflows)
    .where(eq(workflows.id, body.official_workflow_id))
    .limit(1);
  signal.throwIfAborted();
  if (!workflow?.definitionName) {
    throw new Error("Official Workflow fixture is unavailable");
  }
  const observation = await resolveOfficialWorkflowRunObservation(
    db,
    [
      {
        workflowId: workflow.id,
        workflowName: workflow.name,
        definitionName: workflow.definitionName,
        mountPath: `/test/official-workflows/${workflow.id}`,
      },
    ],
    signal,
  );
  if (!observation) {
    throw new Error("Official Workflow observation is unavailable");
  }
  const rejection = await db.transaction(async (tx) => {
    await acquireOfficialWorkflowRunCatalogAdmissionLock(tx, observation);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${workflow.orgId}))`,
    );
    return await validateOfficialWorkflowRunForInsert(tx, {
      observation,
      orgId: workflow.orgId,
      userId: workflow.userId,
      agentId: workflow.agentId,
      automationId: body.automation_id,
      runStorageMounts: undefined,
      allowMissingMountsForFailedRun: true,
    });
  });
  signal.throwIfAborted();
  if (!rejection) {
    throw new Error("Mismatched Official Automation admission was accepted");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function officialWorkflowRunFixtureActionResponse(
  db: Db,
  body: OfficialWorkflowRunFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-official-workflow-run-state": {
      return await readOfficialWorkflowRunStateActionResponse(db, body, signal);
    }
    case "read-agent-run-family-counts": {
      return await readAgentRunFamilyCountsActionResponse(db, body, signal);
    }
    case "corrupt-official-workflow-revision-payload": {
      return await corruptOfficialWorkflowRevisionPayloadActionResponse(
        db,
        body,
        signal,
      );
    }
    case "set-official-workflow-automation-admission-state": {
      return await setOfficialWorkflowAutomationAdmissionStateActionResponse(
        db,
        body,
        signal,
      );
    }
    case "retarget-workflow-automation": {
      return await retargetWorkflowAutomationActionResponse(db, body, signal);
    }
    case "assert-official-workflow-automation-final-admission-rejected": {
      return await assertOfficialWorkflowAutomationFinalAdmissionRejected(
        db,
        body,
        signal,
      );
    }
    case "hold-official-workflow-run-gate": {
      await holdOfficialWorkflowRunGate(body.gate, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-official-workflow-run-gate-state": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          official_workflow_run_gate_state:
            await readOfficialWorkflowRunGateState(db, signal),
        },
      };
    }
    case "release-official-workflow-run-gate": {
      officialWorkflowRunGate.get()?.release();
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

async function specializedRuntimeFixtureActionResponse(
  db: Db,
  body: TestRuntimeStateActionBody,
  signal: AbortSignal,
) {
  if (isCustomConnectorAuthTemplateFixtureAction(body)) {
    return await customConnectorAuthTemplateFixtureActionResponse(
      db,
      body,
      signal,
    );
  }
  if (isOfficialWorkflowRunFixtureAction(body)) {
    return await officialWorkflowRunFixtureActionResponse(db, body, signal);
  }
  return null;
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
    if (isChatEventFixtureAction(body)) {
      return await chatEventFixtureActionResponse(db, body, signal);
    }
    if (isRunSummaryFixtureAction(body)) {
      return await runSummaryFixtureActionResponse(db, body, signal);
    }
    if (isCompatibilityFixtureAction(body)) {
      return await compatibilityFixtureActionResponse(db, body, signal);
    }
    if (isVm0BuiltInModelAction(body)) {
      return await vm0BuiltInModelActionResponse(db, body, signal);
    }
    const specializedFixture = await specializedRuntimeFixtureActionResponse(
      db,
      body,
      signal,
    );
    if (specializedFixture) {
      return specializedFixture;
    }
    switch (body.action) {
      case "mutate-runner-job-secret-value-environment-keys": {
        await mutateRunnerJobSecretValueEnvironmentKeys(
          db,
          body.run_id,
          body.mode,
          signal,
        );
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "set-runner-job-connector-runtime-targets": {
        await setRunnerJobConnectorRuntimeTargets(db, body, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-run-chat-tool-activity-decision": {
        const [run] = await db
          .select({
            runId: agentRuns.id,
            chatToolActivityEnabled: agentRuns.chatToolActivityEnabled,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, body.run_id))
          .limit(1);
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            run_chat_tool_activity_decision: run
              ? {
                  run_id: run.runId,
                  chat_tool_activity_enabled: run.chatToolActivityEnabled,
                }
              : null,
          },
        };
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
