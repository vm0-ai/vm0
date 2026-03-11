import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { runsCancelContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentRunQueue } from "../../../../../../src/db/schema/agent-run-queue";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../../src/lib/logger";
import { drainUserQueue } from "../../../../../../src/lib/run/run-queue-service";
import { executeQueuedRun } from "../../../../../../src/lib/run/run-service";
import { after } from "next/server";

const log = logger("api:runs:cancel");

const router = tsr.router(runsCancelContract, {
  cancel: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { id: runId } = params;

    // Find the run
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: `No such run: '${runId}'`, code: "NOT_FOUND" },
        },
      };
    }

    // Check if run can be cancelled
    if (
      run.status !== "queued" &&
      run.status !== "pending" &&
      run.status !== "running"
    ) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Run cannot be cancelled: current status is '${run.status}'`,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // If queued, remove from queue table (encrypted secrets deleted)
    if (run.status === "queued") {
      await globalThis.services.db
        .delete(agentRunQueue)
        .where(eq(agentRunQueue.runId, runId));
    }

    // Update run status to cancelled
    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "cancelled",
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    // Drain queue if cancelling a running/pending run freed a concurrency slot
    if (run.status === "running" || run.status === "pending") {
      after(async () => {
        await drainUserQueue(userId, executeQueuedRun).catch((err) =>
          log.error("Failed to drain user queue after cancel", { err }),
        );
      });
    }

    log.debug(
      `Run ${runId} cancelled by user ${userId}, sandbox: ${run.sandboxId ?? "none"}`,
    );

    return {
      status: 200 as const,
      body: {
        id: runId,
        status: "cancelled" as const,
        message: "Run cancelled successfully",
      },
    };
  },
});

const handler = createHandler(runsCancelContract, router);

export { handler as POST };
