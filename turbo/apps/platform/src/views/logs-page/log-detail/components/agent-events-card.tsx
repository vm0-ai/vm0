import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { IconSearch, IconLoader2 } from "@tabler/icons-react";
import MarkdownPreview from "@uiw/react-markdown-preview";
import { Input } from "@vm0/ui";
import { StatusDot } from "../../components/status-dot.tsx";
import {
  viewMode$,
  currentMatchIndex$,
  totalMatchCount$,
  type ViewMode,
} from "../../../../signals/logs-page/log-detail-state.ts";
import { allEvents$ } from "../../../../signals/logs-page/log-detail-signals.ts";
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
  prompt,
  searchTerm,
  setSearchTerm,
  className,
}: {
  framework: string | null;
  prompt: string;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  className?: string;
}) {
  const eventsLoadable = useLastLoadable(allEvents$);

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
          {prompt.trim().length > 0 && (
            <PromptCard prompt={prompt} showConnector={events.length > 0} />
          )}
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

function summarizePrompt(prompt: string): string {
  // Find the last meaningful line — skip headers, separators, metadata
  const lines = prompt.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (
      line.length > 0 &&
      !line.startsWith("#") &&
      !line.startsWith("---") &&
      !line.startsWith("- ") &&
      !line.startsWith("[file]")
    ) {
      return line.length > 80 ? `${line.slice(0, 77)}...` : line;
    }
  }
  // Fallback: first non-empty line
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function PromptCard({
  prompt,
  showConnector,
}: {
  prompt: string;
  showConnector: boolean;
}) {
  const summary = summarizePrompt(prompt);

  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative py-2">
        <summary className="cursor-pointer list-none">
          <div className="flex gap-2 items-center">
            <StatusDot variant="neutral" />
            <span className="font-semibold text-sm text-foreground shrink-0">
              Prompt
            </span>
            <span className="text-sm text-muted-foreground truncate">
              {summary}
            </span>
          </div>
        </summary>
        <div className="absolute left-[2px] top-[2.25rem] bottom-0 w-[1px] bg-border/70 group-open:block hidden" />
        <div className="ml-[18px] mt-2">
          <MarkdownPreview
            source={prompt}
            className="!bg-transparent !text-foreground text-sm"
            style={{
              backgroundColor: "transparent",
              fontSize: "0.875rem",
              lineHeight: "1.5",
              fontFamily: "var(--font-family-sans)",
            }}
          />
        </div>
      </details>
    </div>
  );
}
