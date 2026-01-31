import type { AgentEvent } from "../../../signals/logs-page/types.ts";

const ONE_MINUTE_MS = 60_000;

// Type definitions for extracting visible text
interface TextContent {
  type: "text";
  text: string;
}

interface ToolUseContent {
  type: "tool_use";
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultContent {
  type: "tool_result";
  tool_use_id?: string;
  content: string;
  is_error?: boolean;
}

type MessageContent = TextContent | ToolUseContent | ToolResultContent;

// ============ GROUPED MESSAGE TYPES ============

export interface ToolOperation {
  toolUseId: string;
  toolName: string;
  keyParam: string;
  input: Record<string, unknown>;
  result?: {
    content: string;
    isError: boolean;
    durationMs?: number;
    bytes?: number;
  };
}

export interface TodoItem {
  content: string;
  status: string;
}

export interface GroupedMessage {
  type: "system" | "assistant" | "result";
  sequenceNumber: number;
  createdAt: string;
  textBefore?: string;
  textAfter?: string;
  toolOperations?: ToolOperation[];
  todoSummary?: TodoItem[];
  eventData: unknown;
}

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

// ============ EVENT GROUPING ============

interface ToolResultMeta {
  bytes?: number | null;
  durationMs?: number | null;
}

interface GroupingEventData {
  subtype?: string;
  message?: {
    content: MessageContent[] | null;
  };
  tool_use_result?: ToolResultMeta;
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  result?: string | null;
  is_error?: boolean;
}

/**
 * Extract the key parameter from tool input for display in summary
 */
function extractKeyParam(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  if (name === "bash" && typeof input.command === "string") {
    // Truncate long commands
    const cmd = input.command;
    return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
  }

  if (name === "webfetch" || name === "websearch") {
    if (typeof input.url === "string") {
      return input.url;
    }
    if (typeof input.query === "string") {
      return input.query;
    }
  }

  if (["read", "write", "edit", "glob", "grep"].includes(name)) {
    const filePath = input.file_path ?? input.path ?? input.pattern;
    if (typeof filePath === "string") {
      return filePath;
    }
  }

  if (name === "task" && typeof input.prompt === "string") {
    const prompt = input.prompt;
    return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
  }

  // Generic: try common parameter names
  for (const key of [
    "file_path",
    "path",
    "command",
    "url",
    "query",
    "pattern",
    "prompt",
  ]) {
    if (typeof input[key] === "string") {
      const val = input[key] as string;
      return val.length > 60 ? `${val.slice(0, 57)}...` : val;
    }
  }

  return "";
}

/**
 * Parse assistant event content into text parts and tool operations.
 */
function parseAssistantContent(contents: MessageContent[]): {
  textParts: string[];
  toolOperations: ToolOperation[];
  foundToolUse: boolean;
} {
  const textParts: string[] = [];
  const toolOperations: ToolOperation[] = [];
  let foundToolUse = false;

  for (const content of contents) {
    if (content.type === "text") {
      const textContent = content as TextContent;
      if (textContent.text) {
        textParts.push(textContent.text);
      }
    } else if (content.type === "tool_use") {
      foundToolUse = true;
      const toolContent = content as ToolUseContent;
      const toolUseId = toolContent.id ?? `unknown-${Math.random()}`;
      toolOperations.push({
        toolUseId,
        toolName: toolContent.name,
        keyParam: extractKeyParam(toolContent.name, toolContent.input),
        input: toolContent.input,
      });
    }
  }

  return { textParts, toolOperations, foundToolUse };
}

/**
 * Process a tool_result content block and attach to pending tool use or create orphan.
 */
function processToolResult(
  resultContent: ToolResultContent,
  toolMeta: ToolResultMeta | undefined,
  pendingToolUses: Map<
    string,
    { operation: ToolOperation; message: GroupedMessage }
  >,
  event: AgentEvent,
  grouped: GroupedMessage[],
): void {
  const toolUseId = resultContent.tool_use_id;
  const pending = toolUseId ? pendingToolUses.get(toolUseId) : undefined;

  if (pending) {
    pending.operation.result = {
      content: resultContent.content,
      isError: resultContent.is_error === true,
      durationMs: toolMeta?.durationMs ?? undefined,
      bytes: toolMeta?.bytes ?? undefined,
    };
    pendingToolUses.delete(toolUseId!);
    return;
  }

  // Orphan tool_result - create standalone message
  grouped.push({
    type: "assistant",
    sequenceNumber: event.sequenceNumber,
    createdAt: event.createdAt,
    toolOperations: [
      {
        toolUseId: toolUseId ?? `orphan-${Math.random()}`,
        toolName: "Unknown",
        keyParam: "",
        input: {},
        result: {
          content: resultContent.content,
          isError: resultContent.is_error === true,
          durationMs: toolMeta?.durationMs ?? undefined,
          bytes: toolMeta?.bytes ?? undefined,
        },
      },
    ],
    eventData: event.eventData,
  });
}

/**
 * Check if last grouped message is an assistant message that can be merged with new content.
 * Returns the message if mergeable, null otherwise.
 */
function getLastMergeableAssistant(
  grouped: GroupedMessage[],
): GroupedMessage | null {
  if (grouped.length === 0) {
    return null;
  }
  const last = grouped[grouped.length - 1];
  if (last.type !== "assistant") {
    return null;
  }
  return last;
}

/**
 * Append tool operations to an existing assistant message and register them as pending.
 */
function appendToolsToMessage(
  message: GroupedMessage,
  toolOperations: ToolOperation[],
  pendingToolUses: Map<
    string,
    { operation: ToolOperation; message: GroupedMessage }
  >,
): void {
  if (!message.toolOperations) {
    message.toolOperations = [];
  }
  message.toolOperations.push(...toolOperations);
  for (const op of toolOperations) {
    pendingToolUses.set(op.toolUseId, { operation: op, message });
  }
}

/**
 * Collect all todo items from TodoWrite tool operations.
 */
function collectTodoItems(
  grouped: GroupedMessage[],
): { content: string; status: string }[] {
  const todoMap = new Map<string, { content: string; status: string }>();

  for (const message of grouped) {
    if (message.type !== "assistant" || !message.toolOperations) {
      continue;
    }
    for (const op of message.toolOperations) {
      if (op.toolName.toLowerCase() !== "todowrite") {
        continue;
      }
      const todos = op.input.todos;
      if (!Array.isArray(todos)) {
        continue;
      }
      for (const todo of todos) {
        const item = todo as { content?: string; status?: string; id?: string };
        const content = item.content ?? String(todo);
        const status = item.status ?? "pending";
        // Use content as key to track latest status
        todoMap.set(content, { content, status });
      }
    }
  }

  return Array.from(todoMap.values());
}

/**
 * Groups flat event array into message-centric structure.
 * - Consecutive assistant messages are merged (text + tools in one card)
 * - Tool results are linked to their tool_use calls
 * - Todo summary is inserted before result event
 * - System and Result events remain independent
 */
export function groupEventsIntoMessages(
  events: AgentEvent[],
): GroupedMessage[] {
  const grouped: GroupedMessage[] = [];
  const pendingToolUses = new Map<
    string,
    { operation: ToolOperation; message: GroupedMessage }
  >();

  for (const event of events) {
    const eventData = event.eventData as GroupingEventData;

    if (event.eventType === "system") {
      grouped.push({
        type: "system",
        sequenceNumber: event.sequenceNumber,
        createdAt: event.createdAt,
        eventData: event.eventData,
      });
      continue;
    }

    if (event.eventType === "result") {
      // Insert todo summary before result if there are any todos
      const todoItems = collectTodoItems(grouped);
      if (todoItems.length > 0) {
        grouped.push({
          type: "assistant",
          sequenceNumber: event.sequenceNumber - 0.5,
          createdAt: event.createdAt,
          todoSummary: todoItems,
          eventData: {},
        });
      }

      grouped.push({
        type: "result",
        sequenceNumber: event.sequenceNumber,
        createdAt: event.createdAt,
        eventData: event.eventData,
      });
      continue;
    }

    if (event.eventType === "assistant") {
      const contents = eventData.message?.content ?? [];
      const { textParts, toolOperations } = parseAssistantContent(contents);

      const hasText = textParts.length > 0;
      const hasTools = toolOperations.length > 0;

      // Rule: New text always starts a new card
      // Tools without text get appended to the previous assistant card
      if (!hasText && hasTools) {
        const lastAssistant = getLastMergeableAssistant(grouped);
        if (lastAssistant) {
          appendToolsToMessage(lastAssistant, toolOperations, pendingToolUses);
          continue;
        }
      }

      // Create new message (has text, or has tools but no previous assistant to merge into)
      const message: GroupedMessage = {
        type: "assistant",
        sequenceNumber: event.sequenceNumber,
        createdAt: event.createdAt,
        textBefore: hasText ? textParts.join("\n\n") : undefined,
        toolOperations: hasTools ? toolOperations : undefined,
        eventData: event.eventData,
      };

      grouped.push(message);

      for (const op of toolOperations) {
        pendingToolUses.set(op.toolUseId, { operation: op, message });
      }
      continue;
    }

    if (event.eventType === "user") {
      const contents = eventData.message?.content ?? [];
      const toolMeta = eventData.tool_use_result;

      for (const content of contents) {
        if (content.type === "tool_result") {
          processToolResult(
            content as ToolResultContent,
            toolMeta,
            pendingToolUses,
            event,
            grouped,
          );
        }
      }
    }
  }

  return grouped;
}

/**
 * Extract visible/searchable text from a grouped message.
 */
export function getVisibleGroupedMessageText(message: GroupedMessage): string {
  const parts: string[] = [];

  parts.push(message.type);

  if (message.textBefore) {
    parts.push(message.textBefore);
  }

  if (message.toolOperations) {
    for (const op of message.toolOperations) {
      parts.push(op.toolName);
      if (op.keyParam) {
        parts.push(op.keyParam);
      }
      if (op.result?.content) {
        parts.push(op.result.content);
      }
    }
  }

  if (message.textAfter) {
    parts.push(message.textAfter);
  }

  // For system/result events, also extract from eventData
  const eventData = message.eventData as GroupingEventData;

  if (message.type === "system") {
    if (eventData.subtype) {
      parts.push(eventData.subtype);
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

  if (message.type === "result" && eventData.result) {
    parts.push(eventData.result);
  }

  return parts.join(" ");
}

/**
 * Check if a grouped message matches the search term.
 */
export function groupedMessageMatchesSearch(
  message: GroupedMessage,
  searchTerm: string,
): boolean {
  if (!searchTerm.trim()) {
    return true;
  }
  const lowerSearch = searchTerm.toLowerCase();
  const visibleText = getVisibleGroupedMessageText(message).toLowerCase();
  return visibleText.includes(lowerSearch);
}
