import { randomUUID } from "crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { SandboxReuseResult } from "@vm0/api-contracts/contracts/webhooks";
import type { ContextArtifact } from "../../lib/infra/run/types";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { sandboxTelemetry } from "@vm0/db/schema/sandbox-telemetry";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { initServices } from "../../lib/init-services";
import { enqueueRun } from "../../lib/zero/zero-run-queue-service";
import { uniqueId } from "../test-helpers";
import { generateCallbackSecret } from "../../lib/infra/callback/hmac";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";

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
      additionalVolumes: options?.additionalVolumes,
    },
  );
  return { runId: run.id };
}

/**
 * Bulk-seed web chat rounds directly into the run + chat message tables.
 *
 * @why-db-direct Tests that need many historical chat rounds should not pay
 * the cost of one full API dispatch pipeline or compose-version update per
 * round. This helper preserves the rows queried by web-chat context builders
 * while keeping setup cost bounded under parallel CI load.
 */
export async function seedTestChatRounds(params: {
  userId: string;
  orgId: string;
  agentComposeId: string;
  chatThreadId: string;
  prompts: string[];
  status?: string;
  createdAtStart?: Date;
}): Promise<void> {
  if (params.prompts.length === 0) return;
  initServices();

  const status = params.status ?? "cancelled";
  const terminalStatuses = new Set([
    "completed",
    "failed",
    "timeout",
    "cancelled",
  ]);
  const baseTime = params.createdAtStart?.getTime() ?? Date.now();
  const rows = params.prompts.map((prompt, index) => {
    return {
      runId: randomUUID(),
      prompt,
      createdAt: new Date(baseTime + index),
    };
  });

  await globalThis.services.db.transaction(async (tx) => {
    const [session] = await tx
      .insert(agentSessions)
      .values({
        userId: params.userId,
        orgId: params.orgId,
        agentComposeId: params.agentComposeId,
      })
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Failed to seed agent session");
    }

    await tx.insert(agentRuns).values(
      rows.map((row) => {
        return {
          id: row.runId,
          userId: params.userId,
          orgId: params.orgId,
          sessionId: session.id,
          status,
          prompt: row.prompt,
          createdAt: row.createdAt,
          ...(terminalStatuses.has(status)
            ? { completedAt: row.createdAt }
            : {}),
        };
      }),
    );

    await tx.insert(zeroRuns).values(
      rows.map((row) => {
        return {
          id: row.runId,
          triggerSource: "web",
          chatThreadId: params.chatThreadId,
        };
      }),
    );

    await tx.insert(chatMessages).values(
      rows.map((row) => {
        return {
          chatThreadId: params.chatThreadId,
          runId: row.runId,
          role: "user",
          content: row.prompt,
          createdAt: row.createdAt,
        };
      }),
    );
  });
}

/**
 * Move the agent run and linked chat message to a deterministic timestamp.
 *
 * @why-db-direct PostgreSQL timestamps come from DB defaults in route tests.
 * Ordering-sensitive chat context tests need to place a route-created seed
 * round before later bulk-seeded rows.
 */
export async function setTestChatRoundCreatedAt(
  runId: string,
  createdAt: Date,
): Promise<void> {
  initServices();
  await Promise.all([
    globalThis.services.db
      .update(agentRuns)
      .set({ createdAt })
      .where(eq(agentRuns.id, runId)),
    globalThis.services.db
      .update(chatMessages)
      .set({ createdAt })
      .where(eq(chatMessages.runId, runId)),
  ]);
}

/**
 * Seed a completed agent run with controlled timestamps.
 *
 * @why-db-direct PostgreSQL defaultNow() controls createdAt which cannot be
 * set through the API or JavaScript fake timers. Tests for date-range logic
 * (cron aggregation, usage API boundaries) need runs placed at specific
 * historical dates.
 */
export async function seedCompletedTestRun(options: {
  composeVersionId: string;
  userId: string;
  createdAt: Date;
  startedAt: Date;
  completedAt: Date;
}): Promise<string> {
  initServices();

  const { orgId, composeId } = await getOrgAndComposeFromVersion(
    options.composeVersionId,
  );
  const sessionId = await ensureTestAgentSession({
    userId: options.userId,
    orgId,
    agentComposeId: composeId,
  });

  const [row] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: options.userId,
      orgId,
      agentComposeVersionId: options.composeVersionId,
      status: "completed",
      prompt: "test",
      sessionId,
      createdAt: options.createdAt,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
    })
    .returning({ id: agentRuns.id });
  return row!.id;
}

/**
 * Seed a stale pending run directly into the database.
 *
 * @why-db-direct The API immediately transitions runs to "running" or "failed"
 * during dispatch. A run stuck in "pending" state past the cleanup TTL cannot
 * be reproduced through normal API flows. The stale lastHeartbeatAt timestamp
 * is also a DB-controlled value that cannot be set via the API.
 */
export async function seedStalePendingRun(
  userId: string,
  agentComposeVersionId: string,
  ageMs: number = 20 * 60 * 1000,
): Promise<string> {
  initServices();

  const { orgId, composeId } = await getOrgAndComposeFromVersion(
    agentComposeVersionId,
  );
  const sessionId = await ensureTestAgentSession({
    userId,
    orgId,
    agentComposeId: composeId,
  });

  const staleCreatedAt = new Date(Date.now() - ageMs);
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId,
      status: "pending",
      prompt: "Stale pending run",
      sessionId,
      createdAt: staleCreatedAt,
      lastHeartbeatAt: staleCreatedAt,
    })
    .returning({ id: agentRuns.id });

  if (!run) {
    throw new Error("Failed to insert stale pending run");
  }

  return run.id;
}

/**
 * Create a run with no compose version (simulates deleted compose).
 *
 * @why-db-direct The API requires a valid compose version to create a run.
 * A run whose compose has been deleted (agentComposeVersionId: null) cannot
 * be reproduced through normal API flows. Tests for orphan-run graceful
 * handling need this DB-direct seeder.
 */
export async function seedOrphanTestRun(
  userId: string,
  orgId: string,
  options?: { status?: string; prompt?: string },
): Promise<{ runId: string }> {
  initServices();

  // An orphan run still needs a valid session_id (NOT NULL + FK). Seed a
  // throwaway compose + session to back the FK; the "orphan" semantics are
  // about the null agent_compose_version_id, not the session.
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId,
      orgId,
      name: uniqueId("orphan-compose"),
    })
    .returning({ id: agentComposes.id });
  if (!compose) {
    throw new Error("Failed to seed orphan compose");
  }
  const sessionId = await ensureTestAgentSession({
    userId,
    orgId,
    agentComposeId: compose.id,
  });

  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: null,
      status: options?.status ?? "completed",
      prompt: options?.prompt ?? "orphan run prompt",
      sessionId,
    })
    .returning({ id: agentRuns.id });
  return { runId: run!.id };
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
 * Set `agent_runs.runner_group` for a run.
 *
 * @why-db-direct `agent_runs.runner_group` is assigned by the dispatch
 * pipeline once the execution context has been built. Tests that need a
 * specific runner group without standing up the full dispatch path (e.g. to
 * force `publishCancelNotification` in cancel-flow tests) must seed it
 * directly.
 */
export async function setTestRunRunnerGroup(
  runId: string,
  runnerGroup: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({ runnerGroup })
    .where(eq(agentRuns.id, runId));
}

/**
 * Set `agent_runs.vars` JSONB for a run.
 *
 * @why-db-direct `agent_runs.vars` is written by the runner during execution;
 * no API surface sets it directly. Tests that need to control ZERO_AGENT_ID
 * for agent-mismatch scenarios (e.g. voice-chat callback tests)
 * must seed it directly.
 */
export async function setTestRunVars(
  runId: string,
  vars: Record<string, unknown>,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({ vars })
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
 * Set the sandbox-reuse-result outcome on an existing run.
 *
 * @why-db-direct Runner reports this field via the agent-complete webhook
 * during normal execution; tests for the runner-tab API need to seed it
 * directly without invoking the webhook pipeline.
 */
export async function setTestRunSandboxReuseResult(
  runId: string,
  sandboxReuseResult: SandboxReuseResult,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentRuns)
    .set({ sandboxReuseResult })
    .where(eq(agentRuns.id, runId));
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
 * Enqueue a run for testing (wraps enqueueRun service function).
 *
 * @why-db-direct Enqueues a run with encryption and queue entry; the service
 * encapsulates atomic DB inserts that cannot be replicated via a single API call.
 */
export async function enqueueTestRun(params: {
  userId: string;
  agentComposeVersionId: string;
  orgId: string;
  prompt: string;
  composeId: string;
}): Promise<{ runId: string; status: string; queuedAt: Date }> {
  initServices();
  const result = await enqueueRun(params);
  return {
    runId: result.runId,
    status: result.status,
    queuedAt: result.createdAt,
  };
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

/**
 * Overwrite `checkpoints.artifact_snapshots` JSONB for a checkpoint.
 *
 * @why-db-direct `checkpoints.artifact_snapshots` is written by the
 * checkpoint webhook during run completion. Resolver tests need to seed
 * arbitrary legacy and new-shape payloads to exercise shape tolerance, so
 * the raw update bypasses the column's narrowed `ContextArtifact[]` type.
 */
export async function setTestCheckpointArtifactSnapshots(
  checkpointId: string,
  snapshots: unknown,
): Promise<void> {
  initServices();
  const payload = snapshots === null ? null : JSON.stringify(snapshots);
  await globalThis.services.db.execute(sql`
    UPDATE checkpoints
    SET artifact_snapshots = ${payload}::jsonb
    WHERE id = ${checkpointId}::uuid
  `);
}
