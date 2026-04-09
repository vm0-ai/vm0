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
import { agentRuns } from "../../db/schema/agent-run";
import { agentRunQueue } from "../../db/schema/agent-run-queue";
import { zeroRuns } from "../../db/schema/zero-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import { orgMetadata } from "../../db/schema/org-metadata";
import { env } from "../../env";
import { getCachedUser } from "../auth/user-cache-service";
import { transitionRunStatus } from "../infra/run/run-status";
import {
  PENDING_RUN_TTL_MS,
  getEffectiveConcurrencyLimit,
  checkRunConcurrencyLimit,
  authorizeCompose,
  validateComposeRequirements,
} from "./zero-run-policy";
import {
  buildAndDispatchRun,
  loadCompose,
  registerCallbacks,
  markRunFailed,
} from "../infra/run/run-service";
import type {
  CreateRunParams,
  CreateRunResult,
} from "../infra/run/run-service";
import { generateZeroToken, generateSandboxToken } from "../auth/sandbox-token";
import { buildZeroExecutionContext } from "./build-zero-context";
import { buildInfraExecutionContext } from "../infra/run/context/build-context";
import {
  encryptSecretsMap,
  decryptSecretsMap,
} from "../shared/crypto/secrets-encryption";
import { isConcurrentRunLimit, isInsufficientCredits } from "../shared/errors";
import {
  checkOrgCredits,
  checkModelProviderConfigured,
} from "./zero-run-service";
import { logger } from "../shared/logger";
import type { OrgTier, QueueResponse, TriggerSource } from "@vm0/core";

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
): Promise<CreateRunResult> {
  const { userId, agentComposeVersionId, prompt } = params;

  // Org context is required from caller
  const orgId = params.orgId;

  // Encrypt the full CreateRunParams for later replay
  const paramsJson = JSON.stringify(params);
  const encryptedParams = encryptSecretsMap(
    { __params: paramsJson },
    env().SECRETS_ENCRYPTION_KEY,
  );

  // Insert agent_runs + queue entry atomically to prevent orphaned records
  const expiresAt = new Date(Date.now() + QUEUE_TTL_MS);

  const run = await globalThis.services.db.transaction(async (tx) => {
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
        lastHeartbeatAt: new Date(),
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to create queued run record");
    }

    await tx.insert(agentRunQueue).values({
      runId: inserted.id,
      userId,
      orgId,
      encryptedParams,
      createdAt: inserted.createdAt,
      expiresAt,
    });

    return inserted;
  });

  log.debug(`Enqueued run ${run.id} for user ${userId}`);

  return {
    runId: run.id,
    status: "queued",
    createdAt: run.createdAt,
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

  for (;;) {
    // Single transaction: advisory lock → concurrency check → dequeue → status update
    const dequeued = await dequeueNextAtomic(db, orgId);
    if (!dequeued) return; // Queue empty, entry skipped, or concurrency full

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
}

interface DequeuedEntry {
  runId: string;
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
      // Credits are checked by checkOrgCredits() within this transaction.
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
      // LEFT JOIN zeroRuns to read modelProvider for credit check.
      const rows = await tx.execute<{
        run_id: string;
        user_id: string;
        encrypted_params: string | null;
        model_provider: string | null;
      }>(
        sql`SELECT q.run_id, q.user_id, q.encrypted_params, zr.model_provider
         FROM agent_run_queue q
         JOIN agent_runs r ON r.id = q.run_id
         LEFT JOIN zero_runs zr ON zr.id = r.id
         WHERE q.org_id = ${orgId}
         ORDER BY q.created_at ASC`,
      );

      for (const row of rows.rows) {
        // Delete queue entry
        await tx
          .delete(agentRunQueue)
          .where(eq(agentRunQueue.runId, row.run_id));

        // Unified pre-flight credit check (org-level + per-member cap)
        try {
          await checkOrgCredits(orgId, row.user_id, row.model_provider, tx);
        } catch (error) {
          if (isInsufficientCredits(error)) {
            await transitionRunStatus(
              row.run_id,
              {
                status: "failed",
                error: error.message,
                completedAt: new Date(),
              },
              ["queued"],
              tx,
            );
            log.debug(`Run ${row.run_id} failed credit check, skipping`);
            continue;
          }
          throw error;
        }

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

        log.debug(`Dequeued run ${row.run_id} for org ${orgId}`);
        return {
          runId: row.run_id,
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
 * Zero-layer dispatch wrapper for queued runs.
 * For zero runs (ZERO_AGENT_ID in vars): generates tokens, builds zero context
 * (secrets, model provider, firewalls), and dispatches with pre-built context.
 * For non-zero runs: delegates directly to the infra dispatcher unchanged.
 */
export async function dispatchQueuedZeroRun(
  runId: string,
  params: CreateRunParams,
): Promise<void> {
  if (params.vars?.ZERO_AGENT_ID) {
    const apiStartTime = Date.now();

    // Generate fresh ZERO_TOKEN for queued dispatch
    const zeroToken = await generateZeroToken(
      params.userId,
      runId,
      params.orgId,
    );
    const updatedParams: CreateRunParams = {
      ...params,
      secrets: { ...params.secrets, ZERO_TOKEN: zeroToken },
    };

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
      params.modelProvider,
      composeContent,
    );

    // Validate compose requirements for new runs only
    if (!params.checkpointId && !params.sessionId) {
      await validateComposeRequirements(composeContent);
    }

    // Register callbacks early so they persist even if context building fails
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(runId, params.callbacks);
    }

    // Generate sandbox token + build zero context
    const sandboxToken = await generateSandboxToken(params.userId, runId);
    const tokenTime = Date.now();
    const contextResult = await buildZeroExecutionContext({
      ...updatedParams,
      sandboxToken,
      agentCompose: composeContent,
      runId,
      agentName: params.agentName,
    });

    // Update zero_runs with resolved model fields before dispatch so metadata
    // is recorded even if dispatch succeeds but a later step fails.
    // Zero queued path: row already exists (created at enqueue time), so UPDATE is safe.
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

    return;
  }

  // Non-zero path — build infra context and dispatch directly
  const nonZeroLog = logger("zero:run-queue-service:non-zero");
  const apiStartTime = Date.now();

  const { composeContent, compose } = await loadCompose(
    params.agentComposeVersionId,
    params.composeId,
  );
  authorizeCompose(params.userId, params.orgId, compose);
  const authorizeTime = Date.now();

  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(composeContent);
  }

  const sandboxToken = await generateSandboxToken(params.userId, runId);
  const tokenTime = Date.now();

  try {
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(runId, params.callbacks);
    }

    const { context } = buildInfraExecutionContext({
      ...params,
      sandboxToken,
      runId,
      agentCompose: composeContent,
      continuedFromSessionId: params.sessionId,
    });

    await buildAndDispatchRun({
      runId,
      context,
      timings: {
        apiStart: apiStartTime,
        authorize: authorizeTime,
        transaction: apiStartTime,
        token: tokenTime,
      },
    });
  } catch (error) {
    await markRunFailed(runId, error);
    await drainOrgQueue(params.orgId, dispatchQueuedZeroRun).catch(
      (drainErr) => {
        nonZeroLog.error("Failed to drain org queue after run failure", {
          drainErr,
        });
      },
    );
    throw error;
  }
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
