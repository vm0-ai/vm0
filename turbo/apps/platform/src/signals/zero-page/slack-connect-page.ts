import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { ZeroSlackConnectPage } from "../../views/zero-page/zero-slack-connect-page.tsx";
import { initSlackConnectPage$ } from "./slack-connect-signals.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupSlackConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(updatePage$, createElement(ZeroSlackConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.slack.connectTitle;
      }),
    );
    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(initSlackConnectPage$, signal),
    ]);
  },
);
