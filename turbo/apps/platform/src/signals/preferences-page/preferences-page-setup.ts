import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPreferencesPage } from "../../views/zero-page/zero-account-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupPreferencesPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroPreferencesPage), "sidebar");
    set(updateDocumentTitle$, "Preferences");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
