import { useGet } from "ccstate-react";
import { ZeroJobDetailPage } from "../zero-page/zero-job-detail-page.tsx";
import { currentAgentId$ } from "../../signals/agent.ts";

export function ZeroTeamDetailPage() {
  const agentId = useGet(currentAgentId$);

  return agentId ? (
    <ZeroJobDetailPage agentId={agentId} />
  ) : (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      No agent selected
    </div>
  );
}
