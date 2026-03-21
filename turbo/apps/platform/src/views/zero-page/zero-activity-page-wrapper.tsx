import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroActivityPage } from "./zero-activity-page.tsx";

export function ZeroActivityPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroActivityPage />
    </SidebarLayout>
  );
}
