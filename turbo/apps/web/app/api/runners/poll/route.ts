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
import { headers } from "next/headers";

const log = logger("api:runners:poll");

// Force dynamic rendering to prevent any caching
export const dynamic = "force-dynamic";

// Long-polling timeout in milliseconds
const POLL_TIMEOUT_MS = 30000;
// Polling interval when checking for jobs
const POLL_INTERVAL_MS = 1000;

/**
 * Wait for a specified duration
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const router = tsr.router(runnersPollContract, {
  poll: async ({ query }) => {
    initServices();

    // Debug logging for auth troubleshooting
    const headersList = await headers();
    const authHeader = headersList.get("Authorization");
    log.debug(
      `Poll request - Auth header present: ${!!authHeader}, starts with Bearer: ${authHeader?.startsWith("Bearer ")}, has vm0_live: ${authHeader?.includes("vm0_live_")}`,
    );

    const userId = await getUserId();
    if (!userId) {
      log.warn(
        `Poll auth failed - Auth header: ${authHeader ? "present" : "missing"}, Token prefix: ${authHeader?.substring(0, 20)}...`,
      );
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { group } = query;
    log.debug(`Runner polling for group: ${group}`);

    const startTime = Date.now();

    // Long-polling loop
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      // Check for pending jobs in the runner group
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

      // Wait before checking again
      await delay(POLL_INTERVAL_MS);
    }

    // Timeout reached, return empty result
    log.debug(`Poll timeout reached for group: ${group}`);
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

const handler = createHandler(runnersPollContract, router, {
  errorHandler,
});

export { handler as GET };
