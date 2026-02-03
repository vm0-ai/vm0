import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconSearch, IconLoader2 } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
import {
  viewMode$,
  currentMatchIndex$,
  totalMatchCount$,
  type ViewMode,
} from "../../../../signals/logs-page/log-detail-state.ts";
import {
  getOrCreateAgentEvents$,
  loadMoreAgentEvents$,
  agentEventsAccumulated$,
  agentEventsHasMore$,
  agentEventsIsLoadingMore$,
  initAccumulatedEvents$,
} from "../../../../signals/logs-page/logs-signals.ts";
import { SearchNavigation } from "../../components/search-navigation.tsx";
import { ViewModeToggle } from "./view-mode-toggle.tsx";
import { RawJsonView } from "./raw-json-view.tsx";
import { FormattedEventsView } from "./formatted-events-view.tsx";
import {
  eventMatchesSearch,
  scrollToMatch,
  EVENTS_CONTAINER_ID,
} from "../utils.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function AgentEventsCard({
  logId,
  framework,
  searchTerm,
  setSearchTerm,
  className,
}: {
  logId: string;
  framework: string | null;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  className?: string;
}) {
  const isCodex = framework === "codex";
  const getOrCreateAgentEvents = useSet(getOrCreateAgentEvents$);
  const loadMoreAgentEvents = useSet(loadMoreAgentEvents$);
  const initAccumulatedEvents = useSet(initAccumulatedEvents$);
  const events$ = getOrCreateAgentEvents(logId);
  const eventsLoadable = useLoadable(events$);

  // Get accumulated events state
  const accumulatedEvents = useGet(agentEventsAccumulated$);
  const hasMore = useGet(agentEventsHasMore$);
  const isLoadingMore = useGet(agentEventsIsLoadingMore$);

  const viewMode = useGet(viewMode$);
  const setViewMode = useSet(viewMode$);

  const currentMatchIdx = useGet(currentMatchIndex$);
  const setCurrentMatchIdx = useSet(currentMatchIndex$);
  const totalMatches = useGet(totalMatchCount$);
  const setTotalMatches = useSet(totalMatchCount$);

  // Initialize accumulated events when initial data loads
  // This is safe to call during render as initAccumulatedEvents$ is idempotent
  if (
    eventsLoadable.state === "hasData" &&
    accumulatedEvents.length === 0 &&
    eventsLoadable.data.events.length > 0
  ) {
    initAccumulatedEvents({
      events: eventsLoadable.data.events,
      hasMore: eventsLoadable.data.hasMore,
    });
  }

  const scrollToMatchByIndex = (matchIndex: number) => {
    const container = document.getElementById(EVENTS_CONTAINER_ID);
    scrollToMatch(container, matchIndex);
  };

  const handleNext = () => {
    if (totalMatches > 0) {
      const newIndex = (currentMatchIdx + 1) % totalMatches;
      setCurrentMatchIdx(newIndex);
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
      Promise.resolve()
        .then(() => scrollToMatchByIndex(newIndex))
        .catch(() => {});
    }
  };

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

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    setCurrentMatchIdx(0);
  };

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setCurrentMatchIdx(0);
  };

  // Ref callback for infinite scroll sentinel with cleanup (React 19 feature)
  // Uses key={events.length} to ensure fresh closure values after each load
  const sentinelRef = (node: HTMLDivElement | null): (() => void) | void => {
    if (!node) {
      return;
    }

    // Create observer with current closure values
    // The key-based remount ensures we always have fresh values
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore) {
          if (accumulatedEvents.length > 0) {
            const lastEvent = accumulatedEvents[accumulatedEvents.length - 1];
            detach(
              loadMoreAgentEvents({
                runId: logId,
                since: lastEvent.createdAt,
              }),
              Reason.DomCallback,
            );
          }
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(node);

    // Return cleanup function - called when element is unmounted (React 19)
    return () => {
      observer.disconnect();
    };
  };

  if (eventsLoadable.state === "loading") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-foreground">
            Agent events
          </span>
        </div>
        <div className="flex items-center justify-center p-8">
          <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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

  // Use accumulated events for rendering (or initial if not yet accumulated)
  const events =
    accumulatedEvents.length > 0
      ? accumulatedEvents
      : eventsLoadable.data.events;
  const showHasMore =
    accumulatedEvents.length > 0 ? hasMore : eventsLoadable.data.hasMore;

  const matchingCount = searchTerm.trim()
    ? events.filter((e) => eventMatchesSearch(e, searchTerm)).length
    : events.length;

  const totalCountDisplay = showHasMore
    ? `${events.length}+`
    : `${events.length}`;

  return (
    <div className={`flex flex-col gap-4 ${className ?? ""}`}>
      <div className="px-4 sm:px-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-base font-medium text-foreground whitespace-nowrap">
              Agent events
            </span>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {searchTerm.trim()
                ? `(${matchingCount}/${events.length} matched)`
                : `${totalCountDisplay} total`}
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="relative flex h-9 flex-1 sm:flex-none items-center rounded-md border border-border bg-card focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
              <div className="pl-2">
                <IconSearch className="h-4 w-4 text-muted-foreground" />
              </div>
              <Input
                placeholder="Search logs"
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-full w-full sm:w-44 border-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 pl-2 pr-20"
              />
              <SearchNavigation
                currentIndex={currentMatchIdx}
                totalCount={totalMatches}
                onNext={handleNext}
                onPrevious={handlePrevious}
                hasSearchTerm={searchTerm.trim().length > 0}
              />
            </div>
            {!isCodex && (
              <>
                <div className="h-5 w-px bg-border hidden sm:block" />
                <ViewModeToggle
                  mode={viewMode}
                  setMode={handleViewModeChange}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div
        id={EVENTS_CONTAINER_ID}
        className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 sm:px-8 sm:pb-8"
        style={{ scrollbarGutter: "stable" }}
      >
        {!isCodex && viewMode === "formatted" ? (
          <FormattedEventsView
            events={events}
            searchTerm={searchTerm}
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
        {showHasMore && (
          <div
            key={`sentinel-${events.length}`}
            ref={sentinelRef}
            className="flex items-center justify-center py-4"
          >
            <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}
