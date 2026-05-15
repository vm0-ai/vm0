import { command } from "ccstate";
import { createElement } from "react";
import { ZeroConnectorsPage } from "../../views/zero-page/zero-connectors-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  LOCAL_BROWSER_CONNECTOR_TYPE,
  setSelectedConnectorType$,
} from "../zero-page/settings/connectors.ts";
export const setupConnectorsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ZeroConnectorsPage), "sidebar");
    set(updateDocumentTitle$, "Connectors");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);

export const setupLocalBrowserConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setSelectedConnectorType$, LOCAL_BROWSER_CONNECTOR_TYPE);
    await set(setupConnectorsPage$, signal);
  },
);
