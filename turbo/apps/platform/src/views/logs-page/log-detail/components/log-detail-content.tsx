import type { ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { CopyButton } from "@vm0/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@vm0/ui/components/ui/alert";
import { Button } from "@vm0/ui/components/ui/button";
import { AlertTriangle, Plus } from "lucide-react";
import { logDetailSearchTerm$ } from "../../../../signals/logs-page/log-detail-state.ts";
import { getOrCreateLogDetail$ } from "../../../../signals/logs-page/logs-signals.ts";
import { openAddSecretDialog$ } from "../../../../signals/settings-page/secrets.ts";
import { StatusBadge } from "../../status-badge.tsx";
import { ArtifactDownloadButton } from "./artifact-download-button.tsx";
import { AgentEventsCard } from "./agent-events-card.tsx";
import { LogDetailSkeleton } from "../log-detail-skeleton.tsx";
import { formatTime, formatTimeShort, formatDuration } from "../utils.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

/**
 * Parse missing secrets from error message
 * Example: "Missing required secrets: FAL_KEY, BRIGHTDATA_API_KEY. Use '--secrets FAL_KEY=<value>' or '--env-file <path>' to provide them."
 */
function parseMissingSecrets(errorMessage: string): string[] {
  const match = errorMessage.match(/Missing required secrets:\s*([^.]+)/i);
  if (!match) {
    return [];
  }

  const secretsStr = match[1];
  return secretsStr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function LogDetailContent({ logId }: { logId: string }) {
  const getOrCreateLogDetail = useSet(getOrCreateLogDetail$);
  const searchTerm = useGet(logDetailSearchTerm$);
  const setSearchTerm = useSet(logDetailSearchTerm$);
  const openAddDialog = useSet(openAddSecretDialog$);

  const detail$ = getOrCreateLogDetail(logId);
  const loadable = useLoadable(detail$);

  const handleAddSecret = (secretName: string) => {
    detach(openAddDialog(secretName), Reason.DomCallback);
  };

  if (loadable.state === "loading") {
    return <LogDetailSkeleton />;
  }

  if (loadable.state === "hasError") {
    const errorMessage =
      loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load details";
    return (
      <div className="p-4 sm:p-8">
        <div className="p-8 text-center text-destructive">
          Hmm, couldn&apos;t load that... {errorMessage}
        </div>
      </div>
    );
  }

  const detail = loadable.data;

  // Parse missing secrets from error message
  const missingSecrets = detail.error ? parseMissingSecrets(detail.error) : [];

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Info Card - Grid layout with dividers */}
      <div className="p-4 pb-0 sm:px-8 sm:pt-4 sm:pb-0">
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-y-2 text-sm px-2 sm:px-4 py-3 bg-card rounded-lg border border-border">
          <InfoItem label="Status" showDivider>
            <StatusBadge status={detail.status} />
          </InfoItem>

          <InfoItem label="Agent" showDivider>
            <span className="font-medium text-foreground truncate">
              {detail.agentName}
            </span>
          </InfoItem>

          <InfoItem label="Framework" showDivider>
            <span className="text-foreground truncate">
              {detail.framework || "-"}
            </span>
          </InfoItem>

          <InfoItem label="Duration" showDivider={false}>
            <span className="text-foreground whitespace-nowrap">
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
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Missing required secrets</AlertTitle>
            <AlertDescription>
              {missingSecrets.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span>
                    This agent requires {missingSecrets.length} secret
                    {missingSecrets.length > 1 ? "s" : ""} to run. Click to add:
                  </span>
                  {missingSecrets.map((secret) => (
                    <Button
                      key={secret}
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddSecret(secret)}
                      className="h-auto py-1.5 px-2.5 text-xs border-destructive text-destructive hover:bg-destructive/10"
                    >
                      <Plus className="h-3 w-3" />
                      <code className="font-mono">{secret}</code>
                    </Button>
                  ))}
                </div>
              ) : (
                <code className="text-sm whitespace-pre-wrap break-words">
                  {detail.error}
                </code>
              )}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {/* Prompt Section */}
      {detail.prompt.trim().length > 0 && (
        <div className="px-4 sm:px-8">
          <div className="shrink-0 px-4 py-3 bg-card rounded-lg border border-border">
            <span className="text-sm font-medium text-muted-foreground">
              Prompt
            </span>
            <p className="mt-1 text-sm text-foreground whitespace-pre-wrap break-words">
              {detail.prompt}
            </p>
          </div>
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
    <div className="flex items-center gap-2 px-2 sm:px-4 [&:nth-child(2n+1)]:pl-0 lg:[&:nth-child(2n+1)]:pl-4 lg:[&:nth-child(4n+1)]:pl-0 relative overflow-hidden [&:nth-child(2n)>.divider]:hidden lg:[&:nth-child(2n)>.divider]:block lg:[&:nth-child(4n)>.divider]:hidden">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center text-sm min-w-0 overflow-hidden">
        {children}
      </div>
      {showDivider && (
        <div className="divider absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border" />
      )}
    </div>
  );
}

function CopyableId({ label, value }: { label?: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
      {label && <span className="text-muted-foreground text-sm">{label}</span>}
      <code className="font-mono text-xs sm:text-sm text-foreground bg-gray-50 px-1.5 sm:px-3 py-1 rounded-lg inline-flex items-center gap-1 min-w-0">
        <span className="truncate">{value.slice(0, 8)}...</span>
        <CopyButton text={value} className="h-4 w-4 p-0 ml-0.5 shrink-0" />
      </code>
    </span>
  );
}
