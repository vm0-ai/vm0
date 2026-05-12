import { logger } from "../../lib/log";
import { safeAsync } from "../utils";

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
  const result = await safeAsync(() => {
    return fetch(`${TELEGRAM_OAUTH_BASE_URL}?${query}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
  });
  if ("error" in result) {
    log.warn("Domain probe failed", { telegramBotId, error: result.error });
    return false;
  }

  const contentLength = result.ok.headers.get("content-length");
  return contentLength !== null && Number(contentLength) > 1000;
}
