import crypto from "crypto";

/**
 * Verify GitHub webhook signature using HMAC-SHA256.
 *
 * GitHub sends X-Hub-Signature-256 in the format: sha256=<hex-digest>
 * The payload is signed with the webhook secret configured in the GitHub App.
 *
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
export function verifyGitHubWebhookSignature(
  secret: string,
  signature: string,
  body: string,
): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  const expectedSignature = `sha256=${hmac.update(body).digest("hex")}`;

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
 * Extract GitHub webhook headers from a request.
 *
 * @returns Signature and event type headers, or null if required headers are missing
 */
export function getGitHubWebhookHeaders(headers: Headers): {
  signature: string;
  event: string;
  deliveryId: string;
} | null {
  const signature = headers.get("x-hub-signature-256");
  const event = headers.get("x-github-event");
  const deliveryId = headers.get("x-github-delivery");

  if (!signature || !event || !deliveryId) {
    return null;
  }

  return { signature, event, deliveryId };
}
