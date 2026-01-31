import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { GroupedMessageCard } from "../../components/grouped-message-card.tsx";
import { countMatches } from "../../utils/highlight-text.tsx";
import {
  groupEventsIntoMessages,
  getVisibleGroupedMessageText,
  groupedMessageMatchesSearch,
} from "../utils.ts";

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
  // Group events into messages
  const groupedMessages = groupEventsIntoMessages(events);

  // Filter grouped messages by hidden types and search
  const visibleMessages = groupedMessages.filter(
    (message) =>
      !hiddenTypes.has(message.type) &&
      groupedMessageMatchesSearch(message, searchTerm),
  );

  // Count total matches for search navigation
  let totalMatches = 0;
  if (searchTerm.trim()) {
    for (const message of visibleMessages) {
      const visibleText = getVisibleGroupedMessageText(message);
      totalMatches += countMatches(visibleText, searchTerm);
    }
  }

  const containerRef = (node: HTMLDivElement | null) => {
    if (node) {
      setTotalMatches(totalMatches);
    }
  };

  if (visibleMessages.length === 0) {
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
    <div ref={containerRef} className="space-y-3">
      {visibleMessages.map((message) => {
        const messageMatchStart = matchOffset;
        const visibleText = getVisibleGroupedMessageText(message);
        const messageMatches = searchTerm.trim()
          ? countMatches(visibleText, searchTerm)
          : 0;
        matchOffset += messageMatches;

        return (
          <GroupedMessageCard
            key={`${message.type}-${message.sequenceNumber}-${message.createdAt}`}
            message={message}
            searchTerm={searchTerm}
            currentMatchIndex={currentMatchIndex}
            matchStartIndex={messageMatchStart}
          />
        );
      })}
    </div>
  );
}
