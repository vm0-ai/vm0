import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconSearch, IconLoader2 } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
import {
  viewMode$,
  currentMatchIndex$,
  totalMatchCount$,
  type ViewMode,
} from "../../../../signals/logs-page/log-detail-state.ts";
import { runEvents$ } from "../../../../signals/logs-page/log-detail-signals.ts";
import { SearchNavigation } from "../../components/search-navigation.tsx";
import { ViewModeToggle } from "./view-mode-toggle.tsx";
import { RawJsonView } from "./raw-json-view.tsx";
import { FormattedEventsView } from "./formatted-events-view.tsx";
import {
  eventMatchesSearch,
  scrollToMatch,
  EVENTS_CONTAINER_ID,
} from "../utils.ts";

export function AgentEventsCard({
  framework,
  searchTerm,
  setSearchTerm,
  className,
}: {
  framework: string | null;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  className?: string;
}) {
  const eventsLoadable = useLoadable(runEvents$);

  const viewMode = useGet(viewMode$);
  const setViewMode = useSet(viewMode$);

  const currentMatchIdx = useGet(currentMatchIndex$);
  const setCurrentMatchIdx = useSet(currentMatchIndex$);
  const totalMatches = useGet(totalMatchCount$);
  const setTotalMatches = useSet(totalMatchCount$);

  const isCodex = framework === "codex";

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

  if (eventsLoadable.state === "loading") {
    return (
      <div
        className={`flex items-center justify-center p-8 ${className ?? ""}`}
      >
        <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (eventsLoadable.state === "hasError") {
    return (
      <div className={`space-y-4 px-4 sm:px-8 ${className ?? ""}`}>
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

  const events = eventsLoadable.data;

  const matchingCount = searchTerm.trim()
    ? events.filter((e) => eventMatchesSearch(e, searchTerm)).length
    : events.length;

  const totalCountDisplay = `${events.length}`;

  return (
    <div className={`flex flex-col gap-4 ${className ?? ""}`}>
      <div
        id={EVENTS_CONTAINER_ID}
        className="px-4 sm:px-8 pt-1 flex flex-col gap-4 pb-8"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
            <div className="relative flex h-9 flex-1 sm:flex-none items-center rounded-lg border border-border bg-card transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10">
              <div className="pl-2">
                <IconSearch className="h-4 w-4 text-muted-foreground" />
              </div>
              <Input
                placeholder="Search logs"
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-full w-full sm:w-44 border-0 text-sm focus:border-0 focus:ring-0 pl-2 pr-20 bg-transparent"
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
              <ViewModeToggle mode={viewMode} setMode={handleViewModeChange} />
            )}
          </div>
        </div>

        <div>
          {events.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No events available
            </div>
          ) : !isCodex && viewMode === "formatted" ? (
            <>
              <FormattedEventsView
                events={events}
                searchTerm={searchTerm}
                currentMatchIndex={currentMatchIdx}
                setTotalMatches={setTotalMatches}
                filterType="non-result"
              />
              <FormattedEventsView
                events={events}
                searchTerm={searchTerm}
                currentMatchIndex={currentMatchIdx}
                setTotalMatches={setTotalMatches}
                filterType="result"
              />
            </>
          ) : (
            <RawJsonView
              events={events}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIdx}
              setTotalMatches={setTotalMatches}
            />
          )}
        </div>
      </div>
    </div>
  );
}
