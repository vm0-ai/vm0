const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";
const TELEGRAM_AUTH_CALLBACK_SEGMENTS = [
  "api",
  "integrations",
  "telegram",
  "auth-callback",
] as const;

export function openTelegramLoginPopup(botId: string, callbackBase: string) {
  const callbackUrl = new URL(
    `/${TELEGRAM_AUTH_CALLBACK_SEGMENTS.join("/")}`,
    callbackBase,
  );
  callbackUrl.searchParams.set("targetOrigin", window.location.origin);

  const authUrl = new URL(TELEGRAM_OAUTH_BASE_URL);
  authUrl.searchParams.set("bot_id", botId);
  authUrl.searchParams.set("origin", window.location.origin);
  authUrl.searchParams.set("request_access", "write");
  authUrl.searchParams.set("return_to", callbackUrl.toString());

  const width = 550;
  const height = 450;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  window.open(
    authUrl.toString(),
    "telegram_login",
    `width=${width},height=${height},left=${left},top=${top}`,
  );
}
