import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroActivityPage } from "../zero-page/zero-activity-page.tsx";

export function ZeroActivityPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroActivityPage />
    </SidebarLayout>
  );
}
