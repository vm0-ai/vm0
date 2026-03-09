const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";

/**
 * Open the Telegram Login popup for OAuth authentication.
 */
export function openTelegramLoginPopup(botId: string): void {
  const origin = encodeURIComponent(window.location.origin);
  const returnTo = encodeURIComponent(
    `${window.location.origin}/api/integrations/telegram/auth-callback`,
  );
  const authUrl = `${TELEGRAM_OAUTH_BASE_URL}?bot_id=${botId}&origin=${origin}&request_access=write&return_to=${returnTo}`;

  const width = 550;
  const height = 450;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  window.open(
    authUrl,
    "telegram_login",
    `width=${width},height=${height},left=${left},top=${top}`,
  );
}
