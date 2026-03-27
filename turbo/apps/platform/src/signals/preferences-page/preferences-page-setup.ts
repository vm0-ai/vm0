import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPreferencesPageWrapper } from "../../views/preferences-page/zero-preferences-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";

export const setupPreferencesPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroPreferencesPageWrapper));
    set(updateDocumentTitle$, "Preferences");
    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(switchActiveAgent$, null, signal);
  },
);
