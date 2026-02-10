import {
  createHandler,
  tsr,
  validationErrorHandler,
} from "../../../../../../src/lib/ts-rest-handler";
import { runsCancelContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../../src/lib/logger";
import { killSandbox } from "../../../../../../src/lib/sandbox/sandbox-service";

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
    if (run.status !== "pending" && run.status !== "running") {
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

    // Update run status to cancelled
    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "cancelled",
        completedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));

    // Kill E2B sandbox if it exists
    if (run.sandboxId) {
      await killSandbox(run.sandboxId);
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

const handler = createHandler(runsCancelContract, router, {
  errorHandler: validationErrorHandler,
});

export { handler as POST };
