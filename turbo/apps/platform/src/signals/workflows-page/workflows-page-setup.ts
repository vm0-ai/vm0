import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { WorkflowsPage } from "../../views/workflows-page/workflows-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { reloadWorkflows$ } from "./workflows-signals.ts";

export const setupWorkflowsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    if (!features[FeatureSwitchKey.WorkflowAutomation]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(updatePage$, createElement(WorkflowsPage), "sidebar");
    set(updateDocumentTitle$, "Workflows");
    set(reloadWorkflows$);
    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(reloadChatThreads$);
  },
);
