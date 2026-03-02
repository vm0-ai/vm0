import { useGet } from "ccstate-react";
import { AppShell } from "../layout/app-shell.tsx";
import { agentName$ } from "../../signals/agent-detail/agent-detail.ts";
import { currentLogId$ } from "../../signals/logs-page/log-detail-state.ts";
import { LogDetailContent } from "../logs-page/log-detail/components/log-detail-content.tsx";
import { SecretDialog } from "../settings-page/secret-dialog.tsx";

export function AgentLogDetailPage() {
  const agentName = useGet(agentName$);
  const logId = useGet(currentLogId$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        {
          label: agentName ?? "Loading...",
          path: agentName ? "/agents/:name" : undefined,
          pathParams: agentName ? { name: agentName } : undefined,
        },
        {
          label: "Logs",
          path: agentName ? "/agents/:name/logs" : undefined,
          pathParams: agentName ? { name: agentName } : undefined,
        },
        { label: logId ? `Run ID - ${logId}` : "Detail" },
      ]}
    >
      <div className="h-full flex flex-col">
        {logId ? (
          <LogDetailContent />
        ) : (
          <div className="p-8 text-center text-muted-foreground">
            Can&apos;t find that run
          </div>
        )}
      </div>
      <SecretDialog />
    </AppShell>
  );
}
