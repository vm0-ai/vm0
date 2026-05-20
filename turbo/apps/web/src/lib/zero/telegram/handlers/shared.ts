/**
 * Sentinel value for a pending user link that hasn't been claimed yet.
 * Set as telegramUserId at link time, replaced with the real
 * Telegram user ID when the user sends their first message.
 */
export const PENDING_TELEGRAM_USER_ID = "pending";

export type TelegramMessageScope =
  | string
  | { readonly kind: "custom"; readonly installationId: string }
  | { readonly kind: "official"; readonly orgId: string };
