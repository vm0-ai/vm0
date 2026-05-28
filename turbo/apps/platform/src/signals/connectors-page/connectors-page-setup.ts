import { command } from "ccstate";
import { createElement } from "react";
import { ZeroConnectorsPage } from "../../views/zero-page/zero-connectors-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
export const setupConnectorsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroConnectorsPage), "sidebar");
    set(updateDocumentTitle$, "Connectors");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
