import { command } from "ccstate";
import { createElement } from "react";
import { ZeroDirectedAuthorizePage } from "../../views/zero-page/zero-directed-authorize-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupDirectedAuthorizePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const type = typeof params?.type === "string" ? params.type : "";

    set(updatePage$, createElement(ZeroDirectedAuthorizePage), "minimal");
    set(updateDocumentTitle$, `Authorize ${type}`);
    await set(hideAppSkeleton$, signal);
  },
);
