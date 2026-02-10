import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { cronCleanupSandboxesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../../src/db/schema/agent-compose";
import { eq, inArray } from "drizzle-orm";
import { killSandbox } from "../../../../src/lib/sandbox/sandbox-service";
import { logger } from "../../../../src/lib/logger";

const log = logger("cron:cleanup-sandboxes");

// Heartbeat timeout: 2 minutes (2x the 60s heartbeat interval) for running status
const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
// Debug mode timeout: 1 hour (for debugging sandbox issues)
const DEBUG_HEARTBEAT_TIMEOUT_MS = 60 * 60 * 1000;
// Pending timeout: 5 minutes (for runs stuck in pending state)
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
// Compose names starting with this prefix use debug timeout
const DEBUG_COMPOSE_PREFIX = "debug-";

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
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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

    if (expiredRuns.length === 0) {
      log.debug("No expired sandboxes found");
      return {
        status: 200 as const,
        body: {
          cleaned: 0,
          errors: 0,
          results: [],
        },
      };
    }

    log.debug(`Found ${expiredRuns.length} expired sandboxes to cleanup`);

    const results: CleanupResult[] = [];

    for (const run of expiredRuns) {
      try {
        // Kill the E2B sandbox only if it exists (pending runs may not have one)
        if (run.sandboxId) {
          await killSandbox(run.sandboxId);
        }

        // Determine error message based on status
        const timeoutReason =
          run.status === "pending"
            ? "Run timed out while pending (never started)"
            : "Run timed out (no heartbeat)";

        // Update run status to timeout
        await globalThis.services.db
          .update(agentRuns)
          .set({
            status: "timeout",
            completedAt: new Date(),
            error: timeoutReason,
          })
          .where(eq(agentRuns.id, run.id));

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

    return {
      status: 200 as const,
      body: {
        cleaned: results.filter((r) => r.status === "cleaned").length,
        errors: results.filter((r) => r.status === "error").length,
        results,
      },
    };
  },
});

const handler = createHandler(cronCleanupSandboxesContract, router);

export { handler as GET };
