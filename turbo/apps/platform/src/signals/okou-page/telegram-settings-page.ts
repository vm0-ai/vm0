import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import {
  reloadTelegramBots$,
  resetTelegramSettingsUi$,
  startTelegramSettingsRealtime$,
} from "./telegram.ts";
import { TelegramSettingsPage } from "../../views/okou-page/telegram-settings-page.tsx";

import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupTelegramSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetTelegramSettingsUi$);
    set(reloadTelegramBots$);
    set(updatePage$, createElement(TelegramSettingsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerSettings.telegram.documentTitle;
      }),
    );

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(startTelegramSettingsRealtime$, signal),
    ]);
  },
);
