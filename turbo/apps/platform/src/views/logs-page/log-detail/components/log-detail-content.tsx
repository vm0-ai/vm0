import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconClock } from "@tabler/icons-react";
import { CopyButton } from "@vm0/ui";
import { logDetailSearchTerm$ } from "../../../../signals/logs-page/log-detail-state.ts";
import { getOrCreateLogDetail$ } from "../../../../signals/logs-page/logs-signals.ts";
import { StatusBadge } from "../../status-badge.tsx";
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
      {/* Info Card */}
      <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm px-4 py-3 bg-muted/30 rounded-lg border border-border">
        <StatusBadge status={detail.status} />

        <span className="font-medium text-foreground">{detail.agentName}</span>

        {detail.framework && (
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {detail.framework}
          </span>
        )}

        <Separator />

        <span className="flex items-center gap-1 text-muted-foreground">
          <IconClock className="h-3.5 w-3.5" />
          {formatDuration(detail.startedAt, detail.completedAt)}
        </span>

        <span className="text-muted-foreground">
          {formatTime(detail.createdAt)}
        </span>

        <Separator />

        <CopyableId label="Run" value={detail.id} />

        {detail.sessionId && (
          <CopyableId label="Session" value={detail.sessionId} />
        )}

        {detail.artifact.name && detail.artifact.version && (
          <>
            <Separator />
            <ArtifactDownloadButton
              name={detail.artifact.name}
              version={detail.artifact.version}
            />
          </>
        )}
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

function Separator() {
  return <span className="text-border">|</span>;
}

function CopyableId({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span>{label}:</span>
      <span className="font-mono text-xs">{value.slice(0, 8)}</span>
      <CopyButton text={value} className="h-4 w-4 p-0" />
    </span>
  );
}
