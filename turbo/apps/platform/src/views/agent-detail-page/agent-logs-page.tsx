import { useGet } from "ccstate-react";
import { AppShell } from "../layout/app-shell.tsx";
import {
  agentDetail$,
  agentDetailLoading$,
  agentName$,
} from "../../signals/agent-detail/agent-detail.ts";

export function AgentLogsPage() {
  const agentName = useGet(agentName$);
  const detail = useGet(agentDetail$);
  const loading = useGet(agentDetailLoading$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        agentName ?? "Loading...",
        "Logs",
      ]}
    >
      {loading ? (
        <div className="p-6 text-muted-foreground">Loading agent...</div>
      ) : detail ? (
        <div className="p-6">
          <h1 className="text-2xl font-bold">{detail.name} — Logs</h1>
          <p className="text-muted-foreground mt-1">
            Agent logs page — implementation coming in Phase 5
          </p>
        </div>
      ) : (
        <div className="p-6 text-muted-foreground">Agent not found</div>
      )}
    </AppShell>
  );
}
