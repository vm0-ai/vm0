import { tapError } from "../utils";

const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";

export async function checkTelegramDomain(
  telegramBotId: string,
  appUrl: string,
): Promise<boolean> {
  const query = new URLSearchParams({
    bot_id: telegramBotId,
    origin: appUrl,
  });
  // A probe that cannot reach Telegram is expected transient noise, not an
  // actionable failure, so it is not logged. The outbound HEAD is already
  // traced as a client span, which carries its own error status and duration.
  const response = await tapError(
    fetch(`${TELEGRAM_OAUTH_BASE_URL}?${query}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    }),
  );
  if (!response) {
    return false;
  }

  const contentLength = response.headers.get("content-length");
  return contentLength !== null && Number(contentLength) > 1000;
}
