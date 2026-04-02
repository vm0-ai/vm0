import crypto from "crypto";

/**
 * Verify Slack request signature
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param signingSecret - Slack app signing secret
 * @param signature - x-slack-signature header value
 * @param timestamp - x-slack-request-timestamp header value
 * @param body - Raw request body string
 * @returns true if signature is valid
 */
export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  // Protect against replay attacks - reject requests older than 5 minutes
  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(currentTime - requestTime) > 60 * 5) {
    return false;
  }

  // Compute expected signature
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  const expectedSignature = `v0=${hmac.update(baseString).digest("hex")}`;

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  } catch {
    // Buffers have different lengths
    return false;
  }
}

/**
 * Extract and validate Slack signature headers from a request
 *
 * @param headers - Request headers
 * @returns Signature headers or null if missing
 */
export function getSlackSignatureHeaders(
  headers: Headers,
): { signature: string; timestamp: string } | null {
  const signature = headers.get("x-slack-signature");
  const timestamp = headers.get("x-slack-request-timestamp");

  if (!signature || !timestamp) {
    return null;
  }

  return { signature, timestamp };
}
