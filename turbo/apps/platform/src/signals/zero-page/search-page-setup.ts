import { command } from "ccstate";
import { createElement } from "react";
import { ZeroSearchPage } from "../../views/zero-page/zero-search-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setChatListQuery$ } from "./zero-sidebar-state.ts";

export const setupSearchPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroSearchPage), "sidebar");
    set(updateDocumentTitle$, "Search");

    // Start with an empty query so the input is fresh on every open. The
    // signal is shared with the chat list page; clearing here keeps the
    // chat list filter empty when the user navigates back.
    set(setChatListQuery$, "");

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
