import { createHmac } from "node:crypto";

import { now } from "../time";

/**
 * Compute HMAC-SHA256 signature for an event-consumer payload.
 *
 * The signed string is `${timestamp}.${payload}` so a captured signature
 * cannot be replayed against a different timestamp window.
 */
export function computeHmacSignature(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  const signaturePayload = `${timestamp}.${payload}`;
  return createHmac("sha256", secret).update(signaturePayload).digest("hex");
}

/**
 * Verify HMAC signature matches expected value.
 *
 * Uses timing-safe XOR comparison to prevent timing attacks. Identical to
 * the web implementation in `apps/web/src/lib/infra/callback/hmac.ts`.
 */
export function verifyHmacSignature(
  payload: string,
  secret: string,
  timestamp: number,
  signature: string,
): boolean {
  const expected = computeHmacSignature(payload, secret, timestamp);

  if (expected.length !== signature.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Check if timestamp is within acceptable window. Defaults to 5 minutes,
 * matching web's replay window.
 */
export function isTimestampValid(
  timestamp: number,
  maxAgeSeconds = 300,
): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  return Math.abs(nowSeconds - timestamp) <= maxAgeSeconds;
}
