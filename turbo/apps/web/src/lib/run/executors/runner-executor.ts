import { DEFAULT_PROFILE, type StoredExecutionContext } from "@vm0/core";
import { runnerJobQueue } from "../../../db/schema/runner-job-queue";
import { encryptSecretsMap } from "../../crypto/secrets-encryption";
import { validateRunnerGroupOrg } from "../../org/org-service";
import { publishJobNotification } from "../../realtime/client";
import { logger } from "../../logger";
import { recordSandboxOperation } from "../../metrics";
import type { PreparedContext, ExecutorResult } from "./types";

const log = logger("executor:runner");

/**
 * Queue an agent run for execution by a self-hosted runner
 *
 * Stores the job in the runner_job_queue for later polling by runners.
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
  const profile = context.experimentalProfile ?? DEFAULT_PROFILE;

  if (!runnerGroup) {
    throw new Error("RunnerExecutor requires a runner group");
  }

  log.debug(`Queueing run ${context.runId} for runner group: ${runnerGroup}`);

  // Validate runner group org matches user's org
  await validateRunnerGroupOrg(context.userId, runnerGroup);

  // Encrypt secrets map (key-value pairs) before storing
  const encryptedSecrets = encryptSecretsMap(
    context.secrets ?? null,
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
    secretConnectorMap: context.secretConnectorMap,
    cliAgentType: context.cliAgentType,
    experimentalFirewalls: context.experimentalFirewalls ?? undefined,
    experimentalCapabilities: context.experimentalCapabilities ?? undefined,
    experimentalProfile: profile,
    debugNoMockClaude: context.debugNoMockClaude || undefined,
    apiStartTime: context.apiStartTime ?? undefined,
    userTimezone: context.userTimezone ?? undefined,
    agentName: context.agentName ?? undefined,
    agentOrgSlug: context.agentOrgSlug ?? undefined,
    memoryName: context.memoryName ?? undefined,
  };

  // Insert into runner job queue
  // TTL: 2 hours for job expiration
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await globalThis.services.db.insert(runnerJobQueue).values({
    runId: context.runId,
    runnerGroup,
    profile,
    executionContext: storedContext,
    expiresAt,
  });

  log.debug(`Run ${context.runId} queued for runner group: ${runnerGroup}`);

  // Publish job notification to Ably for instant runner pickup
  // Sends runId + profile so runner can pre-check resource budget before claiming
  // This is fire-and-forget - failure doesn't affect the queue insertion
  const published = await publishJobNotification(
    runnerGroup,
    context.runId,
    profile,
  );
  if (published) {
    log.debug(`Job notification published for run ${context.runId}`);
  }

  return {
    runId: context.runId,
    status: "pending",
    createdAt: new Date().toISOString(),
    sandboxType: "runner",
  };
}
