import { createHmac, randomBytes } from "crypto";

/**
 * Generate a random secret for HMAC signing
 * Returns a 32-byte hex string (64 characters)
 */
export function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compute HMAC-SHA256 signature for callback payload
 *
 * @param payload - The JSON payload to sign
 * @param secret - The HMAC secret key
 * @param timestamp - Unix timestamp in seconds
 * @returns The hex-encoded HMAC signature
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
 * Verify HMAC signature matches expected value
 *
 * Uses timing-safe comparison to prevent timing attacks
 */
export function verifyHmacSignature(
  payload: string,
  secret: string,
  timestamp: number,
  signature: string,
): boolean {
  const expected = computeHmacSignature(payload, secret, timestamp);

  // Timing-safe comparison
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
 * Check if timestamp is within acceptable window (5 minutes)
 * Prevents replay attacks
 */
export function isTimestampValid(
  timestamp: number,
  maxAgeSeconds: number = 300,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= maxAgeSeconds;
}
