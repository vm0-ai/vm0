import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { agentRunCallbacks } from "../../db/schema/agent-run-callback";
import { decryptCredentialValue } from "../crypto/secrets-encryption";
import { env } from "../../env";
import { verifyCallbackRequest } from "./verify-signature";

interface Logger {
  warn: (...args: unknown[]) => void;
}

/**
 * Parsed and verified callback request data.
 * Generic over the payload type so each endpoint can narrow its own payload shape.
 */
interface VerifiedCallback<P = unknown> {
  callbackId: string;
  runId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  payload: P;
}

type VerifyCallbackResult<P> =
  | { ok: true; data: VerifiedCallback<P> }
  | { ok: false; response: NextResponse };

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Verify an incoming callback request: parse body, look up callback record by
 * primary key (`callbackId`), decrypt the per-callback secret, and verify the
 * HMAC signature.
 *
 * Replaces the duplicated verification pattern previously copy-pasted across
 * all callback endpoints. When verification fails the returned `response` can
 * be returned directly from the route handler.
 */
export async function verifyCallback<P = unknown>(
  request: NextRequest,
  log: Logger,
): Promise<VerifyCallbackResult<P>> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  const rawBody = await request.text();

  let body: {
    callbackId?: string;
    runId?: string;
    status: "completed" | "failed";
    result?: Record<string, unknown>;
    error?: string;
    payload: P;
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, response: errorResponse("Invalid JSON body", 400) };
  }

  const { callbackId, runId } = body;

  if (!callbackId && !runId) {
    return {
      ok: false,
      response: errorResponse("Missing callbackId and runId", 400),
    };
  }

  // Look up the callback record — prefer callbackId (PK) for unambiguous lookup
  const [callback] = callbackId
    ? await globalThis.services.db
        .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
        .from(agentRunCallbacks)
        .where(eq(agentRunCallbacks.id, callbackId))
        .limit(1)
    : await globalThis.services.db
        .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
        .from(agentRunCallbacks)
        .where(eq(agentRunCallbacks.runId, runId!))
        .limit(1);

  if (!callback) {
    log.warn("Callback record not found", { callbackId, runId });
    return {
      ok: false,
      response: errorResponse("Callback not found", 404),
    };
  }

  const callbackSecret = decryptCredentialValue(
    callback.encryptedSecret,
    SECRETS_ENCRYPTION_KEY,
  );

  const signature = request.headers.get("X-VM0-Signature");
  const timestamp = request.headers.get("X-VM0-Timestamp");

  const verification = verifyCallbackRequest(
    rawBody,
    callbackSecret,
    signature,
    timestamp,
  );

  if (!verification.valid) {
    log.warn("Callback signature verification failed", {
      callbackId,
      runId,
      error: verification.error,
    });
    return {
      ok: false,
      response: errorResponse(verification.error ?? "Invalid signature", 401),
    };
  }

  return {
    ok: true,
    data: {
      callbackId: callbackId ?? runId!,
      runId: runId ?? callbackId!,
      status: body.status,
      result: body.result,
      error: body.error,
      payload: body.payload,
    },
  };
}
