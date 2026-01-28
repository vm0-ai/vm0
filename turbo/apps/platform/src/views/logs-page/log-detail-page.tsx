import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconFolder,
  IconList,
  IconRobot,
  IconCode,
  IconLayoutList,
} from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";
import { Card, CardContent, CopyButton, Input } from "@vm0/ui";
import {
  currentLogId$,
  logDetailSearchTerm$,
  viewMode$,
  hiddenEventTypes$,
  type ViewMode,
} from "../../signals/logs-page/log-detail-state.ts";
import {
  getOrCreateLogDetail$,
  getOrCreateAgentEvents$,
  downloadArtifact$,
  artifactDownloadPromise$,
} from "../../signals/logs-page/logs-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { AgentEvent } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "./status-badge.tsx";
import { EventCard } from "./components/event-card.tsx";
import { getEventStyle, KNOWN_EVENT_TYPES } from "./constants/event-styles.ts";

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 py-3">
      <span className="text-sm text-muted-foreground w-24 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "shortOffset",
  };
  return date.toLocaleString("en-US", options);
}

function CopyField({ text }: { text: string }) {
  return (
    <div className="flex h-9 w-60 items-center gap-2 rounded-md bg-muted px-3">
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-foreground">
        {text}
      </span>
      <CopyButton text={text} className="h-4 w-4 shrink-0 p-0" />
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

function ArtifactDownloadButton({
  name,
  version,
}: {
  name: string;
  version: string;
}) {
  const download = useSet(downloadArtifact$);
  const downloadStatus = useLoadable(artifactDownloadPromise$);

  const isLoading = downloadStatus.state === "loading";
  const hasError = downloadStatus.state === "hasError";
  const errorMessage =
    hasError && downloadStatus.error instanceof Error
      ? downloadStatus.error.message
      : hasError
        ? "Download failed"
        : null;

  const handleDownload = () => {
    detach(download({ name, version: version }), Reason.DomCallback);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleDownload}
        disabled={isLoading}
        className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <IconFolder className="h-4 w-4 text-muted-foreground" />
        My artifact folders
      </button>
      {errorMessage && (
        <span className="text-xs text-destructive">{errorMessage}</span>
      )}
    </div>
  );
}

/** Compute event type counts from events array */
function getEventTypeCounts(events: AgentEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const type = event.eventType;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/** View mode toggle button */
function ViewModeToggle({
  mode,
  setMode,
}: {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border bg-background">
      <button
        onClick={() => setMode("formatted")}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-l-md transition-colors ${
          mode === "formatted"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <IconLayoutList className="h-4 w-4" />
        Formatted
      </button>
      <button
        onClick={() => setMode("raw")}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-r-md transition-colors ${
          mode === "raw"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <IconCode className="h-4 w-4" />
        Raw JSON
      </button>
    </div>
  );
}

/** Event type filter buttons */
function EventTypeFilters({
  counts,
  hiddenTypes,
  setHiddenTypes,
}: {
  counts: Map<string, number>;
  hiddenTypes: Set<string>;
  setHiddenTypes: (types: Set<string>) => void;
}) {
  const toggleType = (type: string) => {
    const newHidden = new Set(hiddenTypes);
    if (newHidden.has(type)) {
      newHidden.delete(type);
    } else {
      newHidden.add(type);
    }
    setHiddenTypes(newHidden);
  };

  // Get all types that exist in events
  const existingTypes = KNOWN_EVENT_TYPES.filter(
    (type) => (counts.get(type) ?? 0) > 0,
  );

  // Also include any unknown types
  const unknownTypes = Array.from(counts.keys()).filter(
    (type) =>
      !KNOWN_EVENT_TYPES.includes(type as (typeof KNOWN_EVENT_TYPES)[number]),
  );

  const allTypes = [...existingTypes, ...unknownTypes];

  if (allTypes.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {allTypes.map((type) => {
        const style = getEventStyle(type);
        const Icon = style.icon;
        const count = counts.get(type) ?? 0;
        const isHidden = hiddenTypes.has(type);

        return (
          <button
            key={type}
            onClick={() => toggleType(type)}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-full border transition-colors ${
              isHidden
                ? "border-border text-muted-foreground opacity-50"
                : `${style.badgeColor} border-transparent`
            }`}
          >
            <Icon className="h-3 w-3" />
            <span>{style.label}</span>
            <span className="opacity-70">({count})</span>
          </button>
        );
      })}
    </div>
  );
}

/** Raw JSON view with syntax highlighting */
function RawJsonView({ events }: { events: AgentEvent[] }) {
  const jsonString = JSON.stringify(events, null, 2);

  return (
    <div className="relative">
      <CopyButton
        text={jsonString}
        className="absolute top-2 right-2 h-8 w-8 bg-background/80 hover:bg-background"
      />
      <pre className="font-mono text-sm whitespace-pre-wrap overflow-auto max-h-[600px] p-4 bg-muted/30 rounded-lg">
        {jsonString}
      </pre>
    </div>
  );
}

/** Check if event contains the search term */
function eventMatchesSearch(event: AgentEvent, searchTerm: string): boolean {
  if (!searchTerm.trim()) {
    return true;
  }
  const lowerSearch = searchTerm.toLowerCase();
  // Search in eventType
  if (event.eventType.toLowerCase().includes(lowerSearch)) {
    return true;
  }
  // Search in eventData (serialized to JSON)
  const dataStr = JSON.stringify(event.eventData).toLowerCase();
  return dataStr.includes(lowerSearch);
}

/** Formatted event cards view */
function FormattedEventsView({
  events,
  searchTerm,
  hiddenTypes,
}: {
  events: AgentEvent[];
  searchTerm: string;
  hiddenTypes: Set<string>;
}) {
  const visibleEvents = events.filter(
    (event) =>
      !hiddenTypes.has(event.eventType) &&
      eventMatchesSearch(event, searchTerm),
  );

  if (visibleEvents.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        {events.length === 0
          ? "No events available"
          : searchTerm.trim()
            ? `No events matching "${searchTerm}"`
            : "All events are filtered out"}
      </div>
    );
  }

  return (
    <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
      {visibleEvents.map((event) => (
        <EventCard
          key={`${event.sequenceNumber}-${event.createdAt}`}
          event={event}
          searchTerm={searchTerm}
        />
      ))}
    </div>
  );
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

  const viewMode = useGet(viewMode$);
  const setViewMode = useSet(viewMode$);
  const hiddenTypes = useGet(hiddenEventTypes$);
  const setHiddenTypes = useSet(hiddenEventTypes$);

  // Common header for loading/error states
  const renderHeader = (showControls = false) => (
    <div className="flex flex-col gap-3 rounded-t-lg border-b border-border bg-muted px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IconList className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium text-card-foreground">
            Agent Events
          </span>
        </div>
        {showControls && (
          <div className="flex items-center gap-3">
            <ViewModeToggle mode={viewMode} setMode={setViewMode} />
            <div className="flex h-9 items-center rounded-md border border-border bg-background">
              <Input
                placeholder="Search logs"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-full w-48 border-0 text-sm focus-visible:ring-0"
              />
              <div className="flex h-9 w-9 items-center justify-center border-l border-border">
                <IconSearch className="h-5 w-5 text-muted-foreground" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (eventsLoadable.state === "loading") {
    return (
      <Card className="overflow-hidden">
        {renderHeader()}
        <CardContent className="p-4">
          <div className="p-8 text-center text-muted-foreground">
            Loading events...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (eventsLoadable.state === "hasError") {
    return (
      <Card className="overflow-hidden">
        {renderHeader()}
        <CardContent className="p-4">
          <div className="p-8 text-center text-muted-foreground">
            Failed to load events
          </div>
        </CardContent>
      </Card>
    );
  }

  const { events } = eventsLoadable.data;
  const eventTypeCounts = getEventTypeCounts(events);

  // Count matching events for search
  const matchingCount = searchTerm.trim()
    ? events.filter((e) => eventMatchesSearch(e, searchTerm)).length
    : events.length;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 rounded-t-lg border-b border-border bg-muted px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconList className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium text-card-foreground">
              Agent Events
            </span>
            <span className="text-xs text-muted-foreground">
              {searchTerm.trim()
                ? `(${matchingCount}/${events.length} matched)`
                : `(${events.length} total)`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ViewModeToggle mode={viewMode} setMode={setViewMode} />
            <div className="flex h-9 items-center rounded-md border border-border bg-background">
              <Input
                placeholder="Search logs"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-full w-48 border-0 text-sm focus-visible:ring-0"
              />
              <div className="flex h-9 w-9 items-center justify-center border-l border-border">
                <IconSearch className="h-5 w-5 text-muted-foreground" />
              </div>
            </div>
          </div>
        </div>
        {viewMode === "formatted" && events.length > 0 && (
          <EventTypeFilters
            counts={eventTypeCounts}
            hiddenTypes={hiddenTypes}
            setHiddenTypes={setHiddenTypes}
          />
        )}
      </div>
      <CardContent className="p-4">
        {viewMode === "formatted" ? (
          <FormattedEventsView
            events={events}
            searchTerm={searchTerm}
            hiddenTypes={hiddenTypes}
          />
        ) : (
          <RawJsonView events={events} />
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
        <CardContent className="py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16">
            {/* Left column */}
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
            {/* Right column */}
            <div>
              <InfoRow label="Agent">
                <IconRobot className="h-4 w-4 text-muted-foreground" />
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
                <span className="text-sm text-muted-foreground">
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
      <div className="px-6 py-4">
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
