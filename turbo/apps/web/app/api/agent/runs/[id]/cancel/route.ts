import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { runsCancelContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../../src/lib/logger";

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

    log.debug(`Run ${runId} cancelled by user ${userId}`);

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

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(runsCancelContract, router, {
  errorHandler,
});

export { handler as POST };
