/**
 * Build the webhook URL that Telegram will POST updates to for a given bot.
 * The URL path carries the bot id so the route handler can look up the
 * installation without relying on a cookie or header.
 */
export function buildTelegramWebhookUrl(
  baseUrl: string,
  telegramBotId: string,
): string {
  return `${baseUrl}/api/telegram/webhook/${telegramBotId}`;
}
