import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";

import { env } from "../../lib/env";

export { OFFICIAL_TELEGRAM_BOT_ID };

interface OfficialTelegramBotConfig {
  readonly botId: string | null;
  readonly botToken: string | null;
  readonly botUsername: string | null;
  readonly webhookSecret: string | null;
  readonly configured: boolean;
}

export function isOfficialTelegramBotId(botId: string): boolean {
  return botId === OFFICIAL_TELEGRAM_BOT_ID;
}

function normalizeBotUsername(username: string | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, "");
  return normalized && normalized.length > 0 ? normalized : null;
}

function parseTelegramBotId(botToken: string | undefined): string | null {
  const id = botToken?.split(":", 1)[0]?.trim();
  return id && /^\d+$/.test(id) ? id : null;
}

export function getOfficialTelegramBotConfig(): OfficialTelegramBotConfig {
  const botToken = env("TELEGRAM_OFFICIAL_BOT_TOKEN") ?? null;
  const webhookSecret = env("TELEGRAM_OFFICIAL_WEBHOOK_SECRET") ?? null;
  const botId = parseTelegramBotId(botToken ?? undefined);
  const botUsername = normalizeBotUsername(
    env("TELEGRAM_OFFICIAL_BOT_USERNAME"),
  );
  return {
    botId,
    botToken,
    botUsername,
    webhookSecret,
    configured: Boolean(botToken && botId && webhookSecret),
  };
}
