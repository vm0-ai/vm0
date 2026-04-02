import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroDirectedConnectPage } from "../../views/zero-page/zero-directed-connect-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";

export const setupDirectedConnectPage$ = command(({ get, set }) => {
  const params = get(pathParams$);
  const type = typeof params?.type === "string" ? params.type : "";

  set(
    updatePage$,
    createElement(SidebarLayout, null, createElement(ZeroDirectedConnectPage)),
  );
  set(updateDocumentTitle$, `Connect ${type}`);
});
