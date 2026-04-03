import { command } from "ccstate";
import { createElement } from "react";
import { SelectOrgPage } from "../../views/select-org/select-org-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupSelectOrgPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(SelectOrgPage));
    set(updateDocumentTitle$, "Select Organization");
    await set(hideAppSkeleton$, signal);
  },
);
