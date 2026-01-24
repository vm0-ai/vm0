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
import { runnerJobQueue } from "../../../../../../src/db/schema/runner-job-queue";
import { eq, and, isNull } from "drizzle-orm";
import { getRunnerAuth } from "../../../../../../src/lib/auth/runner-auth";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { logger } from "../../../../../../src/lib/logger";
import { decryptSecrets } from "../../../../../../src/lib/crypto/secrets-encryption";
import {
  validateRunnerGroupScope,
  isOfficialRunnerGroup,
} from "../../../../../../src/lib/scope/scope-service";

const log = logger("api:runners:jobs:claim");

const router = tsr.router(runnersJobClaimContract, {
  claim: async ({ params, headers }) => {
    initServices();

    const auth = await getRunnerAuth(headers.authorization);
    if (!auth) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { id: runId } = params;

    log.debug(`Claiming job: ${runId}`);

    // Fetch the job from runner_job_queue and verify ownership via agent_run
    const [jobWithRun] = await globalThis.services.db
      .select({
        job: runnerJobQueue,
        runUserId: agentRuns.userId,
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .where(
        and(eq(runnerJobQueue.runId, runId), isNull(runnerJobQueue.claimedAt)),
      )
      .limit(1);

    if (!jobWithRun) {
      // Check if job exists but is already claimed
      const [existingJob] = await globalThis.services.db
        .select()
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, runId))
        .limit(1);

      if (existingJob) {
        return createErrorResponse("CONFLICT", "Job already claimed");
      }

      return createErrorResponse("NOT_FOUND", "Job not found in queue");
    }

    // Authorization based on auth type
    if (auth.type === "official-runner") {
      // Official runners can only claim jobs from official runner groups (vm0/*)
      if (!isOfficialRunnerGroup(jobWithRun.job.runnerGroup)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Official runners can only claim jobs from vm0/* groups",
        );
      }
      log.debug(
        `Official runner claiming job from ${jobWithRun.job.runnerGroup}`,
      );
    } else {
      // User runners: verify job ownership and scope
      if (jobWithRun.runUserId !== auth.userId) {
        return createErrorResponse("FORBIDDEN", "Job does not belong to user");
      }

      try {
        await validateRunnerGroupScope(auth.userId, jobWithRun.job.runnerGroup);
      } catch (error) {
        return createErrorResponse(
          "FORBIDDEN",
          error instanceof Error ? error.message : "Scope validation failed",
        );
      }
    }

    // Claim the job - atomically update in runner_job_queue
    const now = new Date();
    const [claimedJob] = await globalThis.services.db
      .update(runnerJobQueue)
      .set({
        claimedAt: now,
      })
      .where(
        and(eq(runnerJobQueue.runId, runId), isNull(runnerJobQueue.claimedAt)),
      )
      .returning();

    if (!claimedJob) {
      // Race condition - job was claimed by another runner
      return createErrorResponse(
        "CONFLICT",
        "Job was claimed by another runner",
      );
    }

    // Update agent_runs status to running
    const [run] = await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
      })
      .where(eq(agentRuns.id, runId))
      .returning();

    if (!run) {
      return createErrorResponse("NOT_FOUND", "Run not found");
    }

    log.debug(`Job ${runId} claimed`);

    // Generate sandbox token for the runner to use when calling webhooks
    const sandboxToken = await generateSandboxToken(run.userId, run.id);

    // Load stored execution context from the job queue
    const storedContext =
      claimedJob.executionContext as StoredExecutionContext | null;

    if (!storedContext) {
      log.warn(`Job ${runId} has no stored execution context`);
      return createErrorResponse(
        "BAD_REQUEST",
        "Job missing execution context",
      );
    }

    log.debug(
      `Loaded stored context: workingDir=${storedContext.workingDir}, cliAgentType=${storedContext.cliAgentType}`,
    );

    // Delete job queue entry - context has been retrieved, no longer needed
    // This also removes the encrypted secrets from the database
    await globalThis.services.db
      .delete(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, runId));

    log.debug(`Deleted job queue entry for ${runId}`);

    // Decrypt secrets before returning to runner
    const secretValues = decryptSecrets(
      storedContext.encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );

    // Return execution context (context already prepared at job creation)
    // Note: apiUrl is not returned - runner uses its configured server.url
    return {
      status: 200 as const,
      body: {
        runId: run.id,
        prompt: run.prompt,
        agentComposeVersionId: run.agentComposeVersionId,
        vars: (run.vars as Record<string, string>) ?? null,
        secretNames: run.secretNames ?? null,
        checkpointId: run.resumedFromCheckpointId ?? null,
        sandboxToken,
        // From stored context (prepared at job creation):
        workingDir: storedContext.workingDir,
        storageManifest: storedContext.storageManifest,
        environment: storedContext.environment,
        resumeSession: storedContext.resumeSession,
        secretValues, // Decrypted secrets
        cliAgentType: storedContext.cliAgentType,
        experimentalFirewall: storedContext.experimentalFirewall,
        debugNoMockClaude: storedContext.debugNoMockClaude,
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
