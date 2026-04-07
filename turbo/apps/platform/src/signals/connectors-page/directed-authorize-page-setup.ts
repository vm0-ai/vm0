import { command } from "ccstate";
import { createElement } from "react";
import { ZeroDirectedAuthorizePage } from "../../views/zero-page/zero-directed-authorize-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";

export const setupDirectedAuthorizePage$ = command(({ get, set }) => {
  const params = get(pathParams$);
  const type = typeof params?.type === "string" ? params.type : "";

  set(updatePage$, createElement(ZeroDirectedAuthorizePage));
  set(updateDocumentTitle$, `Authorize ${type}`);
});
