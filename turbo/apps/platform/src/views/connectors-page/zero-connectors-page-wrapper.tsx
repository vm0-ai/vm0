import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroConnectorsPage } from "../zero-page/zero-connectors-page.tsx";

export function ZeroConnectorsPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroConnectorsPage />
    </SidebarLayout>
  );
}
