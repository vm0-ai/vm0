import { command } from "ccstate";
import { createElement } from "react";
import { SelectOrgPage } from "../../views/select-org/select-org-page.tsx";
import { updatePage$ } from "../react-router.ts";

export const setupSelectOrgPage$ = command(({ set }) => {
  set(updatePage$, createElement(SelectOrgPage));
});
