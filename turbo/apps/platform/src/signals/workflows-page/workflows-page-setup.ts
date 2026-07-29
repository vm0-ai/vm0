import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { WorkflowsPage } from "../../views/workflows-page/workflows-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadWorkflows$ } from "./workflows-signals.ts";

export const setupWorkflowsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(WorkflowsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.workflows.common.workflows;
      }),
    );
    set(reloadWorkflows$);
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }
  },
);
