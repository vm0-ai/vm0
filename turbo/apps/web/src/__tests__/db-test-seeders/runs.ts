import { and, eq, or, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { blobs } from "@vm0/db/schema/blob";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { sandboxTelemetry } from "@vm0/db/schema/sandbox-telemetry";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { initServices } from "../../lib/init-services";
import { uniqueId } from "../test-helpers";
import { generateCallbackSecret } from "../../lib/infra/callback/hmac";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import type {
  ArtifactSnapshotsPayload,
  ContextArtifact,
  VolumeVersionsSnapshot,
} from "../../lib/infra/checkpoint/types";

const TEST_SESSION_HISTORY_HASH =
  "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e";

/**
 * Resolve both orgId and agentComposeId from a compose version ID.
 *
 * @why-db-direct Seeders that insert agent_runs need agentComposeId to
 * seed the prerequisite agent_sessions row (agent_runs.session_id is NOT
 * NULL and FKs to agent_sessions).
 */
export async function getOrgAndComposeFromVersion(
  versionId: string,
): Promise<{ orgId: string; composeId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      orgId: agentComposes.orgId,
      composeId: agentComposes.id,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.id, agentComposeVersions.composeId),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  if (!row) {
    throw new Error(`Compose version ${versionId} not found`);
  }
  return row;
}

/**
 * Seed an agent_sessions row and return its id.
 *
 * @why-db-direct agent_runs.session_id is NOT NULL and FKs to
 * agent_sessions. Seeders that insert into agent_runs directly (bypassing
 * insertRunRecord / enqueueRun) must create the session row first.
 */
export async function ensureTestAgentSession(params: {
  userId: string;
  orgId: string;
  agentComposeId: string;
  conversationId?: string | null;
}): Promise<string> {
  initServices();
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      agentComposeId: params.agentComposeId,
      conversationId: params.conversationId ?? null,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to seed agent session");
  }
  return session.id;
}

/**
 * Create a run record directly in the database.
 * Internal helper used by seedTestRun.
 */
type CreateRunDirectOptions = {
  status?: string;
  prompt?: string;
  continuedFromSessionId?: string;
  scheduleId?: string;
  chatThreadId?: string;
  triggerSource?: string;
  createdAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  lastEventSequence?: number;
  additionalVolumes?: Array<{
    name: string;
    version?: string;
    mountPath: string;
  }>;
};

async function createRunDirect(
  userId: string,
  versionId: string,
  orgId: string,
  agentComposeId: string,
  options: CreateRunDirectOptions = {},
): Promise<{ id: string }> {
  const {
    status = "running",
    prompt = "test prompt",
    continuedFromSessionId,
    scheduleId = null,
    chatThreadId = null,
    triggerSource = "cli",
    createdAt,
    startedAt,
    completedAt,
    result,
    lastEventSequence,
    additionalVolumes = null,
  } = options;
  const sessionId = await ensureTestAgentSession({
    userId,
    orgId,
    agentComposeId,
  });
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status,
      prompt,
      continuedFromSessionId,
      sessionId,
      additionalVolumes,
      ...(createdAt ? { createdAt } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(result ? { result } : {}),
      ...(lastEventSequence !== undefined ? { lastEventSequence } : {}),
    })
    .returning({ id: agentRuns.id });

  await globalThis.services.db.insert(zeroRuns).values({
    id: run!.id,
    triggerSource,
    scheduleId,
    chatThreadId,
  });

  return run!;
}

type TestRunAdditionalVolume = {
  name: string;
  version?: string;
  mountPath: string;
};

function additionalVolumesForCheckpoint(
  value: unknown,
): readonly TestRunAdditionalVolume[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): readonly TestRunAdditionalVolume[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const name = "name" in entry ? entry.name : undefined;
    const version = "version" in entry ? entry.version : undefined;
    const mountPath = "mountPath" in entry ? entry.mountPath : undefined;
    if (
      typeof name !== "string" ||
      typeof mountPath !== "string" ||
      (version !== undefined && typeof version !== "string")
    ) {
      return [];
    }

    return [{ name, ...(version ? { version } : {}), mountPath }];
  });
}

function enrichTestVolumeSnapshot(
  snapshot: VolumeVersionsSnapshot | undefined,
  runAdditionalVolumes: unknown,
): VolumeVersionsSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const additionalVolumes =
    additionalVolumesForCheckpoint(runAdditionalVolumes);
  return {
    versions: snapshot.versions,
    ...(additionalVolumes.length > 0
      ? {
          additionalVolumes: additionalVolumes.map((volume) => {
            return {
              name: volume.name,
              versionId:
                snapshot.versions[volume.name] ?? volume.version ?? "latest",
              mountPath: volume.mountPath,
            };
          }),
        }
      : {}),
  };
}

function recordOfStringsOrUndefined(
  value: unknown,
): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      return undefined;
    }
    result[key] = entryValue;
  }
  return result;
}

function arrayOfStringsOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    result.push(entry);
  }
  return result;
}

/**
 * Seed a run record directly in the database, bypassing the API route and dispatch.
 *
 * @why-db-direct PostgreSQL defaultNow() controls createdAt/startedAt/completedAt
 * timestamps at the DB level. vi.setSystemTime() does not affect DB defaults.
 * Tests for date-range logic (cron aggregation, usage boundaries, cleanup TTLs)
 * need runs placed at specific historical dates. Additionally, the API always
 * triggers dispatch (runner_job_queue inserts, Ably notifications) which many
 * tests do not need or want as side effects.
 */
export async function seedTestRun(
  userId: string,
  agentComposeId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    scheduleId?: string;
    chatThreadId?: string;
    triggerSource?: string;
    createdAt?: Date;
    orgId?: string;
    startedAt?: Date;
    completedAt?: Date;
    result?: Record<string, unknown>;
    lastEventSequence?: number;
    additionalVolumes?: Array<{
      name: string;
      version?: string;
      mountPath: string;
    }>;
  },
): Promise<{ runId: string }> {
  initServices();

  // Look up orgId from compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Create a version for the run. Content follows AgentComposeYaml shape so
  // downstream consumers (checkpoint writer, session/conversation resolvers)
  // can resolve workingDir via `extractWorkingDir`.
  const versionId = uniqueId("version");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: agentComposeId,
    content: {
      version: "1.0",
      agents: {
        "test-agent": { framework: "claude-code" },
      },
    },
    createdBy: userId,
  });
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, agentComposeId));

  // Create run directly (use provided orgId or fall back to compose orgId)
  const run = await createRunDirect(
    userId,
    versionId,
    options?.orgId ?? compose.orgId,
    agentComposeId,
    {
      status: options?.status ?? "pending",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      scheduleId: options?.scheduleId,
      chatThreadId: options?.chatThreadId,
      triggerSource: options?.triggerSource,
      createdAt: options?.createdAt,
      startedAt: options?.startedAt,
      completedAt: options?.completedAt,
      result: options?.result,
      lastEventSequence: options?.lastEventSequence,
      additionalVolumes: options?.additionalVolumes,
    },
  );
  return { runId: run.id };
}

/**
 * Mark all running/pending runs as completed for a user.
 *
 * @why-db-direct Bulk status update for cleanup; no API endpoint exists for
 * bulk run completion — runs are completed individually via webhooks.
 */
export async function markRunningRunsAsCompleted(userId: string) {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, userId),
        or(eq(agentRuns.status, "running"), eq(agentRuns.status, "pending")),
      ),
    );
}

/**
 * Set an arbitrary status on a run.
 *
 * @why-db-direct Sets arbitrary run status; API only supports complete/fail
 * transitions via webhooks. Tests need runs in specific states (e.g., "running",
 * "timeout") without going through the full lifecycle.
 */
export async function setTestRunStatus(
  runId: string,
  status: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({
      status,
      ...(["completed", "failed", "timeout", "cancelled"].includes(status)
        ? { completedAt: new Date() }
        : {}),
    })
    .where(eq(agentRuns.id, runId));
}

/**
 * Overwrite the `agent_runs.result` JSONB blob for a run.
 *
 * @why-db-direct `agent_runs.result` is populated by the runner / complete
 * webhook. Tests that stand up a specific `agentSessionId` for session
 * resolution need to seed it directly.
 */
export async function setTestRunResult(
  runId: string,
  result: Record<string, unknown>,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({ result })
    .where(eq(agentRuns.id, runId));
}

/**
 * Set model provider on a zero_runs record.
 *
 * @why-db-direct Sets model provider on zero_runs; no API for this field —
 * it is set during dispatch pipeline.
 */
export async function setTestRunModelProvider(
  runId: string,
  modelProvider: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(zeroRuns)
    .set({ modelProvider })
    .where(eq(zeroRuns.id, runId));
}

/**
 * Set selected model on a zero_runs record.
 *
 * @why-db-direct Sets selected model on zero_runs; no API for this field —
 * it is set during dispatch pipeline.
 */
export async function setTestRunSelectedModel(
  runId: string,
  selectedModel: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(zeroRuns)
    .set({ selectedModel })
    .where(eq(zeroRuns.id, runId));
}

/**
 * Set model routing metadata on a zero_runs record.
 *
 * @why-db-direct These fields are stamped by dispatch/context building; route
 * tests need to model legacy persisted metadata without invoking a runner.
 */
export async function setTestRunModelProviderMetadata(
  runId: string,
  metadata: {
    modelProvider?: string | null;
    modelProviderId?: string | null;
    modelProviderCredentialScope?: string | null;
    selectedModel?: string | null;
  },
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(zeroRuns)
    .set(metadata)
    .where(eq(zeroRuns.id, runId));
}

/**
 * Insert a zero_runs record for a run that already exists in agent_runs.
 *
 * @why-db-direct Creates zero_runs record; enqueueRun() does not create this
 * row, and tests need to set model provider metadata for credit-check scenarios.
 */
export async function insertTestZeroRun(
  runId: string,
  options?: {
    triggerSource?: string;
    modelProvider?: string | null;
    selectedModel?: string | null;
  },
): Promise<void> {
  initServices();
  await globalThis.services.db.insert(zeroRuns).values({
    id: runId,
    triggerSource: options?.triggerSource ?? "cli",
    modelProvider: options?.modelProvider ?? null,
    selectedModel: options?.selectedModel ?? null,
  });
}

/**
 * Set expiresAt to past on a queue entry.
 *
 * @why-db-direct Sets expiresAt to past; no API for queue expiry manipulation.
 * Tests for queue expiry logic need entries with controlled timestamps.
 */
export async function expireQueueEntry(runId: string) {
  initServices();
  // Set expiresAt far enough in the past to avoid any timing issues in CI
  await globalThis.services.db
    .update(agentRunQueue)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(agentRunQueue.runId, runId));
}

/**
 * Insert a queue entry for a run that is in "queued" status.
 * Looks up the run's userId and orgId from the agent_runs table.
 *
 * @why-db-direct Inserts queue entry with controlled timestamps; no API for
 * direct queue manipulation — queue entries are created by the dispatch pipeline.
 *
 * @param runId - The run ID to enqueue
 * @param options - Optional overrides for createdAt and expiresAt
 */
export async function insertTestQueueEntry(
  runId: string,
  options?: {
    createdAt?: Date;
    encryptedParams?: string | null;
    expiresAt?: Date;
  },
) {
  initServices();
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  await globalThis.services.db.insert(agentRunQueue).values({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    createdAt: options?.createdAt,
    encryptedParams: options?.encryptedParams,
    expiresAt: options?.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
  });
}

/**
 * Create a test callback record for agent run completion.
 * Returns the callback ID and the plaintext secret for signing test requests.
 *
 * @why-db-direct Creates callback with encrypted secret; no standalone API for
 * callback creation — callbacks are registered during run dispatch.
 */
export async function createTestCallback(params: {
  runId: string;
  url: string;
  payload?: Record<string, unknown>;
}): Promise<{ callbackId: string; secret: string }> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const secret = generateCallbackSecret();
  const encryptedSecret = encryptSecretValue(secret, SECRETS_ENCRYPTION_KEY);

  const [callback] = await globalThis.services.db
    .insert(agentRunCallbacks)
    .values({
      runId: params.runId,
      url: params.url,
      encryptedSecret,
      payload: params.payload ?? null,
    })
    .returning({ id: agentRunCallbacks.id });

  return { callbackId: callback!.id, secret };
}

/**
 * Link an existing run to a schedule by setting its scheduleId.
 *
 * @why-db-direct Sets scheduleId on zero_runs; no API for run-schedule
 * linking — this is done during scheduled execution dispatch.
 */
export async function linkRunToSchedule(
  runId: string,
  scheduleId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(zeroRuns)
    .set({ scheduleId })
    .where(eq(zeroRuns.id, runId));
}

/**
 * Insert a test conversation record.
 *
 * @why-db-direct Creates conversation record; conversations are created by
 * the checkpoint webhook, not a standalone API endpoint.
 */
export async function insertTestConversation(params: {
  runId: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(conversations).values({
    runId: params.runId,
    cliAgentType: "claude-code",
    cliAgentSessionId: uniqueId("session"),
  });
}

/**
 * Insert sandbox telemetry record for testing.
 *
 * @why-db-direct Creates telemetry record; telemetry is created by the
 * sandbox runtime, not a user API endpoint.
 */
export async function insertTestSandboxTelemetry(params: {
  runId: string;
}): Promise<{ id: string }> {
  initServices();
  const [record] = await globalThis.services.db
    .insert(sandboxTelemetry)
    .values({
      runId: params.runId,
      data: { systemLog: "test log", metrics: [] },
    })
    .returning({ id: sandboxTelemetry.id });

  return { id: record!.id };
}

/**
 * Insert a test usage_daily record.
 *
 * @why-db-direct Creates usage_daily record; usage records are created by
 * cron aggregation, not a user API endpoint.
 */
export async function insertTestUsageDaily(params: {
  userId: string;
  orgId: string;
  date: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(usageDaily).values({
    userId: params.userId,
    orgId: params.orgId,
    date: params.date,
    runCount: 5,
  });
}

/**
 * Seed a checkpoint row directly with the given `artifact_snapshots`.
 *
 * @why-db-direct Migration 0311 backfill tests must stage pre-migration
 * rows (checkpoint carrying a memory entry) that the webhook path no
 * longer produces identically. A direct INSERT is the only way to place
 * an arbitrary `artifact_snapshots` JSON blob on a checkpoint row with a
 * controlled `created_at`.
 */
export async function seedTestCheckpointDirect(
  runId: string,
  artifactSnapshots: ContextArtifact[],
  options?: { createdAt?: Date },
): Promise<{ checkpointId: string }> {
  initServices();
  const [conversation] = await globalThis.services.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.runId, runId))
    .limit(1);
  if (!conversation) {
    throw new Error(
      `No conversation for run ${runId}; call insertTestConversation first`,
    );
  }
  const [row] = await globalThis.services.db
    .insert(checkpoints)
    .values({
      runId,
      conversationId: conversation.id,
      agentComposeSnapshot: {},
      artifactSnapshots,
      ...(options?.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning({ id: checkpoints.id });
  return { checkpointId: row!.id };
}

/**
 * Seed a checkpoint row matching the agent checkpoint webhook's persisted shape.
 *
 * @why-db-direct Tests need checkpoint state after the web checkpoint route has
 * been migrated out of apps/web; this preserves route-test setup without
 * importing a deleted Next.js handler.
 */
export async function seedTestCheckpointForRun(params: {
  userId: string;
  runId: string;
  volumeVersionsSnapshot?: VolumeVersionsSnapshot;
  artifactSnapshots?: ArtifactSnapshotsPayload;
}): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  initServices();
  const [run] = await globalThis.services.db
    .select({
      id: agentRuns.id,
      agentComposeVersionId: agentRuns.agentComposeVersionId,
      additionalVolumes: agentRuns.additionalVolumes,
      secretNames: agentRuns.secretNames,
      sessionId: agentRuns.sessionId,
      userId: agentRuns.userId,
      vars: agentRuns.vars,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, params.runId))
    .limit(1);
  if (!run || run.userId !== params.userId) {
    throw new Error(
      `Failed to create checkpoint: run not found ${params.runId}`,
    );
  }
  if (!run.agentComposeVersionId) {
    throw new Error(
      `Failed to create checkpoint: run has no compose version ${params.runId}`,
    );
  }
  if (!run.sessionId) {
    throw new Error(
      `Failed to create checkpoint: run has no session ${params.runId}`,
    );
  }

  await globalThis.services.db
    .insert(blobs)
    .values({ hash: TEST_SESSION_HISTORY_HASH, size: 0, refCount: 1 })
    .onConflictDoUpdate({
      target: blobs.hash,
      set: { refCount: sql`${blobs.refCount} + 1` },
    });

  const conversationFields = {
    cliAgentType: "claude-code",
    cliAgentSessionId: `test-session-${params.runId}`,
    cliAgentSessionHistoryHash: TEST_SESSION_HISTORY_HASH,
  };
  const [conversation] = await globalThis.services.db
    .insert(conversations)
    .values({
      runId: params.runId,
      ...conversationFields,
    })
    .onConflictDoUpdate({
      target: conversations.runId,
      set: conversationFields,
    })
    .returning({ id: conversations.id });
  if (!conversation) {
    throw new Error("Failed to create checkpoint: conversation insert failed");
  }

  const volumeVersionsSnapshot = enrichTestVolumeSnapshot(
    params.volumeVersionsSnapshot,
    run.additionalVolumes,
  );
  const vars = recordOfStringsOrUndefined(run.vars);
  const secretNames = arrayOfStringsOrUndefined(run.secretNames);
  const agentComposeSnapshot = {
    agentComposeVersionId: run.agentComposeVersionId,
    ...(vars ? { vars } : {}),
    ...(secretNames ? { secretNames } : {}),
  };
  const checkpointFields = {
    conversationId: conversation.id,
    agentComposeSnapshot,
    artifactSnapshots: params.artifactSnapshots ?? null,
    volumeVersionsSnapshot,
  };
  const [checkpoint] = await globalThis.services.db
    .insert(checkpoints)
    .values({
      runId: params.runId,
      ...checkpointFields,
    })
    .onConflictDoUpdate({
      target: checkpoints.runId,
      set: checkpointFields,
    })
    .returning({ id: checkpoints.id });
  if (!checkpoint) {
    throw new Error("Failed to create checkpoint: checkpoint insert failed");
  }

  const [session] = await globalThis.services.db
    .update(agentSessions)
    .set({ conversationId: conversation.id })
    .where(eq(agentSessions.id, run.sessionId))
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to create checkpoint: session update failed");
  }

  return {
    checkpointId: checkpoint.id,
    agentSessionId: session.id,
    conversationId: conversation.id,
  };
}

/**
 * Mark a test run completed using a previously seeded checkpoint payload.
 *
 * @why-db-direct The web complete webhook has moved to apps/api. Web tests that
 * only need completed run state should seed the persisted result directly
 * instead of importing a deleted Next.js route handler.
 */
export async function markTestRunCompletedFromCheckpoint(params: {
  userId: string;
  runId: string;
  checkpoint: {
    checkpointId: string;
    agentSessionId: string;
    conversationId: string;
  };
  volumeVersionsSnapshot?: VolumeVersionsSnapshot;
  lastEventSequence?: number;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({
      status: "completed",
      completedAt: new Date(),
      result: {
        checkpointId: params.checkpoint.checkpointId,
        agentSessionId: params.checkpoint.agentSessionId,
        conversationId: params.checkpoint.conversationId,
        ...(params.volumeVersionsSnapshot
          ? { volumes: params.volumeVersionsSnapshot.versions }
          : {}),
      },
      ...(params.lastEventSequence !== undefined
        ? { lastEventSequence: params.lastEventSequence }
        : {}),
    })
    .where(
      and(eq(agentRuns.id, params.runId), eq(agentRuns.userId, params.userId)),
    );
}

/**
 * Mark a test run failed.
 *
 * @why-db-direct The web complete webhook has moved to apps/api. Web tests that
 * only need failed terminal state should seed it directly.
 */
export async function markTestRunFailed(params: {
  userId: string;
  runId: string;
  error?: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
      error: params.error ?? "test failure",
    })
    .where(
      and(eq(agentRuns.id, params.runId), eq(agentRuns.userId, params.userId)),
    );
}

/**
 * Overwrite `agent_sessions.artifacts` JSONB for an existing session.
 *
 * @why-db-direct No API route sets `agent_sessions.artifacts` after
 * creation — the column is write-once at session insert. Migration 0311
 * idempotence tests need to seed a session whose `artifacts` already
 * carries memory to assert the guard skips it.
 */
export async function setTestAgentSessionArtifacts(
  sessionId: string,
  artifacts: ContextArtifact[],
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentSessions)
    .set({ artifacts })
    .where(eq(agentSessions.id, sessionId));
}
