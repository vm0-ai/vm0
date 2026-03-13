import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runnersPollContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { runnerJobQueue } from "../../../../src/db/schema/runner-job-queue";
import { eq, and, isNull, type SQL } from "drizzle-orm";
import { getRunnerAuth } from "../../../../src/lib/auth/runner-auth";
import { logger } from "../../../../src/lib/logger";
import {
  validateRunnerGroupOrg,
  isOfficialRunnerGroup,
} from "../../../../src/lib/scope/org-service";

const log = logger("api:runners:poll");

const router = tsr.router(runnersPollContract, {
  poll: async ({ body, headers }) => {
    initServices();

    const auth = await getRunnerAuth(headers.authorization);
    if (!auth) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const { group } = body;

    // Build query conditions based on auth type
    let whereConditions: SQL<unknown>[];

    if (auth.type === "official-runner") {
      // Official runners can only poll official runner groups (vm0/*)
      if (!isOfficialRunnerGroup(group)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Official runners can only poll vm0/* groups",
        );
      }
      // Query all unclaimed jobs for the group (no userId filter)
      whereConditions = [
        eq(runnerJobQueue.runnerGroup, group),
        isNull(runnerJobQueue.claimedAt),
      ];
      log.debug(`Official runner polling group: ${group}`);
    } else {
      // User runners: validate org and filter by userId
      try {
        await validateRunnerGroupOrg(auth.userId, group, auth.orgId);
      } catch {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      whereConditions = [
        eq(runnerJobQueue.runnerGroup, group),
        isNull(runnerJobQueue.claimedAt),
        eq(agentRuns.userId, auth.userId),
      ];
    }

    // Query runner_job_queue for unclaimed jobs
    const [pendingJob] = await globalThis.services.db
      .select({
        runId: runnerJobQueue.runId,
        prompt: agentRuns.prompt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        vars: agentRuns.vars,
        resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .where(and(...whereConditions))
      .limit(1);

    if (pendingJob) {
      log.debug(`Found pending job: ${pendingJob.runId}`);
      return {
        status: 200 as const,
        body: {
          job: {
            runId: pendingJob.runId,
            prompt: pendingJob.prompt,
            agentComposeVersionId: pendingJob.agentComposeVersionId,
            vars: (pendingJob.vars as Record<string, string>) ?? null,
            checkpointId: pendingJob.resumedFromCheckpointId ?? null,
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
