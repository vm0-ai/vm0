import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroJobDetailPage } from "../zero-page/zero-job-detail-page.tsx";

interface ZeroTeamDetailPageProps {
  agentName: string | null;
}

export function ZeroTeamDetailPage({ agentName }: ZeroTeamDetailPageProps) {
  return (
    <SidebarLayout>
      {agentName ? <ZeroJobDetailPage agentName={agentName} /> : null}
    </SidebarLayout>
  );
}
