import { setupActivityDetailPage$ } from "../activity-page/activity-detail-page-setup.ts";
import { setupActivityInspectPage$ } from "../activity-page/activity-inspect-page-setup.ts";
import { setupArtifactsPage$ } from "../artifacts-page/artifacts-page-setup.ts";
import { setupExportPage$ } from "../export-page/export-page-setup.ts";
import { setupWorksPage$ } from "../works-page/works-page-setup.ts";

export function getActivityRouteSetups() {
  return {
    setupActivityDetailPage$,
    setupActivityInspectPage$,
    setupArtifactsPage$,
    setupExportPage$,
    setupWorksPage$,
  };
}
