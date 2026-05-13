import {
  storedExecutionContextSchema,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import { z } from "zod";

import { decryptSecretsMap, encryptSecretsMap } from "./crypto.utils";

const QUEUED_RUNNER_JOB_PAYLOAD_KEY = "__api_runner_job_payload__";

const queuedRunnerJobPayloadSchema = z.object({
  version: z.literal(1),
  runnerGroup: z.string(),
  profile: z.string(),
  sessionId: z.string().nullable(),
  executionContext: storedExecutionContextSchema,
});

type QueuedRunnerJobPayload = z.infer<typeof queuedRunnerJobPayloadSchema>;

export function encryptQueuedRunnerJobPayload(
  payload: QueuedRunnerJobPayload,
): string {
  const encrypted = encryptSecretsMap({
    [QUEUED_RUNNER_JOB_PAYLOAD_KEY]: JSON.stringify(payload),
  });
  if (!encrypted) {
    throw new Error("Failed to encrypt queued runner job payload");
  }
  return encrypted;
}

export function decryptQueuedRunnerJobPayload(
  encryptedParams: string | null,
): QueuedRunnerJobPayload | null {
  if (!encryptedParams) {
    return null;
  }

  const decrypted = decryptSecretsMap(encryptedParams);
  const rawPayload = decrypted?.[QUEUED_RUNNER_JOB_PAYLOAD_KEY];
  if (!rawPayload) {
    return null;
  }

  const parsedJson: unknown = JSON.parse(rawPayload);
  return queuedRunnerJobPayloadSchema.parse(parsedJson);
}

export function queuedRunnerJobPayload(args: {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly sessionId: string | null;
  readonly executionContext: StoredExecutionContext;
}): QueuedRunnerJobPayload {
  return {
    version: 1,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    sessionId: args.sessionId,
    executionContext: args.executionContext,
  };
}
