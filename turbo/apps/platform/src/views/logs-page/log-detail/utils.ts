import type { AgentEvent } from "../../../signals/logs-page/types.ts";

const ONE_MINUTE_MS = 60_000;

// Type definitions for extracting visible text
interface TextContent {
  type: "text";
  text: string;
}

interface ToolUseContent {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultContent {
  type: "tool_result";
  content: string;
}

type MessageContent = TextContent | ToolUseContent | ToolResultContent;

interface EventData {
  subtype?: string;
  message?: {
    content: MessageContent[] | null;
  };
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  result?: string | null;
}

/** Extract visible text from tool input based on tool type */
function extractToolInputText(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const parts: string[] = [];
  const name = toolName.toLowerCase();

  if (name === "bash" && typeof input.command === "string") {
    parts.push(input.command);
  } else if (name === "webfetch" || name === "websearch") {
    if (typeof input.url === "string") {
      parts.push(input.url);
    }
    if (typeof input.query === "string") {
      parts.push(input.query);
    }
    if (typeof input.prompt === "string") {
      parts.push(input.prompt);
    }
  } else if (["read", "write", "edit", "glob", "grep"].includes(name)) {
    const filePath = input.file_path ?? input.path ?? input.pattern;
    if (typeof filePath === "string") {
      parts.push(filePath);
    }
  } else if (name === "todowrite" && Array.isArray(input.todos)) {
    for (const todo of input.todos) {
      const item = todo as { content?: string };
      if (typeof item.content === "string") {
        parts.push(item.content);
      } else if (typeof todo === "string") {
        parts.push(todo);
      }
    }
  }

  return parts;
}

/** Extract visible text from message content */
function extractMessageContentText(contents: MessageContent[]): string[] {
  const parts: string[] = [];

  for (const content of contents) {
    if (content.type === "text") {
      const textContent = content as TextContent;
      if (textContent.text) {
        parts.push(textContent.text);
      }
    } else if (content.type === "tool_use") {
      const toolContent = content as ToolUseContent;
      parts.push(toolContent.name);
      if (toolContent.input) {
        parts.push(
          ...extractToolInputText(toolContent.name, toolContent.input),
        );
      }
    } else if (content.type === "tool_result") {
      const resultContent = content as ToolResultContent;
      if (resultContent.content) {
        parts.push(resultContent.content);
      }
    }
  }

  return parts;
}

/**
 * Extract visible/searchable text from an event.
 * Only includes text that is actually displayed to the user in formatted view.
 */
export function getVisibleEventText(event: AgentEvent): string {
  const parts: string[] = [];
  const eventData = event.eventData as EventData;

  // Event type label
  parts.push(event.eventType);

  // System events
  if (event.eventType === "system") {
    if (eventData.subtype) {
      parts.push(eventData.subtype);
      if (eventData.subtype === "init") {
        parts.push("Initialize");
      }
    }
    if (eventData.tools) {
      parts.push(...eventData.tools);
    }
    if (eventData.agents) {
      parts.push(...eventData.agents);
    }
    if (eventData.slash_commands) {
      parts.push(...eventData.slash_commands.map((cmd) => `/${cmd}`));
    }
  }

  // Result events
  if (event.eventType === "result" && eventData.result) {
    parts.push(eventData.result);
  }

  // Assistant/User events - extract visible content from message
  const contents = eventData.message?.content;
  if (Array.isArray(contents)) {
    parts.push(...extractMessageContentText(contents));
  }

  return parts.join(" ");
}

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
  const visibleText = getVisibleEventText(event).toLowerCase();
  return visibleText.includes(lowerSearch);
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
