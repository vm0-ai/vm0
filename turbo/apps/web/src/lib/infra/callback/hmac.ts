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
