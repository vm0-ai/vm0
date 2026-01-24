import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { cronCleanupSandboxesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../../src/db/schema/agent-compose";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import { e2bService } from "../../../../src/lib/e2b/e2b-service";
import { logger } from "../../../../src/lib/logger";

const log = logger("cron:cleanup-sandboxes");

// Heartbeat timeout: 2 minutes (2x the 60s heartbeat interval)
const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
// Debug mode timeout: 1 hour (for debugging sandbox issues)
const DEBUG_HEARTBEAT_TIMEOUT_MS = 60 * 60 * 1000;
// Compose names starting with this prefix use debug timeout
const DEBUG_COMPOSE_PREFIX = "debug-";

interface CleanupResult {
  runId: string;
  sandboxId: string | null;
  status: "cleaned" | "error";
  error?: string;
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
    const normalCutoffTime = new Date(now - HEARTBEAT_TIMEOUT_MS);
    const debugCutoffTime = new Date(now - DEBUG_HEARTBEAT_TIMEOUT_MS);

    log.debug(
      `Checking for expired sandboxes (normal: before ${normalCutoffTime.toISOString()}, debug: before ${debugCutoffTime.toISOString()})...`,
    );

    // Find all running runs with their compose names
    // Use the normal (shorter) cutoff to get all potentially expired runs
    // Then filter by appropriate timeout based on compose name
    const runningRuns = await globalThis.services.db
      .select({
        id: agentRuns.id,
        sandboxId: agentRuns.sandboxId,
        lastHeartbeatAt: agentRuns.lastHeartbeatAt,
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
      .where(
        and(
          eq(agentRuns.status, "running"),
          isNotNull(agentRuns.lastHeartbeatAt),
          lt(agentRuns.lastHeartbeatAt, normalCutoffTime),
        ),
      );

    // Filter runs based on their timeout (debug vs normal)
    // If compose name is not available (orphaned run), use normal timeout
    const expiredRuns = runningRuns.filter((run) => {
      const isDebug =
        run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
      const cutoffTime = isDebug ? debugCutoffTime : normalCutoffTime;
      return run.lastHeartbeatAt && run.lastHeartbeatAt < cutoffTime;
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
        // Kill the E2B sandbox if it exists
        if (run.sandboxId) {
          await e2bService.killSandbox(run.sandboxId);
        }

        // Update run status to timeout
        await globalThis.services.db
          .update(agentRuns)
          .set({
            status: "timeout",
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));

        const isDebug =
          run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
        log.debug(
          `Cleaned up expired run ${run.id} (sandbox: ${run.sandboxId}, compose: ${run.composeName ?? "unknown"}, debug: ${isDebug}, last heartbeat: ${run.lastHeartbeatAt?.toISOString()})`,
        );

        results.push({
          runId: run.id,
          sandboxId: run.sandboxId,
          status: "cleaned",
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
