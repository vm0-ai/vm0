import { eq, lt, and, or, count, gt, sql, inArray } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { transitionRunStatus } from "./run-status";
import { agentRunQueue } from "../../db/schema/agent-run-queue";
import { env } from "../../env";
import { logger } from "../logger";
import { isConcurrentRunLimit } from "../errors";
import {
  encryptSecretsMap,
  decryptSecretsMap,
} from "../crypto/secrets-encryption";
import { PENDING_RUN_TTL_MS } from "./run-service";
import { resolveOrg } from "../org/resolve-org";
import type { CreateRunParams, CreateRunResult } from "./run-service";

const log = logger("service:run-queue");

// Queue entry TTL: 2 hours (same as runner_job_queue)
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Executor function type for dispatching queued runs.
 * Injected by callers to avoid circular dependency with run-service.
 */
type QueuedRunExecutor = (
  runId: string,
  params: CreateRunParams,
) => Promise<void>;

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

  // Resolve orgId (caller should have already resolved it, but fall back)
  let orgId: string;
  if (params.orgId) {
    orgId = params.orgId;
  } else {
    const { org } = await resolveOrg(userId);
    orgId = org.orgId;
  }

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
        vars: params.vars ?? null,
        secretNames: params.secrets ? Object.keys(params.secrets) : null,
        resumedFromCheckpointId: params.resumedFromCheckpointId ?? null,
        continuedFromSessionId: params.sessionId ?? null,
        scheduleId: params.scheduleId ?? null,
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
 * Dequeues the oldest entry using SELECT FOR UPDATE SKIP LOCKED,
 * deletes the queue record (encrypted secrets removed), and dispatches
 * the run through the provided executor.
 *
 * Uses an iterative approach: on dispatch failure, marks the run as failed
 * and tries the next entry. Stops when a run is successfully dispatched,
 * the queue is empty, or a concurrency conflict occurs.
 *
 * Called from:
 * - Completion webhook (event-driven, primary path)
 * - Cancel handler (when cancelling frees a slot)
 * - Cleanup cron (fallback for missed dequeues)
 *
 * @param orgId - Org whose queue to drain
 * @param execute - Executor function (injected to avoid circular dependency)
 */
export async function drainOrgQueue(
  orgId: string,
  execute: QueuedRunExecutor,
): Promise<void> {
  const encryptionKey = env().SECRETS_ENCRYPTION_KEY;
  let entry = await dequeueNext(orgId);

  while (entry) {
    const runId = entry.runId;

    // Decrypt CreateRunParams
    const decryptedMap = decryptSecretsMap(
      entry.encryptedParams,
      encryptionKey,
    );
    if (!decryptedMap?.__params) {
      log.error(`Failed to decrypt params for queued run ${runId}`);
      await markQueuedRunFailed(runId, "Failed to decrypt queued run params");
      entry = await dequeueNext(orgId);
      continue;
    }

    const params: CreateRunParams = JSON.parse(decryptedMap.__params);

    // Execute the queued run (re-checks concurrency before dispatching)
    try {
      await execute(runId, params);
      log.debug(`Queued run ${runId} dispatched successfully`);
      return; // Successfully dispatched — done
    } catch (error) {
      if (isConcurrentRunLimit(error)) {
        // Slot was claimed by another request — re-enqueue and stop
        await reEnqueueRun(
          runId,
          entry.userId,
          entry.orgId,
          entry.encryptedParams,
          entry.createdAt,
          entry.expiresAt,
        );
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      log.error(`Failed to dispatch queued run ${runId}: ${errorMessage}`);
      await markQueuedRunFailed(runId, errorMessage);
      entry = await dequeueNext(orgId);
      continue;
    }
  }
}

interface QueueEntry {
  runId: string;
  userId: string;
  orgId: string;
  encryptedParams: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Atomically dequeue the oldest queue entry for an org.
 *
 * SELECT FOR UPDATE SKIP LOCKED + DELETE run inside a single transaction
 * so the row-level lock is held until the delete commits, preventing
 * concurrent dequeue of the same entry.
 */
async function dequeueNext(orgId: string): Promise<QueueEntry | undefined> {
  return globalThis.services.db.transaction(async (tx) => {
    const rows = await tx.execute<{
      run_id: string;
      user_id: string;
      org_id: string;
      encrypted_params: string | null;
      created_at: string;
      expires_at: string;
    }>(
      sql`SELECT run_id, user_id, org_id, encrypted_params, created_at, expires_at
       FROM agent_run_queue
       WHERE org_id = ${orgId}
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );

    const row = rows.rows[0];
    if (!row) {
      return undefined;
    }

    // Delete queue entry within the same transaction
    await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, row.run_id));

    log.debug(`Dequeued run ${row.run_id} for org ${orgId}`);
    return {
      runId: row.run_id,
      userId: row.user_id,
      orgId: row.org_id,
      encryptedParams: row.encrypted_params,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    };
  });
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

  const runIds = deleted.map((e) => e.runId);

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
 * @param execute - Executor function (injected to avoid circular dependency)
 */
export async function drainStaleQueues(
  execute: QueuedRunExecutor,
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
      await drainOrgQueue(orgId, execute);
      drained++;
    }
  }

  return drained;
}

/**
 * Re-enqueue a run that was dequeued but couldn't execute due to concurrency.
 * Preserves the original createdAt to maintain FIFO ordering.
 */
async function reEnqueueRun(
  runId: string,
  userId: string,
  orgId: string,
  encryptedParams: string | null,
  originalCreatedAt: Date,
  originalExpiresAt: Date,
): Promise<void> {
  await globalThis.services.db.insert(agentRunQueue).values({
    runId,
    userId,
    orgId,
    encryptedParams,
    createdAt: originalCreatedAt,
    expiresAt: originalExpiresAt,
  });
  log.debug(`Re-enqueued run ${runId} (concurrency conflict)`);
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
