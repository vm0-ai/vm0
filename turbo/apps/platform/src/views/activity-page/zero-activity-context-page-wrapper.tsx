import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroActivityContextPage } from "../zero-page/zero-activity-context-page.tsx";

export function ZeroActivityContextPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroActivityContextPage />
    </SidebarLayout>
  );
}
