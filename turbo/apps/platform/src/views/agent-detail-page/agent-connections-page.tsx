import { useGet } from "ccstate-react";
import { AppShell } from "../layout/app-shell.tsx";
import {
  agentDetail$,
  agentDetailLoading$,
  agentName$,
} from "../../signals/agent-detail/agent-detail.ts";

export function AgentConnectionsPage() {
  const agentName = useGet(agentName$);
  const detail = useGet(agentDetail$);
  const loading = useGet(agentDetailLoading$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        agentName ?? "Loading...",
        "Connections",
      ]}
    >
      {loading ? (
        <div className="p-6 text-muted-foreground">Loading agent...</div>
      ) : detail ? (
        <div className="p-6">
          <h1 className="text-2xl font-bold">{detail.name} — Connections</h1>
          <p className="text-muted-foreground mt-1">
            Agent connections page — implementation coming in Phase 5
          </p>
        </div>
      ) : (
        <div className="p-6 text-muted-foreground">Agent not found</div>
      )}
    </AppShell>
  );
}
