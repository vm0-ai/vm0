import crypto from "crypto";

/**
 * Verify Telegram webhook request using the secret token header.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param request - Incoming request
 * @param expectedSecret - The webhook secret set during setWebhook
 * @returns true if the secret token matches
 */
export function verifyTelegramWebhook(
  request: Request,
  expectedSecret: string,
): boolean {
  const token = request.headers.get("x-telegram-bot-api-secret-token");

  if (!token) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expectedSecret),
    );
  } catch {
    // Buffers have different lengths
    return false;
  }
}
