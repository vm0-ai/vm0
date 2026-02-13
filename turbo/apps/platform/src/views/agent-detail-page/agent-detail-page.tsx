import { useGet } from "ccstate-react";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
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
import { AgentHeader } from "./agent-header.tsx";
import { AgentInstructions } from "./agent-instructions.tsx";

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
      <div className="flex flex-col gap-[22px] p-8 min-h-full">
        {loading ? (
          <AgentDetailSkeleton />
        ) : error ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : detail ? (
          <>
            <AgentHeader detail={detail} isOwner={isOwner} />
            <AgentInstructions
              instructions={instructions}
              loading={instructionsLoading}
            />
          </>
        ) : (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">Agent not found</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function AgentDetailSkeleton() {
  return (
    <>
      <div className="flex items-center gap-3.5">
        <Skeleton className="h-14 w-14 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-16 rounded-lg" />
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-9 w-9 rounded-lg" />
        </div>
      </div>
      <Skeleton className="flex-1 rounded-lg" />
    </>
  );
}
