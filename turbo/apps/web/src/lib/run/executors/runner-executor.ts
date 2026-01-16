import type { StoredExecutionContext } from "@vm0/core";
import { runnerJobQueue } from "../../../db/schema/runner-job-queue";
import { encryptSecrets } from "../../crypto/secrets-encryption";
import { validateRunnerGroupScope } from "../../scope/scope-service";
import { logger } from "../../logger";
import type { PreparedContext, ExecutorResult, Executor } from "./types";

const log = logger("executor:runner");

/**
 * Runner Executor
 *
 * Queues agent runs for execution by self-hosted runners.
 * Unlike E2B executor which executes immediately, this executor
 * stores the job in the runner_job_queue for later polling.
 */
class RunnerExecutor implements Executor {
  /**
   * Queue an agent run for execution by a self-hosted runner
   *
   * @param context PreparedContext with all necessary information
   * @returns ExecutorResult with status "pending"
   */
  async execute(context: PreparedContext): Promise<ExecutorResult> {
    const runnerGroup = context.runnerGroup;

    if (!runnerGroup) {
      throw new Error("RunnerExecutor requires a runner group");
    }

    log.debug(`Queueing run ${context.runId} for runner group: ${runnerGroup}`);

    // Validate runner group scope matches user's scope
    await validateRunnerGroupScope(context.userId, runnerGroup);

    // Encrypt secrets before storing
    const secretValues = context.secrets
      ? Object.values(context.secrets)
      : null;
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
    };

    // Insert into runner job queue
    // TTL: 24 hours for job expiration
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await globalThis.services.db.insert(runnerJobQueue).values({
      runId: context.runId,
      runnerGroup,
      executionContext: storedContext,
      expiresAt,
    });

    log.debug(`Run ${context.runId} queued for runner group: ${runnerGroup}`);

    // Return pending status - run will be picked up by polling runner
    return {
      runId: context.runId,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
  }
}

// Export singleton instance
export const runnerExecutor = new RunnerExecutor();
