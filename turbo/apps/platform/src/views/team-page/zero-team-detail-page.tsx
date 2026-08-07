import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ZeroJobDetailPage } from "./zero-job-detail-page.tsx";
import { currentAgentId$ } from "../../signals/agent.ts";

export function AgentDetailPage() {
  const { t } = useTranslation("agents");
  const agentId = useGet(currentAgentId$);

  return agentId ? (
    <ZeroJobDetailPage />
  ) : (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      {t(($) => {
        return $.detail.noSelection;
      })}
    </div>
  );
}
