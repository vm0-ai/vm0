import {
  DEFAULT_PROFILE,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import type { Firewalls } from "@vm0/connectors/firewall-types";
import { eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import {
  ingestRunContext,
  type RunContextSnapshot,
} from "../../../shared/axiom/client";
import { encryptSecretsMap } from "../../../shared/crypto/secrets-encryption";
import { isOfficialRunnerGroup } from "../runner-group";
import { forbidden } from "@vm0/api-services/errors";
import { publishJobNotification } from "../../realtime/client";
import { findBestRunner } from "../scheduling";
import { logger } from "../../../shared/logger";
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
  // Record api_to_dispatch metric. was_queued distinguishes runs that came
  // through the org queue (apiStartTime was reset at dequeue) from direct
  // dispatch, so latency queries can slice by dispatch path.
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "api_to_executor",
    durationMs: Date.now() - context.apiStartTime,
    success: true,
    runId: context.runId,
    dimensions: {
      was_queued: context.wasQueued,
    },
  });

  const runnerGroup = context.runnerGroup;
  const profile = context.experimentalProfile ?? DEFAULT_PROFILE;

  if (!runnerGroup) {
    throw new Error("RunnerExecutor requires a runner group");
  }

  log.debug(`Queueing run ${context.runId} for runner group: ${runnerGroup}`);

  // Enforce vm0/* runner groups only
  if (!isOfficialRunnerGroup(runnerGroup)) {
    throw forbidden("Only vm0/* runner groups are supported");
  }

  const storedContext = buildStoredContext(context, profile);

  // Ingest sanitized context snapshot to Axiom for debugging
  ingestRunContext(buildRunContextSnapshot(context));

  // Insert into runner job queue
  // TTL: 2 hours for job expiration
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await globalThis.services.db.insert(runnerJobQueue).values({
    runId: context.runId,
    runnerGroup,
    profile,
    sessionId: context.resumeSession?.sessionId ?? null,
    executionContext: storedContext,
    expiresAt,
  });

  // Store runner group on agent_runs for cancel routing (runner_job_queue
  // is deleted after claim, so we need a durable reference).
  await globalThis.services.db
    .update(agentRuns)
    .set({ runnerGroup })
    .where(eq(agentRuns.id, context.runId));

  log.debug(`Run ${context.runId} queued for runner group: ${runnerGroup}`);

  // Notify runners via Ably with optional targeted dispatch
  await notifyRunners(
    runnerGroup,
    context.runId,
    profile,
    context.resumeSession?.sessionId ?? null,
  );

  return {
    runId: context.runId,
    status: "pending",
    createdAt: new Date().toISOString(),
    sandboxType: "runner",
  };
}

/**
 * Find best runner and publish Ably job notification.
 * Fire-and-forget — failures are logged but don't affect the queued job.
 */
async function notifyRunners(
  runnerGroup: string,
  runId: string,
  profile: string,
  sessionId: string | null,
): Promise<void> {
  let targetRunnerId: string | null = null;
  try {
    const target = await findBestRunner(runnerGroup, profile, sessionId);
    targetRunnerId = target?.runnerId ?? null;
  } catch (e) {
    log.warn(`findBestRunner failed for run ${runId}, using broadcast`, e);
  }

  const published = await publishJobNotification(
    runnerGroup,
    runId,
    profile,
    targetRunnerId,
  );
  if (published) {
    log.debug(`Job notification published for run ${runId}`);
  }
}

/**
 * Build stored execution context with encrypted secrets for the runner job queue.
 */
function buildStoredContext(
  context: PreparedContext,
  profile: string,
): StoredExecutionContext {
  const encryptedSecrets = encryptSecretsMap(
    context.secrets ?? null,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );

  return {
    workingDir: context.workingDir,
    storageManifest: context.storageManifest,
    environment: context.environment,
    resumeSession: context.resumeSession,
    encryptedSecrets,
    secretConnectorMap: context.secretConnectorMap,
    cliAgentType: context.cliAgentType,
    firewalls: context.firewalls ?? undefined,
    networkPolicies: context.networkPolicies ?? undefined,
    disallowedTools: context.disallowedTools ?? undefined,
    tools: context.tools ?? undefined,
    settings: context.settings ?? undefined,
    experimentalProfile: profile,
    debugNoMockClaude: context.debugNoMockClaude || undefined,
    captureNetworkBodies: context.captureNetworkBodies || undefined,
    apiStartTime: context.apiStartTime,
    userTimezone: context.userTimezone ?? undefined,
    featureFlags: context.featureFlags ?? undefined,
    billableFirewalls: context.billableFirewalls,
  };
}

/**
 * Build a sanitized context snapshot for Axiom ingestion.
 * - Secret values in environment are masked as "***"
 * - Firewall auth headers are stripped entirely
 * - Presigned URLs are omitted from storage entries
 */
function buildRunContextSnapshot(context: PreparedContext): RunContextSnapshot {
  const secretValues = new Set(
    context.secrets ? Object.values(context.secrets) : [],
  );

  // Mask environment values that match any secret value
  const environment: Record<string, string> = {};
  if (context.environment) {
    for (const [key, value] of Object.entries(context.environment)) {
      environment[key] = secretValues.has(value) ? "***" : value;
    }
  }

  // Strip auth headers from firewalls
  const firewalls = sanitizeFirewalls(context.firewalls);

  // Extract volume/artifact metadata without presigned URLs
  const manifest = context.storageManifest;

  return {
    runId: context.runId,
    userId: context.userId,
    prompt: context.prompt,
    appendSystemPrompt: context.appendSystemPrompt,
    sessionId: context.resumeSession?.sessionId ?? null,
    secretNames: context.secrets ? Object.keys(context.secrets) : [],
    environment,
    firewalls,
    networkPolicies: context.networkPolicies,
    volumes: (manifest?.storages ?? []).map((s) => {
      return {
        name: s.name,
        mountPath: s.mountPath,
        vasStorageName: s.vasStorageName,
        vasVersionId: s.vasVersionId,
      };
    }),
    artifact:
      manifest && manifest.artifacts.length > 0
        ? {
            mountPath: manifest.artifacts[0]!.mountPath,
            vasStorageName: manifest.artifacts[0]!.vasStorageName,
            vasVersionId: manifest.artifacts[0]!.vasVersionId,
          }
        : null,
    featureFlags: context.featureFlags,
  };
}

function sanitizeFirewalls(
  firewalls: Firewalls | null,
): RunContextSnapshot["firewalls"] {
  if (!firewalls) return [];
  return firewalls.map((fw) => {
    return {
      name: fw.name,
      apis: fw.apis.map((api) => {
        return {
          base: api.base,
          permissions: api.permissions?.map((p) => {
            return {
              name: p.name,
              description: p.description,
              rules: p.rules,
            };
          }),
        };
      }),
    };
  });
}
