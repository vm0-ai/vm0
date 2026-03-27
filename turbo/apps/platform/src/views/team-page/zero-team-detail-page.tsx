import { useGet } from "ccstate-react";
import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroJobDetailPage } from "../zero-page/zero-job-detail-page.tsx";
import { currentAgentId$ } from "../../signals/zero-page/agent.ts";

export function ZeroTeamDetailPage() {
  const agentId = useGet(currentAgentId$);

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
