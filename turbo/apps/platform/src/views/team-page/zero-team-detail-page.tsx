import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroJobDetailPage } from "../zero-page/zero-job-detail-page.tsx";

export function ZeroTeamDetailPage({ agentId }: { agentId: string | null }) {
  return (
    <SidebarLayout>
      {agentId ? (
        <ZeroJobDetailPage agentId={agentId} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No agent selected
        </div>
      )}
    </SidebarLayout>
  );
}
