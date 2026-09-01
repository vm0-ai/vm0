import { command } from "ccstate";
import { createElement } from "react";
import {
  MORNING_BRIEF_PREFERENCES_FOCUS,
  MORNING_BRIEF_PREFERENCES_TAB,
} from "@okouai/api-contracts/contracts/morning-brief-preference";

import { i18n } from "../../i18n/index.ts";
import { WorkflowDetailPage } from "../../views/workflows-page/workflow-detail-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  currentWorkflowDetail$,
  isMorningBriefWorkflow,
  resetWorkflowDetailUiState$,
} from "./workflows-signals.ts";
import { setOfficialWorkflowConfigurationForm$ } from "./official-workflows-signals.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

export const setupWorkflowDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setOfficialWorkflowConfigurationForm$, null);
    set(resetWorkflowDetailUiState$);
    const detail = await get(currentWorkflowDetail$);
    signal.throwIfAborted();
    if (detail && isMorningBriefWorkflow(detail)) {
      const searchParams = new URLSearchParams({
        tab: MORNING_BRIEF_PREFERENCES_TAB,
        focus: MORNING_BRIEF_PREFERENCES_FOCUS,
      });
      set(detachedNavigateTo$, ROUTES.settings, {
        searchParams,
        replace: true,
      });
      return;
    }
    set(updatePage$, createElement(WorkflowDetailPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.workflows.common.workflow;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
