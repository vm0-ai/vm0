import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ActivityInspectPage } from "./activity-inspect-page.tsx";

export function ActivityInspectPageWrapper() {
  return (
    <SidebarLayout>
      <ActivityInspectPage />
    </SidebarLayout>
  );
}
