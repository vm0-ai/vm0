import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ConnectorsPage } from "../../views/okou-page/connectors-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { resetConnectorAccountDialogs$ } from "../okou-page/settings/connector-account-dialogs.ts";

export const setupConnectorsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetConnectorAccountDialogs$);
    set(updatePage$, createElement(ConnectorsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.catalog.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
