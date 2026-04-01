import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroActivityNetworkPage } from "../zero-page/zero-activity-network-page.tsx";

export function ZeroActivityNetworkPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroActivityNetworkPage />
    </SidebarLayout>
  );
}
