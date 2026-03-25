import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroScheduleDetailPage } from "../zero-page/zero-schedule-detail-page.tsx";

export function ZeroScheduleDetailPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroScheduleDetailPage />
    </SidebarLayout>
  );
}
