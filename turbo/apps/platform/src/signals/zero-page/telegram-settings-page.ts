import { command } from "ccstate";
import { createElement } from "react";
import {
  isTelegramIntegrationEnabled$,
  resetTelegramSettingsUi$,
} from "./zero-telegram.ts";
import { ZeroTelegramSettingsPage } from "../../views/zero-page/zero-telegram-settings-page.tsx";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupTelegramSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const enabled = await get(isTelegramIntegrationEnabled$);
    signal.throwIfAborted();

    if (!enabled) {
      set(detachedNavigateTo$, ROUTES.works, { replace: true });
      return;
    }

    set(resetTelegramSettingsUi$);
    set(updatePage$, createElement(ZeroTelegramSettingsPage), "sidebar");
    set(updateDocumentTitle$, "Telegram");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
