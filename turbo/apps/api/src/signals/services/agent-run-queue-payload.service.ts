import {
  compatibleStoredExecutionContextSchema,
  type CompatibleStoredExecutionContext,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { z } from "zod";

import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import {
  piEdgeModelConfigSchema,
  piEdgeUsageConfigSchema,
  type PiEdgeModelConfig,
  type PiEdgeUsageConfig,
} from "./pi-edge-config";

const QUEUED_RUNNER_JOB_PAYLOAD_KEY = "__api_runner_job_payload__";

const queuedRunnerJobPayloadWireSchema = z.object({
  version: z.literal(1),
  runnerGroup: z.string(),
  profile: z.string(),
  // Wire/backing payload compatibility field. Semantically this is the
  // Claude/Codex CLI agent session id retained for telemetry and diagnostics.
  sessionId: z.string().nullable(),
  reuseKey: z.string().nullable().optional(),
  executionContext: compatibleStoredExecutionContextSchema,
  // Optional and encrypted with the rest of the queue payload. Previous API
  // readers ignore this additive field and safely dispatch the normal profile.
  piEdge: z
    .object({
      model: piEdgeModelConfigSchema,
      prompt: z.string().min(1),
      usage: piEdgeUsageConfigSchema.optional(),
    })
    .readonly()
    .optional(),
});

interface QueuedPiEdgeLaunch {
  readonly model: PiEdgeModelConfig;
  readonly prompt: string;
  readonly usage?: PiEdgeUsageConfig;
}

interface QueuedRunnerJobPayload {
  readonly version: 1;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly executionContext: StoredExecutionContext;
  readonly piEdge: QueuedPiEdgeLaunch | undefined;
}

interface CompatibleQueuedRunnerJobPayload extends Omit<
  QueuedRunnerJobPayload,
  "executionContext"
> {
  readonly executionContext: CompatibleStoredExecutionContext;
}

export function historyGenerationRunIdForStoredExecutionContext(
  executionContext: Pick<StoredExecutionContext, "resumeSession">,
): string | undefined {
  const resumeSession = executionContext.resumeSession;
  return resumeSession && "historyRef" in resumeSession
    ? resumeSession.historyGenerationRunId
    : undefined;
}

export async function encryptQueuedRunnerJobPayload(
  payload: QueuedRunnerJobPayload,
  ctx: FeatureSwitchContext = {},
): Promise<string> {
  const encrypted = await encryptPersistentSecretsMap(
    {
      [QUEUED_RUNNER_JOB_PAYLOAD_KEY]: JSON.stringify({
        version: payload.version,
        runnerGroup: payload.runnerGroup,
        profile: payload.profile,
        sessionId: payload.cliAgentSessionId,
        reuseKey: payload.reuseKey,
        executionContext: payload.executionContext,
        ...(payload.piEdge === undefined ? {} : { piEdge: payload.piEdge }),
      }),
    },
    ctx,
  );
  if (!encrypted) {
    throw new Error("Failed to encrypt queued runner job payload");
  }
  return encrypted;
}

export async function decryptQueuedRunnerJobPayload(
  encryptedParams: string | null,
  ctx: FeatureSwitchContext = {},
): Promise<CompatibleQueuedRunnerJobPayload> {
  if (!encryptedParams) {
    throw new Error("Queued runner job is missing its encrypted payload");
  }

  const decrypted = await decryptPersistentSecretsMap(encryptedParams, ctx);
  const rawPayload = decrypted?.[QUEUED_RUNNER_JOB_PAYLOAD_KEY];
  if (!rawPayload) {
    throw new Error("Queued runner job payload could not be decrypted");
  }

  const parsedJson: unknown = JSON.parse(rawPayload);
  const wirePayload = queuedRunnerJobPayloadWireSchema.parse(parsedJson);
  return {
    version: wirePayload.version,
    runnerGroup: wirePayload.runnerGroup,
    profile: wirePayload.profile,
    cliAgentSessionId: wirePayload.sessionId,
    reuseKey: wirePayload.reuseKey ?? null,
    historyGenerationRunId: historyGenerationRunIdForStoredExecutionContext(
      wirePayload.executionContext,
    ),
    executionContext: wirePayload.executionContext,
    piEdge: wirePayload.piEdge,
  };
}

export function queuedRunnerJobPayload(args: {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly executionContext: StoredExecutionContext;
  readonly piEdge?: QueuedPiEdgeLaunch;
}): QueuedRunnerJobPayload {
  return {
    version: 1,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    cliAgentSessionId: args.cliAgentSessionId,
    reuseKey: args.reuseKey,
    historyGenerationRunId: historyGenerationRunIdForStoredExecutionContext(
      args.executionContext,
    ),
    executionContext: args.executionContext,
    piEdge: args.piEdge,
  };
}
