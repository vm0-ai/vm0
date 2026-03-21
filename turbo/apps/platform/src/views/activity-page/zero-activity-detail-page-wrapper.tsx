import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroActivityDetailPage } from "../zero-page/zero-activity-detail-page.tsx";

export function ZeroActivityDetailPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroActivityDetailPage />
    </SidebarLayout>
  );
}
