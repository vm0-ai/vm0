import { command } from "ccstate";
import { createElement } from "react";
import { ZeroDirectedAuthorizePage } from "../../views/zero-page/zero-directed-authorize-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupDirectedAuthorizePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    const params = get(pathParams$);
    const connectorSlug =
      typeof params?.connectorSlug === "string" ? params.connectorSlug : "";

    set(updatePage$, createElement(ZeroDirectedAuthorizePage), "minimal");
    set(updateDocumentTitle$, `Authorize ${connectorSlug}`);
    await set(hideAppSkeleton$, signal);
  },
);
