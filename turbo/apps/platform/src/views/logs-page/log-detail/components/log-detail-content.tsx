import type { ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { CopyButton } from "@vm0/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { logDetailSearchTerm$ } from "../../../../signals/logs-page/log-detail-state.ts";
import { getOrCreateLogDetail$ } from "../../../../signals/logs-page/logs-signals.ts";
import { StatusBadge } from "../../status-badge.tsx";
import { ArtifactDownloadButton } from "./artifact-download-button.tsx";
import { AgentEventsCard } from "./agent-events-card.tsx";
import { formatTime, formatTimeShort, formatDuration } from "../utils.ts";

export function LogDetailContent({ logId }: { logId: string }) {
  const getOrCreateLogDetail = useSet(getOrCreateLogDetail$);
  const searchTerm = useGet(logDetailSearchTerm$);
  const setSearchTerm = useSet(logDetailSearchTerm$);

  const detail$ = getOrCreateLogDetail(logId);
  const loadable = useLoadable(detail$);

  if (loadable.state === "loading") {
    return (
      <div className="p-4 sm:p-8">
        <div className="p-8 text-center text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (loadable.state === "hasError") {
    const errorMessage =
      loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load details";
    return (
      <div className="p-4 sm:p-8">
        <div className="p-8 text-center text-destructive">
          Error: {errorMessage}
        </div>
      </div>
    );
  }

  const detail = loadable.data;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Info Card - Grid layout similar to table card */}
      <div className="p-4 pb-0 sm:px-8 sm:pt-4 sm:pb-0">
        <div className="shrink-0 grid grid-cols-2 md:grid-cols-4 gap-y-3 text-sm px-4 py-3 bg-card rounded-lg border border-border">
          <InfoItem label="Status" showDivider>
            <StatusBadge status={detail.status} />
          </InfoItem>

          <InfoItem label="Agent" showDivider>
            <span className="font-medium text-foreground">
              {detail.agentName}
            </span>
          </InfoItem>

          <InfoItem label="Framework" showDivider>
            <span className="text-foreground">{detail.framework || "-"}</span>
          </InfoItem>

          <InfoItem label="Duration" showDivider={false}>
            <span className="text-foreground">
              {formatDuration(detail.startedAt, detail.completedAt)}
            </span>
          </InfoItem>

          <InfoItem label="Time" showDivider>
            <span className="text-foreground whitespace-nowrap">
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">
                      {formatTimeShort(detail.createdAt)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">{formatTime(detail.createdAt)}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          </InfoItem>

          <InfoItem label="Session ID" showDivider>
            <CopyableId value={detail.sessionId || detail.id} />
          </InfoItem>

          <InfoItem label="Run ID" showDivider>
            <CopyableId value={detail.id} />
          </InfoItem>

          <InfoItem label="Artifacts" showDivider={false}>
            {detail.artifact.name && detail.artifact.version ? (
              <ArtifactDownloadButton
                name={detail.artifact.name}
                version={detail.artifact.version}
              />
            ) : (
              <span className="text-foreground">-</span>
            )}
          </InfoItem>
        </div>
      </div>

      {/* Error Banner */}
      {detail.error && (
        <div className="px-4 sm:px-8">
          <div className="shrink-0 px-4 py-3 bg-destructive/10 rounded-lg border border-destructive/30">
            <span className="text-sm font-medium text-destructive">
              Error:{" "}
            </span>
            <span className="text-sm text-destructive">{detail.error}</span>
          </div>
        </div>
      )}

      <AgentEventsCard
        logId={logId}
        framework={detail.framework}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
      />
    </div>
  );
}

function InfoItem({
  label,
  children,
  showDivider = true,
}: {
  label: string;
  children: ReactNode;
  showDivider?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-4 [&:nth-child(4n+1)]:pl-0 relative">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center text-sm min-w-0">{children}</div>
      {showDivider && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border" />
      )}
    </div>
  );
}

function CopyableId({ label, value }: { label?: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="text-muted-foreground text-sm">{label}</span>}
      <code className="font-mono text-sm text-foreground bg-gray-50 px-3 py-1 rounded-lg inline-flex items-center gap-1">
        {value.slice(0, 8)}...
        <CopyButton text={value} className="h-4 w-4 p-0 ml-0.5" />
      </code>
    </span>
  );
}
