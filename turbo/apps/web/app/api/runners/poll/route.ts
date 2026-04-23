import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runnersPollContract } from "@vm0/core/contracts/runners";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { runnerJobQueue } from "../../../../src/db/schema/runner-job-queue";
import { eq, and, isNull, inArray, sql, type SQL } from "drizzle-orm";
import { getRunnerAuth } from "../../../../src/lib/auth/runner-auth";
import { logger } from "../../../../src/lib/shared/logger";
import { isOfficialRunnerGroup } from "../../../../src/lib/infra/run/runner-group";

const log = logger("api:runners:poll");

const router = tsr.router(runnersPollContract, {
  poll: async ({ body, headers }) => {
    initServices();

    const auth = await getRunnerAuth(headers.authorization);
    if (!auth) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const { group, profiles, heldSessions } = body;

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
      // User runners: enforce vm0/* groups and filter by userId
      if (!isOfficialRunnerGroup(group)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Only vm0/* runner groups are supported",
        );
      }
      whereConditions = [
        eq(runnerJobQueue.runnerGroup, group),
        isNull(runnerJobQueue.claimedAt),
        eq(agentRuns.userId, auth.userId),
      ];
    }

    // Filter by profile if runner sends an affordability list
    if (profiles && profiles.length > 0) {
      whereConditions.push(inArray(runnerJobQueue.profile, profiles));
    }

    // Build ORDER BY: session affinity matches first, then FIFO
    const orderClauses =
      heldSessions && heldSessions.length > 0
        ? [
            sql`CASE WHEN ${runnerJobQueue.sessionId} IN (${sql.join(
              heldSessions.map((s) => {
                return sql`${s}`;
              }),
              sql`, `,
            )}) THEN 0 ELSE 1 END`,
            runnerJobQueue.createdAt,
          ]
        : [runnerJobQueue.createdAt];

    // Query runner_job_queue for unclaimed jobs
    const [pendingJob] = await globalThis.services.db
      .select({
        runId: runnerJobQueue.runId,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        vars: agentRuns.vars,
        resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
        profile: runnerJobQueue.profile,
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .where(and(...whereConditions))
      .orderBy(...orderClauses)
      .limit(1);

    if (pendingJob) {
      log.debug(`Found pending job: ${pendingJob.runId}`);
      return {
        status: 200 as const,
        body: {
          job: {
            runId: pendingJob.runId,
            prompt: pendingJob.prompt,
            appendSystemPrompt: pendingJob.appendSystemPrompt,
            agentComposeVersionId: pendingJob.agentComposeVersionId,
            vars: (pendingJob.vars as Record<string, string>) ?? null,
            checkpointId: pendingJob.resumedFromCheckpointId ?? null,
            experimentalProfile: pendingJob.profile,
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
  routeName: "runners.poll",
  errorHandler,
});

export { handler as POST };
