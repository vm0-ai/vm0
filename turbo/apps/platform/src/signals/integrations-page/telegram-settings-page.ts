import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { navigate$ } from "../route.ts";
import { TelegramSettingsPage } from "../../views/integrations-page/telegram-settings-page";
import {
  fetchTelegramIntegration$,
  startTelegramLoginListener$,
  telegramIntegrationNotLinked$,
} from "./telegram-integration.ts";
import { fetchAgentsList$ } from "../agents-page/agents-list.ts";

/**
 * Setup the Telegram settings detail page.
 * Redirects to integrations tab if not linked.
 */
export const setupTelegramSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(TelegramSettingsPage));
    set(startTelegramLoginListener$, signal);
    await Promise.all([set(fetchTelegramIntegration$), set(fetchAgentsList$)]);
    signal.throwIfAborted();

    if (get(telegramIntegrationNotLinked$)) {
      await set(
        navigate$,
        "/settings",
        { searchParams: new URLSearchParams({ tab: "integrations" }) },
        signal,
      );
    }
  },
);
