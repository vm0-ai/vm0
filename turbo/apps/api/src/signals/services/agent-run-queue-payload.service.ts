import {
  storedExecutionContextSchema,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { z } from "zod";

import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";

const QUEUED_RUNNER_JOB_PAYLOAD_KEY = "__api_runner_job_payload__";

const queuedRunnerJobPayloadWireSchema = z.object({
  version: z.literal(1),
  runnerGroup: z.string(),
  profile: z.string(),
  // Wire/backing payload compatibility field. Semantically this is the
  // Claude/Codex CLI agent session id used for runner sandbox reuse affinity.
  sessionId: z.string().nullable(),
  executionContext: storedExecutionContextSchema,
});

interface QueuedRunnerJobPayload {
  readonly version: 1;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly executionContext: StoredExecutionContext;
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
        executionContext: payload.executionContext,
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
): Promise<QueuedRunnerJobPayload | null> {
  if (!encryptedParams) {
    return null;
  }

  const decrypted = await decryptPersistentSecretsMap(encryptedParams, ctx);
  const rawPayload = decrypted?.[QUEUED_RUNNER_JOB_PAYLOAD_KEY];
  if (!rawPayload) {
    return null;
  }

  const parsedJson: unknown = JSON.parse(rawPayload);
  const wirePayload = queuedRunnerJobPayloadWireSchema.parse(parsedJson);
  return {
    version: wirePayload.version,
    runnerGroup: wirePayload.runnerGroup,
    profile: wirePayload.profile,
    cliAgentSessionId: wirePayload.sessionId,
    executionContext: wirePayload.executionContext,
  };
}

export function queuedRunnerJobPayload(args: {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly executionContext: StoredExecutionContext;
}): QueuedRunnerJobPayload {
  return {
    version: 1,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    cliAgentSessionId: args.cliAgentSessionId,
    executionContext: args.executionContext,
  };
}
