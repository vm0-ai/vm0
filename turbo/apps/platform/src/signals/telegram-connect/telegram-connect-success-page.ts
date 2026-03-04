import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { TelegramConnectSuccessPage } from "../../views/telegram-connect/telegram-connect-success-page.tsx";

export const setupTelegramConnectSuccessPage$ = command(({ get, set }) => {
  set(updatePage$, createElement(TelegramConnectSuccessPage));

  // Auto-open Telegram app with deep link to trigger /start with link token
  const params = get(searchParams$);
  const botUsername = params.get("bot");
  const linkToken = params.get("token");
  if (botUsername) {
    const startParam = linkToken ? `&start=${linkToken}` : "";
    window.location.href = `tg://resolve?domain=${botUsername}${startParam}`;
  }
});
