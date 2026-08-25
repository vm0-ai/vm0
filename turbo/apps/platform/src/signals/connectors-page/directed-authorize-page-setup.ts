import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { DirectedAuthorizePage } from "../../views/okou-page/directed-authorize-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "../okou-page/onboard-guard.ts";

export const setupDirectedAuthorizePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    const params = get(pathParams$);
    const connectorSlug =
      typeof params?.connectorSlug === "string" ? params.connectorSlug : "";

    set(updatePage$, createElement(DirectedAuthorizePage), "minimal");
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.connectors.directed.authorizeDocumentTitle;
        },
        { connector: connectorSlug },
      ),
    );
    await set(hideAppSkeleton$, signal);
  },
);
