import { command } from "ccstate";
import { createElement } from "react";
import {
  reloadTelegramBots$,
  resetTelegramSettingsUi$,
  startTelegramSettingsRealtime$,
} from "./zero-telegram.ts";
import { ZeroTelegramSettingsPage } from "../../views/zero-page/zero-telegram-settings-page.tsx";

import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupTelegramSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetTelegramSettingsUi$);
    set(reloadTelegramBots$);
    set(updatePage$, createElement(ZeroTelegramSettingsPage), "sidebar");
    set(updateDocumentTitle$, "Telegram");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(onboardGuard$, signal),
      set(startTelegramSettingsRealtime$, signal),
    ]);
  },
);
