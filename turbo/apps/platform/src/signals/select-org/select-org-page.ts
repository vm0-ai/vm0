import { command } from "ccstate";
import { createElement } from "react";
import { SelectOrgPage } from "../../views/select-org/select-org-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";

export const setupSelectOrgPage$ = command(({ set }) => {
  set(updatePage$, createElement(SelectOrgPage));
  set(updateDocumentTitle$, "Select Organization");
});
