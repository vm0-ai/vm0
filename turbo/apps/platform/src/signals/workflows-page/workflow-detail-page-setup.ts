import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { WorkflowDetailPage } from "../../views/workflows-page/workflow-detail-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { resetWorkflowDetailUiState$ } from "./workflows-signals.ts";
import { onboardGuard$ } from "../okou-page/onboard-guard.ts";
import { setOfficialWorkflowConfigurationForm$ } from "./official-workflows-signals.ts";

export const setupWorkflowDetailPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setOfficialWorkflowConfigurationForm$, null);
    set(resetWorkflowDetailUiState$);
    set(updatePage$, createElement(WorkflowDetailPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.workflows.common.workflow;
      }),
    );
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
