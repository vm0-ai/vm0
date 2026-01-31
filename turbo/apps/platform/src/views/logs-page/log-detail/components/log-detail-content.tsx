import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconUser,
  IconClock,
  IconInfoCircle,
  IconChevronDown,
} from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger, Button } from "@vm0/ui";
import { logDetailSearchTerm$ } from "../../../../signals/logs-page/log-detail-state.ts";
import { getOrCreateLogDetail$ } from "../../../../signals/logs-page/logs-signals.ts";
import { StatusBadge } from "../../status-badge.tsx";
import { InfoRow } from "./info-row.tsx";
import { CopyField } from "./copy-field.tsx";
import { ArtifactDownloadButton } from "./artifact-download-button.tsx";
import { AgentEventsCard } from "./agent-events-card.tsx";
import { formatTime, formatDuration } from "../utils.ts";

export function LogDetailContent({ logId }: { logId: string }) {
  const getOrCreateLogDetail = useSet(getOrCreateLogDetail$);
  const searchTerm = useGet(logDetailSearchTerm$);
  const setSearchTerm = useSet(logDetailSearchTerm$);

  const detail$ = getOrCreateLogDetail(logId);
  const loadable = useLoadable(detail$);

  if (loadable.state === "loading") {
    return (
      <div className="p-8 text-center text-muted-foreground">Loading...</div>
    );
  }

  if (loadable.state === "hasError") {
    const errorMessage =
      loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load details";
    return (
      <div className="p-8 text-center text-destructive">
        Error: {errorMessage}
      </div>
    );
  }

  const detail = loadable.data;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Compact Header Bar */}
      <div className="shrink-0 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 bg-muted/30 rounded-lg border border-border">
        {/* Status */}
        <StatusBadge status={detail.status} />

        {/* Duration */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <IconClock className="h-4 w-4" />
          <span>{formatDuration(detail.startedAt, detail.completedAt)}</span>
        </div>

        {/* Agent */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <IconUser className="h-4 w-4" />
          <span>{detail.agentName}</span>
        </div>

        {/* Time */}
        <span className="text-sm text-muted-foreground">
          {formatTime(detail.createdAt)}
        </span>

        {/* Details Popover */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-muted-foreground hover:text-foreground"
            >
              <IconInfoCircle className="h-4 w-4 mr-1" />
              Details
              <IconChevronDown className="h-3 w-3 ml-1" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="bottom"
            collisionPadding={16}
            className="w-80 max-w-[calc(100vw-2rem)] p-4"
          >
            <div className="space-y-3 overflow-hidden">
              <InfoRow label="Run ID">
                <CopyField text={detail.id} />
              </InfoRow>
              <InfoRow label="Session ID">
                {detail.sessionId ? (
                  <CopyField text={detail.sessionId} />
                ) : (
                  <span className="text-sm text-muted-foreground">-</span>
                )}
              </InfoRow>
              <InfoRow label="Framework">
                <span className="text-sm text-foreground">
                  {detail.framework ?? (
                    <span className="text-muted-foreground">-</span>
                  )}
                </span>
              </InfoRow>
              <InfoRow label="Artifact">
                {detail.artifact.name && detail.artifact.version ? (
                  <ArtifactDownloadButton
                    name={detail.artifact.name}
                    version={detail.artifact.version}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">-</span>
                )}
              </InfoRow>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Error Banner */}
      {detail.error && (
        <div className="shrink-0 px-4 py-3 bg-destructive/10 rounded-lg border border-destructive/30">
          <span className="text-sm font-medium text-destructive">Error: </span>
          <span className="text-sm text-destructive">{detail.error}</span>
        </div>
      )}

      <AgentEventsCard
        logId={logId}
        framework={detail.framework}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
