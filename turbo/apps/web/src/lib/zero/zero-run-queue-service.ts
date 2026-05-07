import {
  eq,
  lt,
  and,
  count,
  gt,
  or,
  sql,
  asc,
  desc,
  isNotNull,
  avg,
  inArray,
} from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { env } from "../../env";
import { getCachedUser } from "../auth/user-cache-service";
import { transitionRunStatus } from "../infra/run/run-status";
import {
  PENDING_RUN_TTL_MS,
  getEffectiveConcurrencyLimit,
  checkRunConcurrencyLimit,
  authorizeCompose,
  validateComposeRequirements,
  checkModelProviderConfigured,
  resolveRunAdmissionContext,
  checkOrgCreditsForRunAdmission,
} from "./zero-run-policy";
import {
  buildAndDispatchRun,
  loadCompose,
  registerCallbacks,
} from "../infra/run/run-service";
import type {
  CreateRunParams,
  CreateRunResult,
} from "../infra/run/run-service";
import { generateZeroToken, generateSandboxToken } from "../auth/sandbox-token";
import { loadFeatureSwitchOverrides } from "./user/feature-switches-service";
import { buildZeroExecutionContext } from "./build-zero-context";
import { buildAutoMemoryArtifact } from "./memory";
import {
  persistZeroRunMetadata,
  type ZeroRunMetadataValues,
} from "./zero-run-metadata";
import {
  encryptSecretsMap,
  decryptSecretsMap,
} from "../shared/crypto/secrets-encryption";
import { isConcurrentRunLimit } from "@vm0/api-services/errors";
import { logger } from "../shared/logger";
import { publishOrgSignal } from "./realtime";
import { publishChatThreadRunUpdated } from "./chat-thread/chat-message-service";
import { publishRunChangedForUserSafely } from "../infra/run/run-realtime";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { QueueResponse } from "@vm0/api-contracts/contracts/runs";
import { recordSandboxOperation } from "../infra/metrics";

const log = logger("zero:run-queue-service");

// Queue entry TTL: 2 hours (same as runner_job_queue)
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Dispatcher function type for queued runs.
 * Receives a run that has already been dequeued and transitioned to "pending".
 * Injected by callers to avoid circular dependency with run-service.
 */
type QueuedRunDispatcher = (
  runId: string,
  params: CreateRunParams,
) => Promise<void>;

interface EnqueueRunOptions {
  zeroRunMetadata?: ZeroRunMetadataValues;
  onZeroRunMetadataPersisted?: (durationMs: number) => void;
}

// ─── Queue Operations (moved from run-queue-service.ts) ─────────────────────

/**
 * Enqueue a run that hit the concurrency limit.
 *
 * Creates a visible agent_runs record (status="queued") and stores
 * the full CreateRunParams in agent_run_queue with AES-256-GCM encryption.
 * The queue entry is deleted on dequeue — secrets never persist long-term.
 */
export async function enqueueRun(
  params: CreateRunParams,
  options: EnqueueRunOptions = {},
): Promise<CreateRunResult> {
  const { userId, agentComposeVersionId, prompt } = params;

  // Org context is required from caller
  const orgId = params.orgId;

  // composeId must be present on the zero path (resolved before enqueue).
  // Without it we cannot stamp agent_sessions.agent_compose_id.
  if (!params.composeId) {
    throw new Error("enqueueRun requires params.composeId to be set");
  }
  const agentComposeId = params.composeId;

  // Encrypt the full CreateRunParams for later replay
  const paramsJson = JSON.stringify(params);
  const encryptedParams = encryptSecretsMap(
    { __params: paramsJson },
    env().SECRETS_ENCRYPTION_KEY,
  );

  // Insert agent_runs + queue entry atomically to prevent orphaned records.
  // Eagerly create the agent_sessions row too so sessionId is known on the
  // POST response even for queued runs (same promise as synchronous runs).
  const expiresAt = new Date(Date.now() + QUEUE_TTL_MS);
  let zeroRunMetadataDurationMs: number | undefined;

  const run = await globalThis.services.db.transaction(async (tx) => {
    let sessionId: string;
    if (params.sessionId) {
      sessionId = params.sessionId;
    } else {
      const [newSession] = await tx
        .insert(agentSessions)
        .values({
          userId,
          orgId,
          agentComposeId,
          artifacts: [buildAutoMemoryArtifact()],
          conversationId: null,
        })
        .returning({ id: agentSessions.id });

      if (!newSession) {
        throw new Error("Failed to create queued agent session");
      }
      sessionId = newSession.id;
    }

    const [inserted] = await tx
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        agentComposeVersionId,
        status: "queued",
        prompt,
        appendSystemPrompt: params.appendSystemPrompt ?? null,
        vars: params.vars ?? null,
        secretNames: params.secrets ? Object.keys(params.secrets) : null,
        resumedFromCheckpointId: params.resumedFromCheckpointId ?? null,
        continuedFromSessionId: params.sessionId ?? null,
        sessionId,
        lastHeartbeatAt: new Date(),
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to create queued run record");
    }

    if (options.zeroRunMetadata) {
      const zeroRunMetadataStartedAt = Date.now();
      await persistZeroRunMetadata(tx, inserted.id, options.zeroRunMetadata);
      zeroRunMetadataDurationMs = Date.now() - zeroRunMetadataStartedAt;
    }

    await tx.insert(agentRunQueue).values({
      runId: inserted.id,
      userId,
      orgId,
      encryptedParams,
      createdAt: inserted.createdAt,
      expiresAt,
    });

    // Post-insert queue depth, captured inside the same transaction so the
    // enqueue hot path doesn't pay a separate round-trip after commit.
    // Directional (racing inserts/deletes across orgs can skew by ±1) but
    // correlates with queue pressure per org.
    const [depthRow] = await tx
      .select({ depth: count() })
      .from(agentRunQueue)
      .where(eq(agentRunQueue.orgId, orgId));

    return {
      ...inserted,
      sessionId,
      queueDepth: Number(depthRow?.depth ?? 0),
    };
  });

  if (zeroRunMetadataDurationMs !== undefined) {
    options.onZeroRunMetadataPersisted?.(zeroRunMetadataDurationMs);
  }

  log.debug(`Enqueued run ${run.id} for user ${userId}`);

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "enqueue_zero_run",
    durationMs: 0,
    success: true,
    runId: run.id,
    dimensions: {
      queue_depth: run.queueDepth,
      trigger_source: params.triggerSource ?? null,
    },
  });

  // Notify all org members whose queue view should refresh.
  await publishOrgSignal(orgId, "queue:changed");

  return {
    runId: run.id,
    status: "queued",
    createdAt: run.createdAt,
    sessionId: run.sessionId,
  };
}

/**
 * Drain the run queue for an org.
 *
 * Atomically dequeues the oldest entry, checks concurrency, deletes the
 * queue record, and transitions the run to "pending" — all within a single
 * advisory-locked transaction. This eliminates the orphaned run risk that
 * existed when dequeue and execute were separate transactions.
 *
 * Uses an iterative approach: on dispatch failure, marks the run as failed
 * and tries the next entry. Stops when a run is successfully dispatched,
 * the queue is empty, or the concurrency limit is reached.
 *
 * Called from:
 * - Completion webhook (event-driven, primary path)
 * - Cancel handler (when cancelling frees a slot)
 * - Cleanup cron (fallback for missed dequeues)
 *
 * @param orgId - Org whose queue to drain
 * @param dispatch - Dispatcher function (injected to avoid circular dependency)
 */
export async function drainOrgQueue(
  orgId: string,
  dispatch: QueuedRunDispatcher,
): Promise<void> {
  const db = globalThis.services.db;
  const encryptionKey = env().SECRETS_ENCRYPTION_KEY;

  try {
    for (;;) {
      // Single transaction: advisory lock → concurrency check → dequeue → status update
      const dequeued = await dequeueNextAtomic(db, orgId);
      if (!dequeued) return; // Queue empty, entry skipped, or concurrency full

      // Status just transitioned queued → pending. Notify any chat thread
      // watching this run so the UI can swap "Waiting in queue" for the
      // normal thinking indicator. No-op for non-chat runs; fire-and-forget
      // so a realtime hiccup doesn't stall the drain loop.
      publishChatThreadRunUpdated(dequeued.runId).catch((err: unknown) => {
        log.error("Failed to publish chatThreadRunUpdated after dequeue", {
          err,
        });
      });
      publishRunChangedForUserSafely(dequeued.userId, dequeued.runId, {
        status: "pending",
      }).catch((err: unknown) => {
        log.error("Failed to publish run changed after dequeue", { err });
      });

      // Decrypt CreateRunParams (outside transaction — no lock held)
      const decryptedMap = decryptSecretsMap(
        dequeued.encryptedParams,
        encryptionKey,
      );
      if (!decryptedMap?.__params) {
        log.error(`Failed to decrypt params for queued run ${dequeued.runId}`);
        await markQueuedRunFailed(
          dequeued.runId,
          "Failed to decrypt queued run params",
        );
        continue; // Try next entry
      }

      const params: CreateRunParams = JSON.parse(decryptedMap.__params);

      // Dispatch the run (compose loading, authorization, execution)
      try {
        await dispatch(dequeued.runId, params);
        log.debug(`Queued run ${dequeued.runId} dispatched successfully`);
        return; // Successfully dispatched — done
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        log.error(
          `Failed to dispatch queued run ${dequeued.runId}: ${errorMessage}`,
        );
        await markQueuedRunFailed(dequeued.runId, errorMessage);
        continue; // Try next entry
      }
    }
  } finally {
    // Always publish after drain — either a run was dequeued (anyTransition) or
    // the caller freed a concurrency slot and the queue view must refresh even
    // when the queue was already empty. Swallow Ably failures so they don't mask
    // an original throw propagating through this finally (finally-throw would
    // replace the real error).
    await publishOrgSignal(orgId, "queue:changed").catch((err: unknown) => {
      log.error("Failed to publish queue:changed after drain", { err });
    });
  }
}

interface DequeuedEntry {
  runId: string;
  userId: string;
  encryptedParams: string | null;
}

/**
 * Atomically dequeue the oldest queue entry for an org.
 *
 * Within a single advisory-locked transaction:
 * 1. Check concurrency limit (don't dequeue if no slot)
 * 2. Select oldest queue entry
 * 3. Delete queue entry
 * 4. Transition run from "queued" to "pending"
 *
 * If a run was already processed (e.g. cancelled), its queue entry is
 * removed and the next entry is tried within the same transaction.
 *
 * Returns undefined if queue is empty or concurrency limit reached.
 */
async function dequeueNextAtomic(
  db: typeof globalThis.services.db,
  orgId: string,
): Promise<DequeuedEntry | undefined> {
  try {
    return await db.transaction(async (tx) => {
      // Serialize all queue operations for this org
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);

      // Look up org tier from org table (source of truth).
      // Falls back to "free" (most conservative limit) if row is missing.
      // Credits are re-checked during queued dispatch with the decrypted
      // CreateRunParams, so modelProviderId and personal-provider preferences
      // are resolved from the same run context that dispatch uses.
      const [orgRow] = await tx
        .select({ tier: orgMetadata.tier })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      const orgTier = parseOrgTier(orgRow?.tier);

      // Check concurrency FIRST — don't dequeue if no slot available
      await checkRunConcurrencyLimit(orgId, orgTier, tx);

      // Fetch all queue entries for this org (ordered FIFO).
      // Typically 0-2 entries; iterating in-transaction to skip
      // already-processed runs without releasing the advisory lock.
      const rows = await tx.execute<{
        run_id: string;
        user_id: string;
        encrypted_params: string | null;
        created_at: Date;
      }>(
        sql`SELECT q.run_id, q.user_id, q.encrypted_params, q.created_at
         FROM agent_run_queue q
         JOIN agent_runs r ON r.id = q.run_id
         WHERE q.org_id = ${orgId}
         ORDER BY q.created_at ASC`,
      );

      for (const row of rows.rows) {
        // Delete queue entry
        await tx
          .delete(agentRunQueue)
          .where(eq(agentRunQueue.runId, row.run_id));

        // Update run status — fails silently if run was already cancelled/failed
        const [updated] = await tx
          .update(agentRuns)
          .set({ status: "pending", lastHeartbeatAt: new Date() })
          .where(
            and(eq(agentRuns.id, row.run_id), eq(agentRuns.status, "queued")),
          )
          .returning({ id: agentRuns.id });

        if (!updated) {
          // Run was cancelled/failed between enqueue and drain — skip it
          log.debug(`Run ${row.run_id} already processed, skipping`);
          continue;
        }

        // Remaining queue depth for this org, inside the same advisory lock
        // so the number reflects the post-dequeue state exactly.
        const [remainingRow] = await tx
          .select({ depth: count() })
          .from(agentRunQueue)
          .where(eq(agentRunQueue.orgId, orgId));

        const enqueuedAtMs = new Date(row.created_at).getTime();
        recordSandboxOperation({
          sandboxType: "runner",
          actionType: "dequeue_zero_run",
          durationMs: Date.now() - enqueuedAtMs,
          success: true,
          runId: row.run_id,
          dimensions: {
            queue_depth_at_dequeue: Number(remainingRow?.depth ?? 0),
          },
        });

        log.debug(`Dequeued run ${row.run_id} for org ${orgId}`);
        return {
          runId: row.run_id,
          userId: row.user_id,
          encryptedParams: row.encrypted_params,
        };
      }

      return undefined; // Queue empty (all entries were already processed)
    });
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      // No slot available — nothing was dequeued
      return undefined;
    }
    throw error;
  }
}

/**
 * Clean up expired queue entries.
 * Marks associated runs as "timeout" and deletes the queue records.
 */
export async function cleanupExpiredQueueEntries(): Promise<number> {
  const now = new Date();

  // Delete expired entries and collect their run IDs in one query
  const deleted = await globalThis.services.db
    .delete(agentRunQueue)
    .where(lt(agentRunQueue.expiresAt, now))
    .returning({ runId: agentRunQueue.runId });

  if (deleted.length === 0) {
    return 0;
  }

  const runIds = deleted.map((e) => {
    return e.runId;
  });

  // Mark associated runs as timeout (only if still queued)
  await globalThis.services.db
    .update(agentRuns)
    .set({
      status: "timeout",
      completedAt: now,
      error: "Queued run expired (exceeded queue TTL)",
    })
    .where(and(inArray(agentRuns.id, runIds), eq(agentRuns.status, "queued")));

  log.debug(`Cleaned up ${deleted.length} expired queue entries`);
  return deleted.length;
}

/**
 * Drain queues for orgs that have queued runs but no active runs.
 * Used as a cron fallback in case completion webhooks miss the drain.
 *
 * @param dispatch - Dispatcher function (injected to avoid circular dependency)
 */
export async function drainStaleQueues(
  dispatch: QueuedRunDispatcher,
): Promise<number> {
  const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);

  // Find distinct orgs with queued runs (orgId is denormalized on queue table)
  const orgsWithQueued = await globalThis.services.db
    .selectDistinct({ orgId: agentRunQueue.orgId })
    .from(agentRunQueue);

  let drained = 0;

  for (const { orgId } of orgsWithQueued) {
    // Check if org has any active runs (same logic as checkRunConcurrencyLimit)
    const [result] = await globalThis.services.db
      .select({ count: count() })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          or(
            eq(agentRuns.status, "running"),
            and(
              eq(agentRuns.status, "pending"),
              gt(agentRuns.createdAt, staleThreshold),
            ),
          ),
        ),
      );

    const activeCount = Number(result?.count ?? 0);
    if (activeCount === 0) {
      log.debug(`Draining stale queue for org ${orgId}`);
      await drainOrgQueue(orgId, dispatch);
      drained++;
    }
  }

  return drained;
}

const VALID_ORG_TIERS = new Set<string>(["free", "pro", "team"]);

/** Parse a raw tier string into OrgTier, defaulting to "free". */
function parseOrgTier(raw: string | undefined): OrgTier {
  if (raw && VALID_ORG_TIERS.has(raw)) return raw as OrgTier;
  return "free";
}

async function markQueuedRunFailed(
  runId: string,
  errorMessage: string,
): Promise<void> {
  await transitionRunStatus(
    runId,
    {
      status: "failed",
      error: errorMessage,
      completedAt: new Date(),
    },
    ["queued", "pending"],
  );
}

// ─── Zero Dispatch ──────────────────────────────────────────────────────────

/**
 * Dispatch wrapper for queued runs. Generates tokens, builds the Zero
 * execution context (secrets, model provider, firewalls), and hands off to
 * the infra dispatcher. `enqueueRun` is only called from `createZeroRun`,
 * so every queued entry is a Zero run — there is no other shape to handle.
 */
export async function dispatchQueuedZeroRun(
  runId: string,
  params: CreateRunParams,
): Promise<void> {
  // Queued dispatch anchors apiStart at dequeue, not the original request.
  // The queue wait time is intentionally excluded from startup latency —
  // merging it would hide queue-worker lag behind cold-start numbers.
  const apiStartTime = Date.now();

  // Generate fresh ZERO_TOKEN for queued dispatch
  const overrides = await loadFeatureSwitchOverrides(
    params.orgId,
    params.userId,
  );
  const zeroToken = await generateZeroToken(
    params.userId,
    runId,
    params.orgId,
    overrides,
  );

  // Load compose + authorize (same validation as direct path)
  const { composeContent, compose } = await loadCompose(
    params.agentComposeVersionId,
    params.composeId,
  );
  authorizeCompose(params.userId, params.orgId, compose);
  const authorizeTime = Date.now();

  // Pre-flight: ensure model provider is still configured (may have been
  // removed after enqueue). Throws noModelProvider() on failure — caught by
  // drainOrgQueue() which marks the run as failed.
  await checkModelProviderConfigured(
    params.orgId,
    params.userId,
    params.modelProvider,
    composeContent,
    params.preferPersonalProvider,
  );

  const composeAgents = composeContent?.agents
    ? Object.values(composeContent.agents)
    : [];
  const composeFramework = composeAgents[0]?.framework ?? "claude-code";
  const admissionContext = await resolveRunAdmissionContext({
    orgId: params.orgId,
    userId: params.userId,
    modelProvider: params.modelProvider,
    modelProviderId: params.modelProviderId,
    composeFramework,
    preferPersonalProvider: params.preferPersonalProvider,
  });

  await checkOrgCreditsForRunAdmission(admissionContext);

  // Validate compose requirements for new runs only
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(
      composeContent,
      admissionContext.providerType,
    );
  }

  // Register callbacks early so they persist even if context building fails
  if (params.callbacks && params.callbacks.length > 0) {
    await registerCallbacks(runId, params.callbacks);
  }

  // Generate sandbox token + build zero context
  const sandboxToken = await generateSandboxToken(
    params.userId,
    runId,
    params.orgId,
  );
  const tokenTime = Date.now();
  const contextResult = await buildZeroExecutionContext({
    ...params,
    secrets: { ...params.secrets, ZERO_TOKEN: zeroToken },
    sandboxToken,
    agentCompose: composeContent,
    runId,
    apiStartTime,
  });
  // Tag the context so the downstream api_to_executor span records
  // was_queued=true for runs that came through the queue.
  contextResult.context.wasQueued = true;

  // Update zero_runs with resolved model fields before dispatch so metadata
  // is recorded even if dispatch succeeds but a later step fails.
  // Zero callers create the row at enqueue time; direct low-level test enqueues
  // may omit it, in which case this UPDATE is a no-op.
  await globalThis.services.db
    .update(zeroRuns)
    .set({
      modelProvider: contextResult.resolvedModelProvider ?? null,
      selectedModel: contextResult.selectedModel ?? null,
    })
    .where(eq(zeroRuns.id, runId));

  await buildAndDispatchRun({
    runId,
    context: contextResult.context,
    timings: {
      apiStart: apiStartTime,
      authorize: authorizeTime,
      transaction: apiStartTime,
      token: tokenTime,
      resolveSourceDuration: contextResult.timings.resolveSourceAndOrg,
      resolveSecretsDuration: contextResult.timings.resolveSecrets,
    },
  });
}

// ─── Queue Status (Zero layer) ─────────────────────────────────────────────

const RECENT_RUNS_FOR_ETA = 20;
const PROMPT_TRUNCATE_LENGTH = 200;

/**
 * Get run queue status for an org, including concurrency info,
 * queued/running entries, and estimated time per run.
 *
 * Privacy filtering: non-owners see nullified personal fields.
 *
 * This is a Zero-layer concern because it joins zero_runs and zero_agents
 * to enrich queue entries with triggerSource and agent display names.
 */
export async function getRunQueueStatus(
  userId: string,
  orgId: string,
  orgTier: OrgTier,
): Promise<QueueResponse> {
  const db = globalThis.services.db;
  const limit = getEffectiveConcurrencyLimit(orgTier);

  // Count active runs (same logic as checkRunConcurrencyLimit)
  const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);
  const [activeResult] = await db
    .select({ count: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            gt(agentRuns.createdAt, staleThreshold),
          ),
        ),
      ),
    );
  const active = Number(activeResult?.count ?? 0);

  // Fetch queued runs in FIFO order (with extra fields for owner details)
  const queuedRuns = await db
    .select({
      id: agentRuns.id,
      runUserId: agentRuns.userId,
      createdAt: agentRuns.createdAt,
      agentName: agentComposes.name,
      agentDisplayName: zeroAgents.displayName,
      prompt: agentRuns.prompt,
      triggerSource: zeroRuns.triggerSource,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "queued")))
    .orderBy(asc(agentRuns.createdAt));

  // Fetch running tasks
  const runningRuns = await db
    .select({
      id: agentRuns.id,
      runUserId: agentRuns.userId,
      startedAt: agentRuns.startedAt,
      agentName: agentComposes.name,
      agentDisplayName: zeroAgents.displayName,
    })
    .from(agentRuns)
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
    .orderBy(asc(agentRuns.startedAt));

  // Calculate estimated time per run from recent completed runs
  const recentRuns = db
    .select({
      durationMs:
        sql<number>`EXTRACT(EPOCH FROM (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000`.as(
          "duration_ms",
        ),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "completed"),
        isNotNull(agentRuns.completedAt),
        isNotNull(agentRuns.startedAt),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .limit(RECENT_RUNS_FOR_ETA)
    .as("recent_runs");
  const [etaResult] = await db
    .select({
      avgMs: avg(recentRuns.durationMs),
    })
    .from(recentRuns);
  const estimatedTimePerRun = etaResult?.avgMs
    ? Math.round(Number(etaResult.avgMs))
    : null;

  // Resolve user emails in parallel (for both queued and running)
  const allUserIds = [
    ...new Set([
      ...queuedRuns.map((r) => {
        return r.runUserId;
      }),
      ...runningRuns.map((r) => {
        return r.runUserId;
      }),
    ]),
  ];
  const userMap = new Map<string, string>();
  await Promise.all(
    allUserIds.map(async (uid) => {
      const user = await getCachedUser(uid);
      userMap.set(uid, user.email);
    }),
  );

  // Build queue response with privacy filtering
  const queue = queuedRuns.map((run, index) => {
    const isOwner = run.runUserId === userId;
    return {
      position: index + 1,
      agentName: isOwner ? (run.agentName ?? "unknown") : null,
      agentDisplayName: isOwner ? (run.agentDisplayName ?? null) : null,
      userEmail: isOwner ? (userMap.get(run.runUserId) ?? "unknown") : null,
      createdAt: run.createdAt.toISOString(),
      isOwner,
      runId: isOwner ? run.id : null,
      prompt: isOwner
        ? run.prompt.length > PROMPT_TRUNCATE_LENGTH
          ? run.prompt.slice(0, PROMPT_TRUNCATE_LENGTH) + "..."
          : run.prompt
        : null,
      triggerSource: isOwner
        ? ((run.triggerSource ?? "cli") as TriggerSource)
        : null,
      sessionLink:
        isOwner && run.continuedFromSessionId
          ? `/chat/${run.continuedFromSessionId}`
          : null,
    };
  });

  // Build running tasks response with privacy filtering
  const runningTasks = runningRuns.map((run) => {
    const isOwner = run.runUserId === userId;
    return {
      runId: isOwner ? run.id : null,
      agentName: run.agentName ?? "unknown",
      agentDisplayName: run.agentDisplayName ?? null,
      userEmail: userMap.get(run.runUserId) ?? "unknown",
      startedAt: run.startedAt?.toISOString() ?? null,
      isOwner,
    };
  });

  return {
    concurrency: {
      tier: orgTier,
      limit,
      active,
      available: limit === 0 ? -1 : Math.max(0, limit - active),
    },
    queue,
    runningTasks,
    estimatedTimePerRun,
  };
}
