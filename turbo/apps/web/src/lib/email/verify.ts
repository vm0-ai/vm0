import { Webhook } from "svix";
import { env } from "../../env";

/**
 * Verify a Resend inbound webhook signature using Svix.
 * Resend uses Svix under the hood for webhook delivery.
 *
 * @param payload - Raw request body string
 * @param headers - Object with svix-id, svix-timestamp, svix-signature
 * @returns The verified payload parsed as JSON
 * @throws If signature verification fails
 */
export function verifyResendWebhook(
  payload: string,
  headers: {
    "svix-id": string;
    "svix-timestamp": string;
    "svix-signature": string;
  },
): unknown {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not configured");
  }
  const wh = new Webhook(secret);
  return wh.verify(payload, headers);
}

/**
 * Extract Svix signature headers from a Request.
 * Returns null if any required header is missing.
 */
export function getSvixHeaders(requestHeaders: Headers): {
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
} | null {
  const id = requestHeaders.get("svix-id");
  const timestamp = requestHeaders.get("svix-timestamp");
  const signature = requestHeaders.get("svix-signature");

  if (!id || !timestamp || !signature) {
    return null;
  }

  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
  };
}
