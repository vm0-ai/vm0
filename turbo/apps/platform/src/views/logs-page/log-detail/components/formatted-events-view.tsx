import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { GroupedMessageCard } from "../../components/grouped-message-card.tsx";
import { countMatches } from "../../utils/highlight-text.tsx";
import {
  groupEventsIntoMessages,
  getVisibleGroupedMessageText,
  scrollToMatch,
} from "../utils.ts";

export function FormattedEventsView({
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
  // Group events into messages
  const groupedMessages = groupEventsIntoMessages(events);

  // Filter out text-only assistant messages right before result (they're redundant)
  const visibleMessages = groupedMessages.filter((message, index) => {
    if (message.type !== "assistant") {
      return true;
    }
    // Check if next message is a result
    const nextMessage = groupedMessages[index + 1];
    if (!nextMessage || nextMessage.type !== "result") {
      return true;
    }
    // Filter out if assistant message has only text (no tools)
    const hasTools =
      message.toolOperations && message.toolOperations.length > 0;
    return hasTools;
  });

  // Count total matches for search navigation (no filtering, just highlight and scroll)
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

      // Scroll to current match after render
      if (searchTerm.trim() && currentMatchIndex >= 0) {
        queueMicrotask(() => {
          scrollToMatch(node, currentMatchIndex);
        });
      }
    }
  };

  if (visibleMessages.length === 0) {
    return (
      <div ref={containerRef} className="p-8 text-center text-muted-foreground">
        No events available
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
