import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroSchedulePage } from "../zero-page/zero-schedule-page.tsx";

export function ZeroSchedulePageWrapper() {
  return (
    <SidebarLayout>
      <ZeroSchedulePage />
    </SidebarLayout>
  );
}
