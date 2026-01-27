import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconFolder,
  IconCopy,
  IconCheck,
  IconList,
  IconRobot,
} from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";
import { Card, CardHeader, CardTitle, CardContent, Input } from "@vm0/ui";
import {
  currentLogId$,
  logDetailSearchTerm$,
} from "../../signals/logs-page/log-detail-page.ts";
import {
  getOrCreateLogDetail$,
  getOrCreateAgentEvents$,
  downloadArtifact$,
  artifactDownloadPromise$,
} from "../../signals/logs-page/logs-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { LogStatus, AgentEvent } from "../../signals/logs-page/types.ts";

function StatusBadge({ status }: { status: LogStatus }) {
  const statusConfig: Record<
    LogStatus,
    { label: string; className: string; icon?: boolean }
  > = {
    pending: { label: "Pending", className: "bg-yellow-100 text-yellow-800" },
    running: { label: "Running", className: "bg-blue-100 text-blue-800" },
    completed: {
      label: "Done",
      className: "border border-green-200 text-green-700",
      icon: true,
    },
    failed: { label: "Failed", className: "bg-red-100 text-red-800" },
    timeout: { label: "Timeout", className: "bg-orange-100 text-orange-800" },
    cancelled: { label: "Cancelled", className: "bg-gray-100 text-gray-800" },
  };

  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.className}`}
    >
      {config.icon && <IconCheck className="h-3 w-3" />}
      {config.label}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(text).catch(() => {
      // Silently ignore clipboard errors
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 hover:bg-muted rounded transition-colors"
      aria-label="Copy to clipboard"
    >
      <IconCopy className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 py-2">
      <span className="text-sm text-muted-foreground w-24 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

const ONE_MINUTE_MS = 60_000;

function formatDuration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt || !completedAt) {
    return "-";
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  const durationMs = end - start;

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < ONE_MINUTE_MS) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / ONE_MINUTE_MS);
  const seconds = Math.floor((durationMs % ONE_MINUTE_MS) / 1000);
  return `${minutes}m ${seconds}s`;
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function highlightText(text: string, term: string) {
  if (!term.trim()) {
    return text;
  }

  const parts = text.split(new RegExp(`(${escapeRegExp(term)})`, "gi"));

  return parts.map((part, idx) =>
    part.toLowerCase() === term.toLowerCase() ? (
      <mark
        key={`highlight-${part}-${idx}`}
        className="bg-yellow-200 text-yellow-900"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function ArtifactDownloadButton({ name }: { name: string }) {
  const download = useSet(downloadArtifact$);
  const downloadStatus = useLoadable(artifactDownloadPromise$);

  const isLoading = downloadStatus.state === "loading";

  const handleDownload = () => {
    detach(download({ name }), Reason.DomCallback);
  };

  return (
    <button
      onClick={handleDownload}
      disabled={isLoading}
      className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <IconFolder className="h-4 w-4 text-muted-foreground" />
      {name}
    </button>
  );
}

/**
 * Format events as log text similar to CLI output
 */
function formatEventsAsLogText(events: AgentEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    const timestamp = new Date(event.createdAt).toISOString();
    const eventData = event.eventData as Record<string, unknown>;

    if (event.eventType === "text") {
      const content = String(eventData.content ?? "");
      lines.push(`  [${timestamp}] [text] ${content}`);
    } else if (event.eventType === "tool_use") {
      const toolName = String(eventData.name ?? eventData.tool ?? "unknown");
      lines.push(`  [${timestamp}] [tool_use] ${toolName}`);
      // Format tool input if present
      if (eventData.input) {
        const inputStr = JSON.stringify(eventData.input, null, 2);
        const indentedInput = inputStr
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n");
        lines.push(indentedInput);
      }
    } else if (event.eventType === "tool_result") {
      lines.push(`  [${timestamp}] [tool_result]`);
      if (eventData.content) {
        const content = String(eventData.content);
        const indentedContent = content
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n");
        lines.push(indentedContent);
      }
    } else if (event.eventType === "thinking") {
      const content = String(eventData.content ?? "");
      lines.push(`  [${timestamp}] [thinking] ${content}`);
    } else if (event.eventType === "init") {
      lines.push(`  [${timestamp}] [init] Starting Claude Code agent`);
      if (eventData.session) {
        lines.push(`\n      Session: ${eventData.session}`);
      }
      if (eventData.model) {
        lines.push(`      Model: ${eventData.model}`);
      }
      if (eventData.tools && Array.isArray(eventData.tools)) {
        const toolsList = (eventData.tools as string[]).join(", ");
        lines.push(`      Tools: ${toolsList}`);
      }
    } else {
      // Generic format for other event types
      lines.push(`  [${timestamp}] [${event.eventType}]`);
      const dataStr = JSON.stringify(eventData, null, 2);
      const indentedData = dataStr
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n");
      lines.push(indentedData);
    }

    lines.push(""); // Empty line between events
  }

  return lines.join("\n");
}

function AgentEventsCard({
  logId,
  searchTerm,
  setSearchTerm,
}: {
  logId: string;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
}) {
  const getOrCreateAgentEvents = useSet(getOrCreateAgentEvents$);
  const events$ = getOrCreateAgentEvents(logId);
  const eventsLoadable = useLoadable(events$);

  if (eventsLoadable.state === "loading") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Raw Data</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="p-8 text-center text-muted-foreground">
            Loading events...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (eventsLoadable.state === "hasError") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Raw Data</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="p-8 text-center text-muted-foreground">
            Failed to load events
          </div>
        </CardContent>
      </Card>
    );
  }

  const { events } = eventsLoadable.data;

  // Format events as log text
  const logText = formatEventsAsLogText(events);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconList className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base font-medium">
              Log raw data
            </CardTitle>
          </div>
          <div className="relative w-48">
            <Input
              placeholder="Search logs"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 pr-8 text-sm"
            />
            <IconSearch className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            No events available
          </div>
        ) : (
          <pre className="font-mono text-sm whitespace-pre-wrap overflow-auto max-h-[600px] leading-relaxed">
            {searchTerm ? highlightText(logText, searchTerm) : logText}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function LogDetailContentInner({ logId }: { logId: string }) {
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
    <div className="space-y-6">
      {/* Run Details Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12">
            {/* Left column */}
            <div className="divide-y divide-border">
              <InfoRow label="Run ID">
                <span className="font-mono text-sm truncate">{detail.id}</span>
                <CopyButton text={detail.id} />
              </InfoRow>
              <InfoRow label="Session ID">
                {detail.sessionId ? (
                  <>
                    <span className="font-mono text-sm truncate">
                      {detail.sessionId}
                    </span>
                    <CopyButton text={detail.sessionId} />
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">-</span>
                )}
              </InfoRow>
              <InfoRow label="Status">
                <StatusBadge status={detail.status} />
              </InfoRow>
              <InfoRow label="Duration">
                <span className="text-sm">
                  {formatDuration(detail.startedAt, detail.completedAt)}
                </span>
              </InfoRow>
            </div>
            {/* Right column */}
            <div className="divide-y divide-border">
              <InfoRow label="Agent">
                <IconRobot className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{detail.agentName}</span>
              </InfoRow>
              <InfoRow label="Model">
                <span className="text-sm">
                  {detail.provider ?? (
                    <span className="text-muted-foreground">-</span>
                  )}
                </span>
              </InfoRow>
              <InfoRow label="Time">
                <span className="text-sm">
                  {new Date(detail.createdAt).toLocaleString()}
                </span>
              </InfoRow>
              <InfoRow label="Artifact">
                {detail.artifact.name ? (
                  <ArtifactDownloadButton name={detail.artifact.name} />
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

      {/* Agent Events Card */}
      <AgentEventsCard
        logId={logId}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
      />
    </div>
  );
}

export function LogDetailPage() {
  const logId = useGet(currentLogId$);

  const breadcrumb = [
    { label: "Logs", path: "/logs" as const },
    { label: logId ? `Run ID - ${logId}` : "Detail" },
  ];

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="px-8 py-6">
        {logId ? (
          <LogDetailContentInner logId={logId} />
        ) : (
          <div className="p-8 text-center text-muted-foreground">
            Log ID not found
          </div>
        )}
      </div>
    </AppShell>
  );
}
