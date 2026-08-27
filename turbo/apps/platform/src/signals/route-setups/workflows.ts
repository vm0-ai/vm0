import { setupWorkflowDetailPage$ } from "../workflows-page/workflow-detail-page-setup.ts";
import { setupWorkflowsPage$ } from "../workflows-page/workflows-page-setup.ts";

export function getWorkflowRouteSetups() {
  return {
    setupWorkflowDetailPage$,
    setupWorkflowsPage$,
  };
}
