import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import { e2bService } from "../../../../src/lib/e2b/e2b-service";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { UnauthorizedError } from "../../../../src/lib/errors";
import { logger } from "../../../../src/lib/logger";

const log = logger("cron:cleanup-sandboxes");

// Heartbeat timeout: 2 minutes (2x the 60s heartbeat interval)
const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;

interface CleanupResult {
  runId: string;
  sandboxId: string | null;
  status: "cleaned" | "error";
  error?: string;
}

interface CleanupResponse {
  cleaned: number;
  errors: number;
  results: CleanupResult[];
}

/**
 * GET /api/cron/cleanup-sandboxes
 * Cron job to cleanup sandboxes that have stopped sending heartbeats
 *
 * This endpoint is called by Vercel Cron every minute.
 * It finds all running agent runs that haven't sent a heartbeat in 2+ minutes
 * and cleans them up.
 */
export async function GET(request: NextRequest) {
  try {
    initServices();

    // Verify cron secret (Vercel adds this header for cron jobs)
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      throw new UnauthorizedError("Invalid cron secret");
    }

    const cutoffTime = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS);

    log.debug(
      `Checking for expired sandboxes (heartbeat before ${cutoffTime.toISOString()})...`,
    );

    // Find all running runs with expired heartbeats
    const expiredRuns = await globalThis.services.db
      .select({
        id: agentRuns.id,
        sandboxId: agentRuns.sandboxId,
        lastHeartbeatAt: agentRuns.lastHeartbeatAt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.status, "running"),
          isNotNull(agentRuns.lastHeartbeatAt),
          lt(agentRuns.lastHeartbeatAt, cutoffTime),
        ),
      );

    if (expiredRuns.length === 0) {
      log.debug("No expired sandboxes found");
      const response: CleanupResponse = {
        cleaned: 0,
        errors: 0,
        results: [],
      };
      return successResponse(response, 200);
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

        log.debug(
          `Cleaned up expired run ${run.id} (sandbox: ${run.sandboxId}, last heartbeat: ${run.lastHeartbeatAt?.toISOString()})`,
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

    const response: CleanupResponse = {
      cleaned: results.filter((r) => r.status === "cleaned").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    };

    return successResponse(response, 200);
  } catch (error) {
    log.error("Cron cleanup error:", error);
    return errorResponse(error);
  }
}
