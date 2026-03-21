import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroPreferencesPage } from "../zero-page/zero-account-page.tsx";

export function ZeroPreferencesPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroPreferencesPage />
    </SidebarLayout>
  );
}
