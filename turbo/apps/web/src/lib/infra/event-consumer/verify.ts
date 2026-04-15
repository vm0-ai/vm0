import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env } from "../../../env";
import { verifyCallbackRequest } from "../callback/verify-signature";
import type { EventConsumerPayload } from "./types";

type VerifyResult =
  | { ok: true; data: EventConsumerPayload }
  | { ok: false; response: NextResponse };

/**
 * Verify an incoming event consumer request.
 *
 * Uses the same HMAC signing scheme as callbacks, but with the server-side
 * SECRETS_ENCRYPTION_KEY as the shared secret (since event consumers are
 * internal server-to-self dispatches, not per-callback secrets).
 */
export async function verifyEventConsumer(
  request: NextRequest,
): Promise<VerifyResult> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  const rawBody = await request.text();
  const signature = request.headers.get("X-VM0-Signature");
  const timestamp = request.headers.get("X-VM0-Timestamp");

  const verification = verifyCallbackRequest(
    rawBody,
    SECRETS_ENCRYPTION_KEY,
    signature,
    timestamp,
  );

  if (!verification.valid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: verification.error ?? "Invalid signature" },
        { status: 401 },
      ),
    };
  }

  const data: EventConsumerPayload = JSON.parse(rawBody);
  return { ok: true, data };
}
