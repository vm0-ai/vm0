import { command } from "ccstate";
import { createElement } from "react";
import { ComputerUseAuthorizationPage } from "../../views/computer-use-authorization/computer-use-authorization-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupComputerUseAuthorizationPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ComputerUseAuthorizationPage), "minimal");
    set(updateDocumentTitle$, "Authorize Computer Use");
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
