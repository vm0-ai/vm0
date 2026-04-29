import { command } from "ccstate";
import { createElement } from "react";
import { ZeroAccountHubPage } from "../../views/zero-page/zero-account-hub-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupAccountHubPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroAccountHubPage), "sidebar");
    set(updateDocumentTitle$, "Account");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
