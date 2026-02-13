import { useGet } from "ccstate-react";
import { AppShell } from "../layout/app-shell.tsx";
import {
  agentDetail$,
  agentDetailError$,
  agentDetailLoading$,
  agentInstructions$,
  agentInstructionsLoading$,
  agentName$,
  isOwner$,
} from "../../signals/agent-detail/agent-detail.ts";

export function AgentDetailPage() {
  const agentName = useGet(agentName$);
  const detail = useGet(agentDetail$);
  const loading = useGet(agentDetailLoading$);
  const error = useGet(agentDetailError$);
  const isOwner = useGet(isOwner$);
  const instructions = useGet(agentInstructions$);
  const instructionsLoading = useGet(agentInstructionsLoading$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        agentName ?? "Loading...",
      ]}
    >
      {loading ? (
        <div className="p-6 text-muted-foreground">Loading agent...</div>
      ) : error ? (
        <div className="p-6 text-destructive">{error}</div>
      ) : detail ? (
        <div className="p-6 space-y-4">
          <div>
            <h1 className="text-2xl font-bold">{detail.name}</h1>
            <p className="text-sm text-muted-foreground">
              {isOwner ? "Owner" : "Shared with you"}
            </p>
          </div>
          {isOwner && (
            <div>
              <h2 className="text-lg font-semibold">Instructions</h2>
              {instructionsLoading ? (
                <p className="text-muted-foreground">Loading instructions...</p>
              ) : instructions?.content ? (
                <pre className="mt-2 rounded bg-muted p-4 text-sm whitespace-pre-wrap">
                  {instructions.content}
                </pre>
              ) : (
                <p className="text-muted-foreground">No instructions</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="p-6 text-muted-foreground">Agent not found</div>
      )}
    </AppShell>
  );
}
