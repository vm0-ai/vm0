import { safeJsonParse } from "../../signals/utils";
import { verifyCallbackRequest } from "./verify-signature";

/**
 * Raw agent event as forwarded by the events webhook.
 */
export interface AgentEvent {
  readonly type: string;
  readonly sequenceNumber: number;
  readonly [key: string]: unknown;
}

export interface RunEventContext {
  readonly userId: string;
  readonly orgId: string;
}

export interface EventConsumerPayload {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly context: RunEventContext;
}

type VerifyEventConsumerResult =
  | { readonly ok: true; readonly data: EventConsumerPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify an incoming event-consumer request.
 *
 * Uses the same HMAC scheme as web (`apps/web/src/lib/infra/event-consumer/verify.ts`)
 * with the server-side `SECRETS_ENCRYPTION_KEY` as the shared secret.
 */
export function verifyEventConsumer(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secretsEncryptionKey: string,
): VerifyEventConsumerResult {
  const verification = verifyCallbackRequest(
    rawBody,
    secretsEncryptionKey,
    signature,
    timestamp,
  );
  if (!verification.valid) {
    return { ok: false, reason: verification.error ?? "Invalid signature" };
  }

  const parsed = safeJsonParse(rawBody);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "Invalid JSON body" };
  }

  return { ok: true, data: parsed as EventConsumerPayload };
}
