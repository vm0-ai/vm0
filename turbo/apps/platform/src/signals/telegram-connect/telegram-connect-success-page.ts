import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { TelegramConnectSuccessPage } from "../../views/telegram-connect/telegram-connect-success-page.tsx";

export const setupTelegramConnectSuccessPage$ = command(({ get, set }) => {
  set(updatePage$, createElement(TelegramConnectSuccessPage));

  // Auto-open Telegram on page load
  const params = get(searchParams$);
  const botUsername = params.get("bot");
  if (botUsername) {
    window.location.href = `https://t.me/${botUsername}`;
  }
});
