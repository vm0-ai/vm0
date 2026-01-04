import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import {
  runnersJobClaimContract,
  createErrorResponse,
  type StoredExecutionContext,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { runners } from "../../../../../../src/db/schema/runner";
import { eq, and, isNull } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("api:runners:jobs:claim");

const router = tsr.router(runnersJobClaimContract, {
  claim: async ({ params, body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { id: runId } = params;
    const { runnerId } = body;

    log.debug(`Runner ${runnerId} claiming job: ${runId}`);

    // Verify the runner exists and belongs to the user
    const [runner] = await globalThis.services.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)))
      .limit(1);

    if (!runner) {
      return createErrorResponse("NOT_FOUND", "Runner not found");
    }

    // Fetch the pending run
    const [pendingRun] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.status, "pending"),
          isNull(agentRuns.runnerId),
        ),
      )
      .limit(1);

    if (!pendingRun) {
      // Check if job exists but is already claimed
      const [existingRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);

      if (existingRun) {
        if (existingRun.runnerId) {
          return createErrorResponse("CONFLICT", "Job already claimed");
        }
        return createErrorResponse(
          "CONFLICT",
          `Job is not available (status: ${existingRun.status})`,
        );
      }

      return createErrorResponse("NOT_FOUND", "Job not found");
    }

    // Claim the job - atomically update status and set runner
    const now = new Date();
    const [claimedRun] = await globalThis.services.db
      .update(agentRuns)
      .set({
        runnerId,
        claimedAt: now,
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.status, "pending"),
          isNull(agentRuns.runnerId),
        ),
      )
      .returning();

    if (!claimedRun) {
      // Race condition - job was claimed by another runner
      return createErrorResponse(
        "CONFLICT",
        "Job was claimed by another runner",
      );
    }

    log.debug(`Job ${runId} claimed by runner ${runnerId}`);

    // Generate sandbox token for the runner to use when calling webhooks
    const sandboxToken = await generateSandboxToken(
      pendingRun.userId,
      pendingRun.id,
    );

    // Load stored execution context (prepared at job creation via late routing)
    const storedContext =
      claimedRun.executionContext as StoredExecutionContext | null;

    if (!storedContext) {
      // This can happen for jobs created before the late-routing update
      log.warn(
        `Job ${runId} has no stored execution context (created before late-routing update)`,
      );
      return createErrorResponse(
        "BAD_REQUEST",
        "Job missing execution context (created before late-routing update)",
      );
    }

    log.debug(
      `Loaded stored context: workingDir=${storedContext.workingDir}, cliAgentType=${storedContext.cliAgentType}`,
    );

    // Return execution context (context already prepared at job creation)
    return {
      status: 200 as const,
      body: {
        runId: claimedRun.id,
        prompt: claimedRun.prompt,
        agentComposeVersionId: claimedRun.agentComposeVersionId,
        vars: (claimedRun.vars as Record<string, string>) ?? null,
        secretNames: claimedRun.secretNames ?? null,
        checkpointId: claimedRun.resumedFromCheckpointId ?? null,
        sandboxToken,
        apiUrl: globalThis.services.env.VM0_API_URL || "https://www.vm0.ai",
        // From stored context (prepared at job creation):
        workingDir: storedContext.workingDir,
        storageManifest: storedContext.storageManifest,
        environment: storedContext.environment,
        resumeSession: storedContext.resumeSession,
        secretValues: storedContext.secretValues,
        cliAgentType: storedContext.cliAgentType,
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

const handler = createHandler(runnersJobClaimContract, router, {
  errorHandler,
});

export { handler as POST };
