import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroWorksPage } from "../zero-page/zero-works-page.tsx";

export function ZeroWorksPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroWorksPage />
    </SidebarLayout>
  );
}
