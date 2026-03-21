import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroJobsPage } from "../zero-page/zero-jobs-page.tsx";

export function ZeroTeamPage() {
  return (
    <SidebarLayout>
      <ZeroJobsPage />
    </SidebarLayout>
  );
}
