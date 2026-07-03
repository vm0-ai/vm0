import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { WorkflowDetailPage } from "../../views/workflows-page/workflow-detail-page.tsx";
import { activeRoute$ } from "../active-route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { isWorkflowDetailRouteKey, ROUTES } from "../route-paths.ts";
import { resetWorkflowDetailUiState$ } from "./workflows-signals.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupWorkflowDetailPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const route = get(activeRoute$);
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    if (
      isWorkflowDetailRouteKey(route) &&
      !features[FeatureSwitchKey.WorkflowAutomation]
    ) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(resetWorkflowDetailUiState$);
    set(updatePage$, createElement(WorkflowDetailPage), "sidebar");
    set(updateDocumentTitle$, "Workflow");
    await set(hideAppSkeleton$, signal);

    await set(onboardGuard$, signal);
  },
);
