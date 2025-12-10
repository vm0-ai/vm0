import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { cronCleanupSandboxesContract, createErrorResponse } from "@vm0/core";
import { headers } from "next/headers";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import { e2bService } from "../../../../src/lib/e2b/e2b-service";
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

const router = tsr.router(cronCleanupSandboxesContract, {
  cleanup: async () => {
    initServices();

    // Verify cron secret (Vercel automatically injects CRON_SECRET into Authorization header)
    const headersList = await headers();
    const authHeader = headersList.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return createErrorResponse("UNAUTHORIZED", "Invalid cron secret");
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

const handler = createNextHandler(cronCleanupSandboxesContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
});

export { handler as GET };
