import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runnersPollContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { runnerJobQueue } from "../../../../src/db/schema/runner-job-queue";
import { eq, and, isNull } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";
import { validateRunnerGroupScope } from "../../../../src/lib/scope/scope-service";

const log = logger("api:runners:poll");

const router = tsr.router(runnersPollContract, {
  poll: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const { group } = body;

    // Validate runner group scope matches user's scope
    try {
      await validateRunnerGroupScope(userId, group);
    } catch (error) {
      return createErrorResponse(
        "FORBIDDEN",
        error instanceof Error ? error.message : "Scope validation failed",
      );
    }

    // Query runner_job_queue for unclaimed jobs belonging to the authenticated user
    const [pendingJob] = await globalThis.services.db
      .select({
        runId: runnerJobQueue.runId,
        prompt: agentRuns.prompt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        vars: agentRuns.vars,
        secretNames: agentRuns.secretNames,
        resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .where(
        and(
          eq(runnerJobQueue.runnerGroup, group),
          isNull(runnerJobQueue.claimedAt),
          eq(agentRuns.userId, userId),
        ),
      )
      .limit(1);

    // Alias for backward compatibility
    const pendingRun = pendingJob;

    if (pendingRun) {
      log.debug(`Found pending job: ${pendingRun.runId}`);
      return {
        status: 200 as const,
        body: {
          job: {
            runId: pendingRun.runId,
            prompt: pendingRun.prompt,
            agentComposeVersionId: pendingRun.agentComposeVersionId,
            vars: (pendingRun.vars as Record<string, string>) ?? null,
            secretNames: pendingRun.secretNames ?? null,
            checkpointId: pendingRun.resumedFromCheckpointId ?? null,
          },
        },
      };
    }

    // No pending job found
    return {
      status: 200 as const,
      body: {
        job: null,
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
  }

  return undefined;
}

const handler = createHandler(runnersPollContract, router, {
  errorHandler,
});

export { handler as POST };
