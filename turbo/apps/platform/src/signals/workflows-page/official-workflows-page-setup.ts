import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { OfficialWorkflowsPage } from "../../views/workflows-page/official-workflows-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  reloadOfficialWorkflows$,
  setOfficialWorkflowConfigurationForm$,
} from "./official-workflows-signals.ts";

export const setupOfficialWorkflowsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setOfficialWorkflowConfigurationForm$, null);
    set(reloadOfficialWorkflows$);
    set(updatePage$, createElement(OfficialWorkflowsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.workflows.official.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
