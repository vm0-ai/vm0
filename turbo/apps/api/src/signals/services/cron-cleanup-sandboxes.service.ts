import { command } from "ccstate";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { agentRunCustomConnectorAuthRefs } from "@vm0/db/schema/agent-run-custom-connector-auth-ref";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { exportJobs } from "@vm0/db/schema/export-job";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  publishOrgSignal,
  publishRunChangedForUserSafely,
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { deleteS3Objects } from "../external/s3";
import { settle } from "../utils";
import { dispatchCompleteSideEffects$ } from "./agent-webhook-complete.service";
import {
  cleanupExpiredQueueEntries$,
  cleanupQueuedRunLaunchOrphans$,
  drainStaleQueues$,
  type QueuedRunMaintenanceTimeout,
} from "./zero-run-queue.service";
import type { QueueMarkerRevokeNotification } from "./zero-chat-queue-marker.service";

const L = logger("CronCleanupSandboxes");

const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
const DEBUG_HEARTBEAT_TIMEOUT_MS = 60 * 60 * 1000;
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const DEBUG_COMPOSE_PREFIX = "debug-";
const EXPORT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

interface CleanupResult {
  readonly runId: string;
  readonly sandboxId: string | null;
  readonly status: "cleaned" | "error";
  readonly error?: string;
  readonly reason?: string;
}

interface CleanupSandboxesResult {
  readonly cleaned: number;
  readonly errors: number;
  readonly results: readonly CleanupResult[];
  readonly exportJobsCleaned: number;
  readonly exportJobsStuck: number;
}

interface StaleRun {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly sandboxId: string | null;
  readonly lastHeartbeatAt: Date | null;
  readonly createdAt: Date;
  readonly composeName: string | null;
}

interface CleanupCutoffs {
  readonly running: Date;
  readonly debug: Date;
  readonly pending: Date;
}

interface MaintenanceTerminalSideEffectsInput {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly error: string;
  readonly queueChanged: boolean;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}

function staleRunCutoff(run: StaleRun, cutoffs: CleanupCutoffs): Date {
  if (run.status === "pending") {
    return cutoffs.pending;
  }

  const isDebug = run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
  return isDebug ? cutoffs.debug : cutoffs.running;
}

function isExpiredRun(run: StaleRun, cutoffs: CleanupCutoffs): boolean {
  const referenceTime = run.lastHeartbeatAt ?? run.createdAt;
  return referenceTime < staleRunCutoff(run, cutoffs);
}

async function publishQueueChangedSafely(
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await settle(publishOrgSignal(orgId, "queue:changed"), signal);
  if (!result.ok) {
    L.warn("Failed to publish queue changed signal", {
      orgId,
      error: result.error,
    });
  }
}

async function publishQueueMarkerNotificationSafely(
  notification: QueueMarkerRevokeNotification,
  signal: AbortSignal,
): Promise<void> {
  const messageResult = await settle(
    publishUserSignal(
      [notification.userId],
      `chatThreadMessageCreated:${notification.chatThreadId}`,
    ),
    signal,
  );
  if (!messageResult.ok) {
    L.warn("Failed to publish queue marker revocation signal", {
      userId: notification.userId,
      chatThreadId: notification.chatThreadId,
      error: messageResult.error,
    });
  }

  const threadListResult = await settle(
    publishThreadListChanged(notification.userId),
    signal,
  );
  if (!threadListResult.ok) {
    L.warn("Failed to publish queue marker thread list signal", {
      userId: notification.userId,
      chatThreadId: notification.chatThreadId,
      error: threadListResult.error,
    });
  }
}

const cleanupExportJobs$ = command(
  async (
    { get },
    db: Db,
    signal: AbortSignal,
  ): Promise<{
    readonly exportJobsCleaned: number;
    readonly exportJobsStuck: number;
  }> => {
    let exportJobsCleaned = 0;
    let exportJobsStuck = 0;
    const currentTime = nowDate();

    const expiredExports = await db
      .select({ id: exportJobs.id, s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.status, "completed"),
          isNotNull(exportJobs.expiresAt),
          lt(exportJobs.expiresAt, currentTime),
        ),
      );
    signal.throwIfAborted();

    if (expiredExports.length > 0) {
      const s3Keys = expiredExports
        .map((entry) => {
          return entry.s3Key;
        })
        .filter((key): key is string => {
          return key !== null;
        });
      if (s3Keys.length > 0) {
        await get(deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), s3Keys));
        signal.throwIfAborted();
      }

      await db.delete(exportJobs).where(
        inArray(
          exportJobs.id,
          expiredExports.map((entry) => {
            return entry.id;
          }),
        ),
      );
      signal.throwIfAborted();

      exportJobsCleaned = expiredExports.length;
      L.debug("Cleaned up expired export jobs", { count: exportJobsCleaned });
    }

    const stuckCutoffTime = new Date(now() - EXPORT_JOB_TIMEOUT_MS);
    const stuckExportJobs = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          inArray(exportJobs.status, ["pending", "running"]),
          lt(exportJobs.createdAt, stuckCutoffTime),
        ),
      );
    signal.throwIfAborted();

    for (const job of stuckExportJobs) {
      await db
        .update(exportJobs)
        .set({
          status: "failed",
          completedAt: currentTime,
          error: "Export job timed out",
        })
        .where(
          and(
            eq(exportJobs.id, job.id),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        );
      signal.throwIfAborted();
      exportJobsStuck++;
    }

    if (exportJobsStuck > 0) {
      L.debug("Failed stuck export jobs", { count: exportJobsStuck });
    }

    return { exportJobsCleaned, exportJobsStuck };
  },
);

const dispatchMaintenanceTerminalSideEffects$ = command(
  async (
    { set },
    input: MaintenanceTerminalSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await publishRunChangedForUserSafely(input.userId, input.runId, {
      status: "failed",
    });
    signal.throwIfAborted();

    if (input.queueChanged) {
      await publishQueueChangedSafely(input.orgId, signal);
    }

    if (input.queueMarkerNotification) {
      await publishQueueMarkerNotificationSafely(
        input.queueMarkerNotification,
        signal,
      );
    }

    await set(
      dispatchCompleteSideEffects$,
      {
        runId: input.runId,
        orgId: input.orgId,
        status: "failed",
        error: input.error,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

const cleanupSingleRun$ = command(
  async (
    { set },
    db: Db,
    run: StaleRun,
    cutoffs: CleanupCutoffs,
    signal: AbortSignal,
  ): Promise<CleanupResult | undefined> => {
    const timeoutReason =
      run.status === "pending"
        ? "Run timed out while pending (never started)"
        : "Run timed out (no heartbeat)";
    const cutoff = staleRunCutoff(run, cutoffs);

    const updated = await db.transaction(async (tx) => {
      const [updatedRun] = await tx
        .update(agentRuns)
        .set({
          status: "timeout",
          completedAt: nowDate(),
          error: timeoutReason,
        })
        .where(
          and(
            eq(agentRuns.id, run.id),
            eq(agentRuns.status, run.status),
            sql`COALESCE(${agentRuns.lastHeartbeatAt}, ${agentRuns.createdAt}) < ${sql.param(
              cutoff,
              agentRuns.createdAt,
            )}`,
          ),
        )
        .returning({ id: agentRuns.id });
      signal.throwIfAborted();

      if (!updatedRun) {
        return undefined;
      }

      await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, run.id));
      signal.throwIfAborted();

      return updatedRun;
    });
    signal.throwIfAborted();

    if (!updated) {
      L.debug("Run already transitioned, skipping timeout", { runId: run.id });
      return undefined;
    }

    await set(
      dispatchMaintenanceTerminalSideEffects$,
      {
        runId: run.id,
        orgId: run.orgId,
        userId: run.userId,
        error: timeoutReason,
        queueChanged: false,
        queueMarkerNotification: null,
      },
      signal,
    );
    signal.throwIfAborted();

    const isDebug = run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
    const referenceTime = run.lastHeartbeatAt ?? run.createdAt;
    L.debug("Cleaned up expired run", {
      runId: run.id,
      status: run.status,
      sandboxId: run.sandboxId,
      composeName: run.composeName,
      isDebug,
      referenceTime: referenceTime.toISOString(),
    });

    return {
      runId: run.id,
      sandboxId: run.sandboxId,
      status: "cleaned",
      reason: timeoutReason,
    };
  },
);

const cleanupQueuedTerminalRuns$ = command(
  async (
    { set },
    runs: readonly QueuedRunMaintenanceTimeout[],
    signal: AbortSignal,
  ): Promise<CleanupResult[]> => {
    const results: CleanupResult[] = [];
    for (const run of runs) {
      const cleanupResult = await settle(
        set(
          dispatchMaintenanceTerminalSideEffects$,
          {
            runId: run.runId,
            orgId: run.orgId,
            userId: run.userId,
            error: run.error,
            queueChanged: true,
            queueMarkerNotification: run.queueMarkerNotification,
          },
          signal,
        ),
      );
      signal.throwIfAborted();

      if (cleanupResult.ok) {
        results.push({
          runId: run.runId,
          sandboxId: null,
          status: "cleaned",
          reason: run.error,
        });
        continue;
      }

      const errorMessage =
        cleanupResult.error instanceof Error
          ? cleanupResult.error.message
          : "Unknown error";
      L.error("Failed to dispatch queued run timeout side effects", {
        runId: run.runId,
        error: errorMessage,
      });
      results.push({
        runId: run.runId,
        sandboxId: null,
        status: "error",
        error: errorMessage,
      });
    }
    return results;
  },
);

const cleanupExpiredRuns$ = command(
  async (
    { set },
    db: Db,
    runs: readonly StaleRun[],
    cutoffs: CleanupCutoffs,
    signal: AbortSignal,
  ): Promise<CleanupResult[]> => {
    const results: CleanupResult[] = [];
    for (const run of runs) {
      const cleanupResult = await settle(
        set(cleanupSingleRun$, db, run, cutoffs, signal),
      );
      signal.throwIfAborted();

      if (cleanupResult.ok) {
        if (cleanupResult.value) {
          results.push(cleanupResult.value);
        }
        continue;
      }

      const errorMessage =
        cleanupResult.error instanceof Error
          ? cleanupResult.error.message
          : "Unknown error";
      L.error("Failed to cleanup run", {
        runId: run.id,
        error: errorMessage,
      });
      results.push({
        runId: run.id,
        sandboxId: run.sandboxId,
        status: "error",
        error: errorMessage,
      });
    }
    return results;
  },
);

async function cleanupExpiredRunnerJobs(
  db: Db,
  signal: AbortSignal,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM ${runnerJobQueue}
    WHERE ${runnerJobQueue.expiresAt} <= now()
  `);
  signal.throwIfAborted();

  const deletedCount = Number(result.rowCount ?? 0);
  if (deletedCount > 0) {
    L.debug("Cleaned up expired runner job queue entries", {
      count: deletedCount,
    });
  }
  return deletedCount;
}

async function cleanupExpiredCustomConnectorAuthRefs(
  db: Db,
  signal: AbortSignal,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM ${agentRunCustomConnectorAuthRefs}
    WHERE ${agentRunCustomConnectorAuthRefs.expiresAt} <= now()
  `);
  signal.throwIfAborted();

  const deletedCount = Number(result.rowCount ?? 0);
  if (deletedCount > 0) {
    L.debug("Cleaned up expired custom connector auth refs", {
      count: deletedCount,
    });
  }
  return deletedCount;
}

async function cleanupExpiredCustomConnectorAuthRefsSafely(
  db: Db,
  signal: AbortSignal,
): Promise<number> {
  const result = await settle(
    cleanupExpiredCustomConnectorAuthRefs(db, signal),
    signal,
  );
  if (result.ok) {
    return result.value;
  }

  L.error("Failed to cleanup expired custom connector auth refs", {
    error:
      result.error instanceof Error ? result.error.message : "Unknown error",
  });
  return 0;
}

export const cleanupSandboxes$ = command(
  async ({ set }, signal: AbortSignal): Promise<CleanupSandboxesResult> => {
    const db = set(writeDb$);
    const currentTime = now();
    const cutoffs = {
      running: new Date(currentTime - HEARTBEAT_TIMEOUT_MS),
      debug: new Date(currentTime - DEBUG_HEARTBEAT_TIMEOUT_MS),
      pending: new Date(currentTime - PENDING_TIMEOUT_MS),
    };

    L.debug("Checking for expired runs", {
      runningBefore: cutoffs.running.toISOString(),
      pendingBefore: cutoffs.pending.toISOString(),
      debugBefore: cutoffs.debug.toISOString(),
    });

    const staleRuns = await db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        status: agentRuns.status,
        sandboxId: agentRuns.sandboxId,
        lastHeartbeatAt: agentRuns.lastHeartbeatAt,
        createdAt: agentRuns.createdAt,
        composeName: agentComposes.name,
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
      .where(inArray(agentRuns.status, ["pending", "running"]));
    signal.throwIfAborted();

    const expiredRuns = staleRuns.filter((run) => {
      return isExpiredRun(run, cutoffs);
    });

    const expiredQueueResult = await set(cleanupExpiredQueueEntries$, signal);
    signal.throwIfAborted();
    const queuedOrphanResult = await set(
      cleanupQueuedRunLaunchOrphans$,
      cutoffs.pending,
      signal,
    );
    signal.throwIfAborted();
    const expiredRunnerJobCount = await cleanupExpiredRunnerJobs(db, signal);
    signal.throwIfAborted();
    const expiredCustomConnectorAuthRefCount =
      await cleanupExpiredCustomConnectorAuthRefsSafely(db, signal);
    signal.throwIfAborted();
    const drainedCount = await set(drainStaleQueues$, signal);
    signal.throwIfAborted();
    const queuedTerminalRuns = [
      ...expiredQueueResult.timedOutRuns,
      ...queuedOrphanResult.timedOutRuns,
    ];
    if (
      expiredQueueResult.deletedCount > 0 ||
      queuedTerminalRuns.length > 0 ||
      expiredRunnerJobCount > 0 ||
      expiredCustomConnectorAuthRefCount > 0 ||
      drainedCount > 0
    ) {
      L.debug("Queue maintenance completed", {
        expired: expiredQueueResult.deletedCount,
        expiredTimedOut: expiredQueueResult.timedOutRuns.length,
        launchOrphansTimedOut: queuedOrphanResult.timedOutRuns.length,
        expiredRunnerJobs: expiredRunnerJobCount,
        expiredCustomConnectorAuthRefs: expiredCustomConnectorAuthRefCount,
        drained: drainedCount,
      });
    }

    if (expiredRuns.length === 0) {
      L.debug("No expired sandboxes found");
    } else {
      L.debug("Found expired sandboxes to cleanup", {
        count: expiredRuns.length,
      });
    }

    const queuedResults = await set(
      cleanupQueuedTerminalRuns$,
      queuedTerminalRuns,
      signal,
    );
    signal.throwIfAborted();
    const expiredRunResults = await set(
      cleanupExpiredRuns$,
      db,
      expiredRuns,
      cutoffs,
      signal,
    );
    signal.throwIfAborted();
    const results = [...queuedResults, ...expiredRunResults];

    const { exportJobsCleaned, exportJobsStuck } = await set(
      cleanupExportJobs$,
      db,
      signal,
    );

    return {
      cleaned: results.filter((result) => {
        return result.status === "cleaned";
      }).length,
      errors: results.filter((result) => {
        return result.status === "error";
      }).length,
      results,
      exportJobsCleaned,
      exportJobsStuck,
    };
  },
);
