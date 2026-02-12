import type { StoredExecutionContext } from "@vm0/core";
import { runnerJobQueue } from "../../../db/schema/runner-job-queue";
import { encryptSecrets } from "../../crypto/secrets-encryption";
import { validateRunnerGroupScope } from "../../scope/scope-service";
import { publishJobNotification } from "../../realtime/client";
import { logger } from "../../logger";
import { recordSandboxOperation } from "../../metrics";
import type { PreparedContext, ExecutorResult } from "./types";

const log = logger("executor:runner");

/**
 * Queue an agent run for execution by a self-hosted runner
 *
 * Unlike E2B executor which executes immediately, this function
 * stores the job in the runner_job_queue for later polling.
 *
 * @param context PreparedContext with all necessary information
 * @returns ExecutorResult with status "pending"
 */
export async function executeRunnerJob(
  context: PreparedContext,
): Promise<ExecutorResult> {
  // Record api_to_dispatch metric
  if (context.apiStartTime) {
    recordSandboxOperation({
      sandboxType: "runner",
      actionType: "api_to_executor",
      durationMs: Date.now() - context.apiStartTime,
      success: true,
    });
  }

  const runnerGroup = context.runnerGroup;

  if (!runnerGroup) {
    throw new Error("RunnerExecutor requires a runner group");
  }

  log.debug(`Queueing run ${context.runId} for runner group: ${runnerGroup}`);

  // Validate runner group scope matches user's scope
  await validateRunnerGroupScope(context.userId, runnerGroup);

  // Encrypt secrets before storing
  const secretValues = context.secrets ? Object.values(context.secrets) : null;
  const encryptedSecrets = encryptSecrets(
    secretValues,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );

  // Build stored execution context with encrypted secrets
  // Storage manifest is already prepared in PreparedContext
  const storedContext: StoredExecutionContext = {
    workingDir: context.workingDir,
    storageManifest: context.storageManifest,
    environment: context.environment,
    resumeSession: context.resumeSession,
    encryptedSecrets,
    cliAgentType: context.cliAgentType,
    experimentalFirewall: context.experimentalFirewall ?? undefined,
    debugNoMockClaude: context.debugNoMockClaude || undefined,
    apiStartTime: context.apiStartTime ?? undefined,
    userTimezone: context.userTimezone ?? undefined,
  };

  // Insert into runner job queue
  // TTL: 2 hours for job expiration
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await globalThis.services.db.insert(runnerJobQueue).values({
    runId: context.runId,
    runnerGroup,
    executionContext: storedContext,
    expiresAt,
  });

  log.debug(`Run ${context.runId} queued for runner group: ${runnerGroup}`);

  // Publish job notification to Ably for instant runner pickup
  // Only sends runId - runner will claim job to get full context
  // This is fire-and-forget - failure doesn't affect the queue insertion
  const published = await publishJobNotification(runnerGroup, context.runId);
  if (published) {
    log.debug(`Job notification published for run ${context.runId}`);
  }

  // Return pending status - run will be picked up by runner via realtime notification or polling
  return {
    runId: context.runId,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}
