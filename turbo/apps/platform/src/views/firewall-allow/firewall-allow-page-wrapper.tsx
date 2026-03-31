import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { FirewallAllowPage } from "./firewall-allow-page.tsx";

export function FirewallAllowPageWrapper() {
  return (
    <SidebarLayout>
      <FirewallAllowPage />
    </SidebarLayout>
  );
}
