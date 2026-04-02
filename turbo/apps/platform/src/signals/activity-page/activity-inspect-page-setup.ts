import { command } from "ccstate";
import { createElement } from "react";
import { ActivityInspectPageWrapper } from "../../views/activity-page/activity-inspect-page-wrapper.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { clearInspectLogData$ } from "./inspect-log-signals.ts";

export const setupActivityInspectPage$ = command(
  ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(ActivityInspectPageWrapper));
    set(updateDocumentTitle$, "Inspect Log");

    signal.addEventListener("abort", () => {
      set(clearInspectLogData$);
    });
  },
);
