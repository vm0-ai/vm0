import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { TelegramSettingsPage } from "../../views/integrations-page/telegram-settings-page";
import { fetchTelegramIntegration$ } from "./telegram-integration.ts";
import { fetchAgentsList$ } from "../agents-page/agents-list.ts";

/**
 * Setup the Telegram settings detail page.
 */
export const setupTelegramSettingsPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(TelegramSettingsPage));
  await Promise.all([set(fetchTelegramIntegration$), set(fetchAgentsList$)]);
});
