import { logger } from "../../lib/log";
import { settle } from "../utils";

const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";
const log = logger("telegram:check-domain");

export async function checkTelegramDomain(
  telegramBotId: string,
  appUrl: string,
): Promise<boolean> {
  const query = new URLSearchParams({
    bot_id: telegramBotId,
    origin: appUrl,
  });
  const result = await settle(
    fetch(`${TELEGRAM_OAUTH_BASE_URL}?${query}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    }),
  );
  if (!result.ok) {
    log.warn("Domain probe failed", { telegramBotId, error: result.error });
    return false;
  }

  const contentLength = result.value.headers.get("content-length");
  return contentLength !== null && Number(contentLength) > 1000;
}
