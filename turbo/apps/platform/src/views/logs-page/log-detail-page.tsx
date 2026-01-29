import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconFolder,
  IconUser,
  IconChevronDown,
  IconCheck,
  IconAdjustmentsHorizontal,
} from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";
import { Card, CardContent, CopyButton, Input } from "@vm0/ui";
import {
  currentLogId$,
  logDetailSearchTerm$,
  viewMode$,
  hiddenEventTypes$,
  currentMatchIndex$,
  totalMatchCount$,
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
import { SearchNavigation } from "./components/search-navigation.tsx";
import { highlightText, countMatches } from "./utils/highlight-text.tsx";
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

/** View mode toggle button - Figma style with orange border for active */
function ViewModeToggle({
  mode,
  setMode,
}: {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-center">
      <button
        onClick={() => setMode("formatted")}
        className={`h-9 px-4 text-sm font-medium transition-colors rounded-l-lg ${
          mode === "formatted"
            ? "border border-sidebar-primary bg-accent text-sidebar-primary"
            : "border border-border border-r-0 bg-card text-foreground hover:bg-muted"
        }`}
      >
        Formatted
      </button>
      <button
        onClick={() => setMode("raw")}
        className={`h-9 px-4 text-sm font-medium transition-colors rounded-r-lg ${
          mode === "raw"
            ? "border border-sidebar-primary bg-accent text-sidebar-primary"
            : "border border-border border-l-0 bg-card text-foreground hover:bg-muted"
        }`}
      >
        Raw JSON
      </button>
    </div>
  );
}

/** Event type filter dropdown - Figma "All types" style using details/summary */
function EventTypeFilterDropdown({
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
  const visibleCount = allTypes.filter((type) => !hiddenTypes.has(type)).length;
  const isAllSelected = visibleCount === allTypes.length;

  const selectAll = () => {
    setHiddenTypes(new Set());
  };

  if (allTypes.length === 0) {
    return null;
  }

  return (
    <details className="relative group">
      <summary className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-md bg-card hover:bg-muted transition-colors cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <IconAdjustmentsHorizontal className="h-4 w-4 text-muted-foreground" />
        <span className="text-foreground">
          {isAllSelected ? "All types" : `${visibleCount} types`}
        </span>
        <IconChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>

      <div className="absolute top-full left-0 mt-1 w-48 bg-card border border-border rounded-md shadow-lg z-50">
        <div className="p-1">
          <button
            onClick={selectAll}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-muted transition-colors"
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center ${isAllSelected ? "bg-sidebar-primary border-sidebar-primary" : "border-border"}`}
            >
              {isAllSelected && <IconCheck className="h-3 w-3 text-white" />}
            </div>
            <span>All types</span>
          </button>
          <div className="h-px bg-border my-1" />
          {allTypes.map((type) => {
            const style = getEventStyle(type);
            const count = counts.get(type) ?? 0;
            const isVisible = !hiddenTypes.has(type);

            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-muted transition-colors"
              >
                <div
                  className={`w-4 h-4 rounded border flex items-center justify-center ${isVisible ? "bg-sidebar-primary border-sidebar-primary" : "border-border"}`}
                >
                  {isVisible && <IconCheck className="h-3 w-3 text-white" />}
                </div>
                <span>{style.label}</span>
                <span className="text-muted-foreground ml-auto">({count})</span>
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}

/** Scroll to element with data-match-index attribute within container only */
function scrollToMatch(container: HTMLElement | null, matchIndex: number) {
  if (!container || matchIndex < 0) {
    return;
  }
  const matchElement = container.querySelector(
    `[data-match-index="${matchIndex}"]`,
  );
  if (matchElement instanceof HTMLElement) {
    // Calculate scroll position to center the element within the container
    const containerRect = container.getBoundingClientRect();
    const elementRect = matchElement.getBoundingClientRect();
    const elementOffsetTop =
      elementRect.top - containerRect.top + container.scrollTop;
    const targetScrollTop =
      elementOffsetTop - container.clientHeight / 2 + elementRect.height / 2;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: "smooth",
    });
  }
}

const EVENTS_CONTAINER_ID = "events-scroll-container";

/** Raw JSON view with search highlighting */
function RawJsonView({
  events,
  searchTerm,
  currentMatchIndex,
  setTotalMatches,
}: {
  events: AgentEvent[];
  searchTerm: string;
  currentMatchIndex: number;
  setTotalMatches: (count: number) => void;
}) {
  const jsonString = JSON.stringify(events, null, 2);

  // Calculate matches and create highlighted content
  let element: React.ReactNode = jsonString;
  let matchCount = 0;

  if (searchTerm.trim()) {
    const result = highlightText(jsonString, {
      searchTerm,
      currentMatchIndex,
      matchStartIndex: 0,
    });
    element = result.element;
    matchCount = result.matchCount;
  }

  // Update total matches in parent via ref callback
  const containerRef = (node: HTMLPreElement | null) => {
    if (node) {
      setTotalMatches(matchCount);
    }
  };

  return (
    <div className="relative">
      <CopyButton
        text={jsonString}
        className="absolute top-2 right-2 h-8 w-8 bg-background/80 hover:bg-background z-10"
      />
      <pre
        id={EVENTS_CONTAINER_ID}
        ref={containerRef}
        className="font-mono text-sm whitespace-pre-wrap overflow-auto max-h-[600px] p-4 bg-muted/30 rounded-lg"
      >
        {element}
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
  currentMatchIndex,
  setTotalMatches,
}: {
  events: AgentEvent[];
  searchTerm: string;
  hiddenTypes: Set<string>;
  currentMatchIndex: number;
  setTotalMatches: (count: number) => void;
}) {
  const visibleEvents = events.filter(
    (event) =>
      !hiddenTypes.has(event.eventType) &&
      eventMatchesSearch(event, searchTerm),
  );

  // Calculate total matches across all visible events
  let totalMatches = 0;
  if (searchTerm.trim()) {
    for (const event of visibleEvents) {
      const dataStr = JSON.stringify(event.eventData);
      totalMatches += countMatches(dataStr, searchTerm);
    }
  }

  // Update total matches in parent via ref callback
  const containerRef = (node: HTMLDivElement | null) => {
    if (node) {
      setTotalMatches(totalMatches);
    }
  };

  if (visibleEvents.length === 0) {
    return (
      <div ref={containerRef} className="p-8 text-center text-muted-foreground">
        {events.length === 0
          ? "No events available"
          : searchTerm.trim()
            ? `No events matching "${searchTerm}"`
            : "All events are filtered out"}
      </div>
    );
  }

  // Calculate match start indices for each event
  let matchOffset = 0;

  return (
    <div
      id={EVENTS_CONTAINER_ID}
      ref={containerRef}
      className="space-y-3 max-h-[600px] overflow-y-auto pr-1"
    >
      {visibleEvents.map((event) => {
        const eventMatchStart = matchOffset;
        // Calculate matches for this event to update offset
        const eventDataStr = JSON.stringify(event.eventData);
        const eventMatches = searchTerm.trim()
          ? countMatches(eventDataStr, searchTerm)
          : 0;
        matchOffset += eventMatches;

        return (
          <EventCard
            key={`${event.sequenceNumber}-${event.createdAt}`}
            event={event}
            searchTerm={searchTerm}
            currentMatchIndex={currentMatchIndex}
            matchStartIndex={eventMatchStart}
          />
        );
      })}
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

  // Search navigation state
  const currentMatchIdx = useGet(currentMatchIndex$);
  const setCurrentMatchIdx = useSet(currentMatchIndex$);
  const totalMatches = useGet(totalMatchCount$);
  const setTotalMatches = useSet(totalMatchCount$);

  // Scroll to match by index (called after state update)
  const scrollToMatchByIndex = (matchIndex: number) => {
    const container = document.getElementById(EVENTS_CONTAINER_ID);
    scrollToMatch(container, matchIndex);
  };

  // Navigation handlers
  const handleNext = () => {
    if (totalMatches > 0) {
      const newIndex = (currentMatchIdx + 1) % totalMatches;
      setCurrentMatchIdx(newIndex);
      // Delay scroll to let React update the DOM
      Promise.resolve()
        .then(() => scrollToMatchByIndex(newIndex))
        .catch(() => {});
    }
  };

  const handlePrevious = () => {
    if (totalMatches > 0) {
      const newIndex =
        currentMatchIdx === 0 ? totalMatches - 1 : currentMatchIdx - 1;
      setCurrentMatchIdx(newIndex);
      // Delay scroll to let React update the DOM
      Promise.resolve()
        .then(() => scrollToMatchByIndex(newIndex))
        .catch(() => {});
    }
  };

  // Keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrevious();
      } else {
        handleNext();
      }
    }
  };

  // Reset match index on search term change
  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    setCurrentMatchIdx(0);
  };

  // Reset match index on view mode change
  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setCurrentMatchIdx(0);
  };

  if (eventsLoadable.state === "loading") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-foreground">
            Agent events
          </span>
        </div>
        <div className="p-8 text-center text-muted-foreground">
          Loading events...
        </div>
      </div>
    );
  }

  if (eventsLoadable.state === "hasError") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-foreground">
            Agent events
          </span>
        </div>
        <div className="p-8 text-center text-muted-foreground">
          Failed to load events
        </div>
      </div>
    );
  }

  const { events } = eventsLoadable.data;
  const eventTypeCounts = getEventTypeCounts(events);

  // Count matching events for search
  const matchingCount = searchTerm.trim()
    ? events.filter((e) => eventMatchesSearch(e, searchTerm)).length
    : events.length;

  return (
    <div className="space-y-4">
      {/* Toolbar - not a card, just a simple bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-foreground">
            Agent events
          </span>
          <span className="text-sm text-muted-foreground">
            {searchTerm.trim()
              ? `(${matchingCount}/${events.length} matched)`
              : `${events.length} total`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {viewMode === "formatted" && events.length > 0 && (
            <EventTypeFilterDropdown
              counts={eventTypeCounts}
              hiddenTypes={hiddenTypes}
              setHiddenTypes={setHiddenTypes}
            />
          )}
          <div className="relative flex h-9 items-center rounded-md border border-border bg-card">
            <div className="pl-2">
              <IconSearch className="h-4 w-4 text-muted-foreground" />
            </div>
            <Input
              placeholder="Search logs"
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-full w-44 border-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 pl-2 pr-20"
            />
            <SearchNavigation
              currentIndex={currentMatchIdx}
              totalCount={totalMatches}
              onNext={handleNext}
              onPrevious={handlePrevious}
              hasSearchTerm={searchTerm.trim().length > 0}
            />
          </div>
          <div className="h-5 w-px bg-border" />
          <ViewModeToggle mode={viewMode} setMode={handleViewModeChange} />
        </div>
      </div>

      {/* Events list */}
      {viewMode === "formatted" ? (
        <FormattedEventsView
          events={events}
          searchTerm={searchTerm}
          hiddenTypes={hiddenTypes}
          currentMatchIndex={currentMatchIdx}
          setTotalMatches={setTotalMatches}
        />
      ) : (
        <RawJsonView
          events={events}
          searchTerm={searchTerm}
          currentMatchIndex={currentMatchIdx}
          setTotalMatches={setTotalMatches}
        />
      )}
    </div>
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
