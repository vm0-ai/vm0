import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { cronCleanupSandboxesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  transitionRunStatus,
  dispatchTerminalSideEffects,
} from "../../../../src/lib/run/run-status";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../../src/db/schema/agent-compose";
import { and, eq, inArray, lt, isNotNull } from "drizzle-orm";
import { composeJobs } from "../../../../src/db/schema/compose-job";
import { exportJobs } from "../../../../src/db/schema/export-job";
import { deleteS3Objects } from "../../../../src/lib/s3/s3-client";
import {
  cleanupExpiredQueueEntries,
  drainStaleQueues,
  drainOrgQueue,
} from "../../../../src/lib/run/run-queue-service";
import { dispatchQueuedRun } from "../../../../src/lib/run/run-service";
import { logger } from "../../../../src/lib/logger";
import { env } from "../../../../src/env";

const log = logger("cron:cleanup-sandboxes");

// Heartbeat timeout: 2 minutes (2x the 60s heartbeat interval) for running status
const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
// Debug mode timeout: 1 hour (for debugging sandbox issues)
const DEBUG_HEARTBEAT_TIMEOUT_MS = 60 * 60 * 1000;
// Pending timeout: 5 minutes (for runs stuck in pending state)
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
// Compose job timeout: 10 minutes (2x the 5-minute sandbox timeout)
const COMPOSE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
// Compose names starting with this prefix use debug timeout
const DEBUG_COMPOSE_PREFIX = "debug-";

// Export job timeout: 10 minutes
const EXPORT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Clean up expired export jobs (delete R2 objects) and fail stuck jobs.
 */
async function cleanupExportJobs(
  now: number,
): Promise<{ exportJobsCleaned: number; exportJobsStuck: number }> {
  let exportJobsCleaned = 0;
  let exportJobsStuck = 0;

  // 1. Clean up expired completed exports
  const expiredExports = await globalThis.services.db
    .select({ id: exportJobs.id, s3Key: exportJobs.s3Key })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.status, "completed"),
        isNotNull(exportJobs.expiresAt),
        lt(exportJobs.expiresAt, new Date()),
      ),
    );

  if (expiredExports.length > 0) {
    const s3Keys = expiredExports
      .map((e) => e.s3Key)
      .filter((k): k is string => k !== null);
    if (s3Keys.length > 0) {
      await deleteS3Objects(env().R2_USER_STORAGES_BUCKET_NAME, s3Keys);
    }

    const expiredIds = expiredExports.map((e) => e.id);
    await globalThis.services.db
      .delete(exportJobs)
      .where(inArray(exportJobs.id, expiredIds));

    exportJobsCleaned = expiredExports.length;
    log.debug(`Cleaned up ${exportJobsCleaned} expired export jobs`);
  }

  // 2. Fail stuck export jobs (pending/running > 10 minutes)
  const exportJobCutoffTime = new Date(now - EXPORT_JOB_TIMEOUT_MS);
  const stuckExportJobs = await globalThis.services.db
    .select({ id: exportJobs.id })
    .from(exportJobs)
    .where(
      and(
        inArray(exportJobs.status, ["pending", "running"]),
        lt(exportJobs.createdAt, exportJobCutoffTime),
      ),
    );

  for (const job of stuckExportJobs) {
    await globalThis.services.db
      .update(exportJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        error: "Export job timed out",
      })
      .where(
        and(
          eq(exportJobs.id, job.id),
          inArray(exportJobs.status, ["pending", "running"]),
        ),
      );
    exportJobsStuck++;
  }

  if (exportJobsStuck > 0) {
    log.debug(`Failed ${exportJobsStuck} stuck export jobs`);
  }

  return { exportJobsCleaned, exportJobsStuck };
}

interface CleanupResult {
  runId: string;
  sandboxId: string | null;
  status: "cleaned" | "error";
  error?: string;
  reason?: string;
}

const router = tsr.router(cronCleanupSandboxesContract, {
  cleanup: async ({ headers }) => {
    initServices();

    // Verify cron secret (Vercel automatically injects CRON_SECRET into Authorization header)
    const authHeader = headers.authorization;
    const cronSecret = env().CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return createErrorResponse("UNAUTHORIZED", "Invalid cron secret");
    }

    const now = Date.now();
    const runningCutoffTime = new Date(now - HEARTBEAT_TIMEOUT_MS);
    const debugCutoffTime = new Date(now - DEBUG_HEARTBEAT_TIMEOUT_MS);
    const pendingCutoffTime = new Date(now - PENDING_TIMEOUT_MS);

    log.debug(
      `Checking for expired runs (running: before ${runningCutoffTime.toISOString()}, pending: before ${pendingCutoffTime.toISOString()}, debug: before ${debugCutoffTime.toISOString()})...`,
    );

    // Find all pending and running runs with their compose names
    // We'll filter by appropriate timeout based on status and compose name
    const staleRuns = await globalThis.services.db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
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

    // Filter runs based on their status and timeout
    // Use lastHeartbeatAt if available, otherwise fall back to createdAt
    const expiredRuns = staleRuns.filter((run) => {
      const isDebug =
        run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;

      // Use lastHeartbeatAt if available, otherwise fall back to createdAt
      const referenceTime = run.lastHeartbeatAt ?? run.createdAt;

      // Determine timeout based on status
      let cutoffTime: Date;
      if (run.status === "pending") {
        cutoffTime = pendingCutoffTime; // 5 minutes for pending
      } else {
        // running status
        cutoffTime = isDebug ? debugCutoffTime : runningCutoffTime;
      }

      return referenceTime < cutoffTime;
    });

    // Run queue maintenance: clean up expired entries and drain stale queues
    // This must run regardless of whether there are expired sandboxes,
    // as it serves as the fallback for missed webhook-triggered drains.
    const [expiredQueueCount, drainedCount] = await Promise.all([
      cleanupExpiredQueueEntries(),
      drainStaleQueues(dispatchQueuedRun),
    ]);

    if (expiredQueueCount > 0 || drainedCount > 0) {
      log.debug(
        `Queue maintenance: expired=${expiredQueueCount}, drained=${drainedCount}`,
      );
    }

    const results: CleanupResult[] = [];

    if (expiredRuns.length === 0) {
      log.debug("No expired sandboxes found");
    } else {
      log.debug(`Found ${expiredRuns.length} expired sandboxes to cleanup`);

      for (const run of expiredRuns) {
        try {
          // Determine error message based on status
          const timeoutReason =
            run.status === "pending"
              ? "Run timed out while pending (never started)"
              : "Run timed out (no heartbeat)";

          // Update run status to timeout (only if still pending/running)
          const transitioned = await transitionRunStatus(
            run.id,
            {
              status: "timeout",
              completedAt: new Date(),
              error: timeoutReason,
            },
            ["pending", "running"],
          );

          if (!transitioned) {
            log.debug(`Run ${run.id} already transitioned, skipping timeout`);
            continue;
          }

          // Dispatch callbacks (e.g., loop schedule advancement) and drain queue
          await dispatchTerminalSideEffects(
            run.id,
            "timeout",
            timeoutReason,
            () => drainOrgQueue(run.orgId, dispatchQueuedRun),
          );

          const isDebug =
            run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
          const referenceTime = run.lastHeartbeatAt ?? run.createdAt;
          log.debug(
            `Cleaned up expired run ${run.id} (status: ${run.status}, sandbox: ${run.sandboxId}, compose: ${run.composeName ?? "unknown"}, debug: ${isDebug}, reference time: ${referenceTime.toISOString()})`,
          );

          results.push({
            runId: run.id,
            sandboxId: run.sandboxId,
            status: "cleaned",
            reason: timeoutReason,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          log.error(`Failed to cleanup run ${run.id}: ${errorMessage}`);

          results.push({
            runId: run.id,
            sandboxId: run.sandboxId,
            status: "error",
            error: errorMessage,
          });
        }
      }
    }

    // Compose job cleanup: fail stuck compose jobs that exceeded the timeout.
    // Compose jobs rely on a webhook callback from E2B sandbox to update status.
    // When the webhook fails, jobs get stuck in pending/running and block the
    // user from creating new jobs (partial unique index: one active job per user).
    const composeJobCutoffTime = new Date(now - COMPOSE_JOB_TIMEOUT_MS);
    const staleComposeJobs = await globalThis.services.db
      .select({
        id: composeJobs.id,
        status: composeJobs.status,
        createdAt: composeJobs.createdAt,
      })
      .from(composeJobs)
      .where(
        and(
          inArray(composeJobs.status, ["pending", "running"]),
          lt(composeJobs.createdAt, composeJobCutoffTime),
        ),
      );

    let composeJobsCleaned = 0;
    let composeJobErrors = 0;
    if (staleComposeJobs.length > 0) {
      log.debug(
        `Found ${staleComposeJobs.length} stale compose jobs to cleanup`,
      );

      for (const job of staleComposeJobs) {
        try {
          await globalThis.services.db
            .update(composeJobs)
            .set({
              status: "failed",
              completedAt: new Date(),
              error: "Compose job timed out (no completion callback received)",
            })
            .where(
              and(
                eq(composeJobs.id, job.id),
                inArray(composeJobs.status, ["pending", "running"]),
              ),
            );

          log.debug(
            `Cleaned up stale compose job ${job.id} (status: ${job.status}, created: ${job.createdAt.toISOString()})`,
          );
          composeJobsCleaned++;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          log.error(`Failed to cleanup compose job ${job.id}: ${errorMessage}`);
          composeJobErrors++;
        }
      }
    }

    // Export job cleanup
    const { exportJobsCleaned, exportJobsStuck } = await cleanupExportJobs(now);

    return {
      status: 200 as const,
      body: {
        cleaned: results.filter((r) => r.status === "cleaned").length,
        errors: results.filter((r) => r.status === "error").length,
        results,
        composeJobsCleaned,
        composeJobErrors,
        exportJobsCleaned,
        exportJobsStuck,
      },
    };
  },
});

const handler = createHandler(cronCleanupSandboxesContract, router);

export { handler as GET };
