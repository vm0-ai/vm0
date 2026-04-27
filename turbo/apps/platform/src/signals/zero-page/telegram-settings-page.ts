import { command } from "ccstate";
import { createElement } from "react";
import { isTelegramIntegrationEnabled$ } from "./zero-telegram.ts";
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

    set(
      updatePage$,
      createElement("div", {
        className: "flex flex-1 min-h-0",
        "data-testid": "telegram-settings-route",
      }),
      "sidebar",
    );
    set(updateDocumentTitle$, "Telegram");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
