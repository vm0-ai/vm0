import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Schema for Telegram Login Widget auth data.
 * @see https://core.telegram.org/widgets/login#receiving-authorization-data
 */
export const telegramAuthSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
});

export type TelegramAuthData = z.infer<typeof telegramAuthSchema>;

const MAX_AUTH_AGE_SECONDS = 300; // 5 minutes

/**
 * Verify Telegram Login Widget authorization data.
 *
 * 1. Build data-check-string from sorted key=value pairs (excluding hash)
 * 2. secret_key = SHA256(bot_token)
 * 3. Verify HMAC-SHA256(data-check-string, secret_key) === hash
 * 4. Check auth_date is not too old
 *
 * @see https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyTelegramLogin(
  auth: TelegramAuthData,
  botToken: string,
): boolean {
  // Check auth_date freshness
  const now = Math.floor(Date.now() / 1000);
  if (now - auth.auth_date > MAX_AUTH_AGE_SECONDS) {
    return false;
  }

  // Build data-check-string
  const checkString = Object.entries(auth)
    .filter(([key]) => {
      return key !== "hash";
    })
    .filter(([, value]) => {
      return value !== undefined;
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  // secret_key = SHA256(bot_token)
  const secretKey = createHash("sha256").update(botToken).digest();

  // HMAC-SHA256(data-check-string, secret_key)
  const hmac = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  const hmacBuf = Buffer.from(hmac, "hex");
  const hashBuf = Buffer.from(auth.hash, "hex");
  if (hmacBuf.length !== hashBuf.length) return false;
  return timingSafeEqual(hmacBuf, hashBuf);
}
