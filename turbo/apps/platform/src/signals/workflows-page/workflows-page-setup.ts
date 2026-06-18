import { command } from "ccstate";
import { createElement } from "react";

import { WorkflowsPage } from "../../views/workflows-page/workflows-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupWorkflowsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(WorkflowsPage), "sidebar");
    set(updateDocumentTitle$, "Workflows");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
