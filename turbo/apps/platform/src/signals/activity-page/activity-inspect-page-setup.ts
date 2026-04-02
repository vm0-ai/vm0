import { command } from "ccstate";
import { createElement } from "react";
import { ActivityInspectPageWrapper } from "../../views/activity-page/activity-inspect-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";

export const setupActivityInspectPage$ = command(({ set }) => {
  set(updatePage$, createElement(ActivityInspectPageWrapper));
  set(updateDocumentTitle$, "Inspect Log");
});
