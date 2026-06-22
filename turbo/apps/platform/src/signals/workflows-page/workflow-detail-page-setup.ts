import { command } from "ccstate";
import { createElement } from "react";

import { WorkflowDetailPage } from "../../views/workflows-page/workflow-detail-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { setSelectedWorkflowFilePath$ } from "./workflows-signals.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupWorkflowDetailPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setSelectedWorkflowFilePath$, null);
    set(updatePage$, createElement(WorkflowDetailPage), "sidebar");
    set(updateDocumentTitle$, "Workflow");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
