import { verifyHmacSignature, isTimestampValid } from "./hmac";

interface VerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify incoming callback request signature
 *
 * @param body - Raw request body string
 * @param secret - The HMAC secret
 * @param signature - The X-VM0-Signature header value
 * @param timestamp - The X-VM0-Timestamp header value
 * @returns Verification result with error message if invalid
 */
export function verifyCallbackRequest(
  body: string,
  secret: string,
  signature: string | null,
  timestamp: string | null,
): VerifyResult {
  if (!signature) {
    return { valid: false, error: "Missing X-VM0-Signature header" };
  }

  if (!timestamp) {
    return { valid: false, error: "Missing X-VM0-Timestamp header" };
  }

  const timestampNum = parseInt(timestamp, 10);
  if (isNaN(timestampNum)) {
    return { valid: false, error: "Invalid timestamp format" };
  }

  // Check timestamp is within acceptable window (5 minutes)
  if (!isTimestampValid(timestampNum)) {
    return { valid: false, error: "Timestamp expired" };
  }

  // Verify HMAC signature
  if (!verifyHmacSignature(body, secret, timestampNum, signature)) {
    return { valid: false, error: "Invalid signature" };
  }

  return { valid: true };
}
