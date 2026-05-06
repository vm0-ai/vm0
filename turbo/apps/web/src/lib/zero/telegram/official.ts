import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { env } from "../../../env";

export { OFFICIAL_TELEGRAM_BOT_ID };

export function isOfficialTelegramBotId(botId: string): boolean {
  return botId === OFFICIAL_TELEGRAM_BOT_ID;
}

interface OfficialTelegramBotConfig {
  botId: string | null;
  botToken: string | null;
  botUsername: string | null;
  webhookSecret: string | null;
  configured: boolean;
}

function normalizeBotUsername(username: string | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, "");
  return normalized || null;
}

function parseTelegramBotId(botToken: string | undefined): string | null {
  const id = botToken?.split(":", 1)[0]?.trim();
  return id && /^\d+$/.test(id) ? id : null;
}

export function getOfficialTelegramBotConfig(): OfficialTelegramBotConfig {
  const e = env();
  const botToken = e.TELEGRAM_OFFICIAL_BOT_TOKEN ?? null;
  const webhookSecret = e.TELEGRAM_OFFICIAL_WEBHOOK_SECRET ?? null;
  const botId = parseTelegramBotId(botToken ?? undefined);
  const botUsername = normalizeBotUsername(e.TELEGRAM_OFFICIAL_BOT_USERNAME);

  return {
    botId,
    botToken,
    botUsername,
    webhookSecret,
    configured: Boolean(botToken && botId && webhookSecret),
  };
}
