import { command } from "ccstate";
import { createElement } from "react";
import { ZeroDirectedConnectPage } from "../../views/zero-page/zero-directed-connect-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupDirectedConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const type = typeof params?.type === "string" ? params.type : "";

    set(updatePage$, createElement(ZeroDirectedConnectPage), "minimal");
    set(updateDocumentTitle$, `Connect ${type}`);
    await set(hideAppSkeleton$, signal);
  },
);
