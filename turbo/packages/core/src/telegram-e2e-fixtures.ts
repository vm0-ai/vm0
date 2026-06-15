/**
 * Canned Telegram Bot API fixture identifiers used by the e2e Telegram mock
 * routes under `/api/test/telegram-mock/*` and by BATS helpers.
 */
export const TELEGRAM_E2E_FIXTURES = {
  botId: "123456",
  botUsername: "vm0_e2e_bot",
  botToken: "123456:e2e-test-bot-token",
  webhookSecret: "e2e-telegram-webhook-secret",
  telegramUserId: "99001",
  chatId: "990010",
  firstName: "E2E",
} as const;
