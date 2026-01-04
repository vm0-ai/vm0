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
import {
  runners,
  runnerJobQueue,
} from "../../../../../../src/db/schema/runner";
import { eq, and, isNull } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { logger } from "../../../../../../src/lib/logger";
import { decryptSecrets } from "../../../../../../src/lib/crypto/secrets-encryption";

const log = logger("api:runners:jobs:claim");

/**
 * Get the API URL for the runner to use when calling webhooks.
 * Uses VM0_API_URL if set, otherwise falls back to VERCEL_URL for preview deployments.
 */
function getApiUrl(): string {
  // Explicit configuration takes precedence
  if (globalThis.services.env.VM0_API_URL) {
    return globalThis.services.env.VM0_API_URL;
  }

  // Use Vercel URL for preview deployments
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return `https://${vercelUrl}`;
  }

  // Production fallback
  return "https://www.vm0.ai";
}

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

    // Fetch the job from runner_job_queue
    const [job] = await globalThis.services.db
      .select()
      .from(runnerJobQueue)
      .where(
        and(eq(runnerJobQueue.runId, runId), isNull(runnerJobQueue.claimedAt)),
      )
      .limit(1);

    if (!job) {
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

    // Claim the job - atomically update in runner_job_queue
    const now = new Date();
    const [claimedJob] = await globalThis.services.db
      .update(runnerJobQueue)
      .set({
        runnerId,
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

    log.debug(`Job ${runId} claimed by runner ${runnerId}`);

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

    // Decrypt secrets before returning to runner
    const secretValues = decryptSecrets(
      storedContext.encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );

    // Return execution context (context already prepared at job creation)
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
        apiUrl: getApiUrl(),
        // From stored context (prepared at job creation):
        workingDir: storedContext.workingDir,
        storageManifest: storedContext.storageManifest,
        environment: storedContext.environment,
        resumeSession: storedContext.resumeSession,
        secretValues, // Decrypted secrets
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
