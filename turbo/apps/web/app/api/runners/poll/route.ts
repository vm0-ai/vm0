import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runnersPollContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq, and, isNull } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";

// Ensure this route is always dynamically rendered (never cached)
// This is critical for authentication headers to be properly read
export const dynamic = "force-dynamic";

const log = logger("api:runners:poll");

const router = tsr.router(runnersPollContract, {
  poll: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { group } = body;

    // Simple single query - runner client handles polling loop
    const [pendingRun] = await globalThis.services.db
      .select({
        id: agentRuns.id,
        prompt: agentRuns.prompt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        vars: agentRuns.vars,
        secretNames: agentRuns.secretNames,
        resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.runnerGroup, group),
          eq(agentRuns.status, "pending"),
          isNull(agentRuns.runnerId),
        ),
      )
      .limit(1);

    if (pendingRun) {
      log.debug(`Found pending job: ${pendingRun.id}`);
      return {
        status: 200 as const,
        body: {
          job: {
            runId: pendingRun.id,
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
