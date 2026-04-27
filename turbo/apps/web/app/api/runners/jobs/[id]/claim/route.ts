import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import {
  runnersJobClaimContract,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { eq, and, isNull } from "drizzle-orm";
import { getRunnerAuth } from "../../../../../../src/lib/auth/runner-auth";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { logger } from "../../../../../../src/lib/shared/logger";
import { decryptSecretsMap } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import { isOfficialRunnerGroup } from "../../../../../../src/lib/infra/run/runner-group";
import { recordSandboxOperation } from "../../../../../../src/lib/infra/metrics";

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
      // User runners: verify job ownership and org
      if (jobWithRun.runUserId !== auth.userId) {
        return createErrorResponse("FORBIDDEN", "Job does not belong to user");
      }

      if (!isOfficialRunnerGroup(jobWithRun.job.runnerGroup)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Only vm0/* runner groups are supported",
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

    // Update agent_runs status to running (only if still pending)
    const [run] = await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
      })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "pending")))
      .returning();

    if (!run) {
      return createErrorResponse("NOT_FOUND", "Run not found");
    }

    log.debug(`Job ${runId} claimed`);

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

    // Generate sandbox token for the run
    const sandboxToken = await generateSandboxToken(
      run.userId,
      run.id,
      run.orgId,
    );

    // Record api_to_claim metric
    if (storedContext.apiStartTime) {
      recordSandboxOperation({
        sandboxType: "runner",
        actionType: "api_to_claim",
        durationMs: now.getTime() - storedContext.apiStartTime,
        success: true,
        runId,
      });
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

    // Decrypt secrets map and extract values for runner log masking.
    // Only include secret values that actually appear in the environment —
    // secrets replaced with firewall placeholders should not be exposed via VM0_SECRET_VALUES.
    const secretsMap = decryptSecretsMap(
      storedContext.encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );
    const envValues = storedContext.environment
      ? new Set(Object.values(storedContext.environment))
      : new Set<string>();
    const secretValues = secretsMap
      ? Object.values(secretsMap).filter((v) => {
          return envValues.has(v);
        })
      : null;

    // Return execution context (context already prepared at job creation).
    // Spread storedContext so any future field added to storedExecutionContextSchema
    // auto-forwards — avoids the silent-drop class of bug (see #9868).
    // Note: apiUrl is not returned - runner uses its configured server.url
    return {
      status: 200 as const,
      body: {
        ...storedContext,
        runId: run.id,
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt,
        agentComposeVersionId: run.agentComposeVersionId,
        vars: (run.vars as Record<string, string>) ?? null,
        checkpointId: run.resumedFromCheckpointId ?? null,
        sandboxToken,
        secretValues, // Decrypted secret values for log masking
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
  routeName: "runners.jobs.claim",
  errorHandler,
});

export { handler as POST };
