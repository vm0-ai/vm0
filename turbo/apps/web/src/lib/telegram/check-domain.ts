import { TELEGRAM_OAUTH_BASE_URL } from "./constants";
import { logger } from "../logger";

const log = logger("telegram:check-domain");

/**
 * Probe the Telegram OAuth endpoint to check if the bot's domain is configured
 * in BotFather. A configured domain returns a full HTML page (>1KB);
 * an unconfigured one returns a short error string.
 */
export async function checkTelegramDomain(
  telegramBotId: string,
  platformUrl: string,
): Promise<boolean> {
  try {
    const probeOrigin = encodeURIComponent(platformUrl);
    const probeUrl = `${TELEGRAM_OAUTH_BASE_URL}?bot_id=${telegramBotId}&origin=${probeOrigin}`;
    const probeResp = await fetch(probeUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    const contentLength = probeResp.headers.get("content-length");
    return contentLength !== null && Number(contentLength) > 1000;
  } catch (error) {
    log.warn("Domain probe failed", { telegramBotId, error });
    return false;
  }
}
