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
import {
  activeRunId$,
  isInlineRunInitializing$,
  isRunPanelVisible$,
} from "../../signals/agent-detail/inline-run.ts";
import { isChatPanelOpen$ } from "../../signals/agent-detail/chat.ts";
import { AgentHeader } from "./agent-header.tsx";
import { AgentInstructions } from "./agent-instructions.tsx";
import { InlineRunPanel } from "./inline-run-panel.tsx";
import { ChatPanel } from "./chat-panel.tsx";
import { ConfigDialog } from "./config-dialog/config-dialog.tsx";
import { RunDialog } from "./run-dialog/run-dialog.tsx";
import { ScheduleDialog } from "./schedule-dialog.tsx";

type RightPanelType = "none" | "run" | "chat";

function useActiveRightPanel(): RightPanelType {
  const runPanelVisible = useGet(isRunPanelVisible$);
  const chatOpen = useGet(isChatPanelOpen$);
  if (chatOpen) {
    return "chat";
  }
  if (runPanelVisible) {
    return "run";
  }
  return "none";
}

export function AgentDetailPage() {
  const agentName = useGet(agentName$);
  const detail = useGet(agentDetail$);
  const loading = useGet(agentDetailLoading$);
  const error = useGet(agentDetailError$);
  const isOwner = useGet(isOwner$);
  const instructions = useGet(agentInstructions$);
  const instructionsLoading = useGet(agentInstructionsLoading$);
  const activeRunId = useGet(activeRunId$);
  const runInitializing = useGet(isInlineRunInitializing$);
  const showSkeleton = loading || runInitializing;
  const rightPanel = useActiveRightPanel();

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        agentName ?? "Loading...",
      ]}
    >
      <div className="flex flex-col gap-4 md:gap-[22px] p-4 md:p-8 h-full">
        {showSkeleton ? (
          <AgentDetailSkeleton />
        ) : error ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : detail ? (
          <>
            <AgentHeader detail={detail} isOwner={isOwner} />
            {rightPanel !== "none" ? (
              <div className="flex md:flex-row gap-4 flex-1 min-h-0">
                {/* Mobile: hide instructions, show only active panel */}
                <div className="hidden md:block md:w-1/2 min-h-0">
                  <AgentInstructions
                    instructions={instructions}
                    loading={instructionsLoading}
                    isOwner={isOwner}
                  />
                </div>
                <div className="flex-1 md:w-1/2 min-h-0">
                  {rightPanel === "run" ? (
                    <InlineRunPanel runId={activeRunId} />
                  ) : (
                    <ChatPanel />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                <AgentInstructions
                  instructions={instructions}
                  loading={instructionsLoading}
                  isOwner={isOwner}
                />
              </div>
            )}
            <ConfigDialog />
            <RunDialog />
            <ScheduleDialog />
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
      <Skeleton className="h-64 rounded-lg" />
    </>
  );
}
