import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconUser } from "@tabler/icons-react";
import { Card, CardContent } from "@vm0/ui";
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
    <div className="flex flex-col gap-6 h-full min-h-0">
      <Card className="shrink-0">
        <CardContent className="py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16">
            <div>
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
              <InfoRow label="Status">
                <StatusBadge status={detail.status} />
              </InfoRow>
              <InfoRow label="Duration">
                <span className="text-sm text-foreground">
                  {formatDuration(detail.startedAt, detail.completedAt)}
                </span>
              </InfoRow>
            </div>
            <div>
              <InfoRow label="Agent">
                <IconUser className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-foreground">
                  {detail.agentName}
                </span>
              </InfoRow>
              <InfoRow label="Framework">
                <span className="text-sm text-foreground">
                  {detail.framework ?? (
                    <span className="text-muted-foreground">-</span>
                  )}
                </span>
              </InfoRow>
              <InfoRow label="Time">
                <span className="text-sm text-foreground">
                  {formatTime(detail.createdAt)}
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
          </div>
          {detail.error && (
            <div className="mt-6 p-3 bg-destructive/10 rounded-md">
              <span className="text-sm font-medium text-destructive">
                Error:
              </span>
              <p className="text-sm text-destructive mt-1">{detail.error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <AgentEventsCard
        logId={logId}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
