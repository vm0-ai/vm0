import type { AgentEvent } from "../../../signals/logs-page/types.ts";

const ONE_MINUTE_MS = 60_000;

export function formatTime(dateStr: string): string {
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

export function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
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

export function getEventTypeCounts(events: AgentEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const type = event.eventType;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

export function eventMatchesSearch(
  event: AgentEvent,
  searchTerm: string,
): boolean {
  if (!searchTerm.trim()) {
    return true;
  }
  const lowerSearch = searchTerm.toLowerCase();
  if (event.eventType.toLowerCase().includes(lowerSearch)) {
    return true;
  }
  const dataStr = JSON.stringify(event.eventData).toLowerCase();
  return dataStr.includes(lowerSearch);
}

export function scrollToMatch(
  container: HTMLElement | null,
  matchIndex: number,
): void {
  if (!container || matchIndex < 0) {
    return;
  }
  const matchElement = container.querySelector(
    `[data-match-index="${matchIndex}"]`,
  );
  if (matchElement instanceof HTMLElement) {
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

export const EVENTS_CONTAINER_ID = "events-scroll-container";
