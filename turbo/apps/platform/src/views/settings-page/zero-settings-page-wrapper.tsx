import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroSettingsPage } from "../zero-page/zero-settings-page.tsx";

export function ZeroSettingsPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroSettingsPage />
    </SidebarLayout>
  );
}
