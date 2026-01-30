import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { EventCard } from "../../components/event-card.tsx";
import { countMatches } from "../../utils/highlight-text.tsx";
import { eventMatchesSearch, EVENTS_CONTAINER_ID } from "../utils.ts";

export function FormattedEventsView({
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

  let totalMatches = 0;
  if (searchTerm.trim()) {
    for (const event of visibleEvents) {
      const dataStr = JSON.stringify(event.eventData);
      totalMatches += countMatches(dataStr, searchTerm);
    }
  }

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

  let matchOffset = 0;

  return (
    <div
      id={EVENTS_CONTAINER_ID}
      ref={containerRef}
      className="space-y-3 max-h-[600px] overflow-y-auto pr-1"
    >
      {visibleEvents.map((event) => {
        const eventMatchStart = matchOffset;
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
