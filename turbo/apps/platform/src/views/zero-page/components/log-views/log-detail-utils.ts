import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";

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
  // API may return non-string values (numbers, objects, etc.)
  content: unknown;
  is_error?: boolean;
}

/**
 * Normalizes tool result content to a string.
 * The API may return non-string values that need to be converted.
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return String(content ?? "");
}

type MessageContent = TextContent | ToolUseContent | ToolResultContent;

// ============ GROUPED MESSAGE TYPES ============

interface TodoItem {
  content: string;
  status: string;
}

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
  // For TodoWrite: snapshot of todo state at this point
  todoState?: TodoItem[];
}

export interface GroupedMessage {
  type: "system" | "assistant" | "result" | "todo";
  sequenceNumber: number;
  createdAt: string;
  textBefore?: string;
  textAfter?: string;
  toolOperations?: ToolOperation[];
  // For "todo" type: current state of all tasks
  todoState?: TodoItem[];
  eventData: unknown;
}

// ============ EVENT GROUPING ============

interface ToolResultMeta {
  bytes?: number | null;
  durationMs?: number | null;
}

export interface GroupingEventData {
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

  if (name === "skill" && typeof input.skill === "string") {
    return input.skill;
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

  const content = normalizeToolResultContent(resultContent.content);

  if (pending) {
    pending.operation.result = {
      content,
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
          content,
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
 * Process TodoWrite operation and update todo state.
 * Returns the new in_progress task content if any.
 */
function processTodoWrite(
  op: ToolOperation,
  todoState: Map<string, { content: string; status: string }>,
): string | null {
  if (op.toolName.toLowerCase() !== "todowrite") {
    return null;
  }
  const todos = op.input.todos;
  if (!Array.isArray(todos)) {
    return null;
  }
  let newInProgressTask: string | null = null;
  for (const todo of todos) {
    const item = todo as { content?: string; status?: string };
    const content = item.content ?? String(todo);
    const status = item.status ?? "pending";
    todoState.set(content, { content, status });
    if (status === "in_progress") {
      newInProgressTask = content;
    }
  }
  return newInProgressTask;
}

interface GroupingContext {
  grouped: GroupedMessage[];
  pendingToolUses: Map<
    string,
    { operation: ToolOperation; message: GroupedMessage }
  >;
  todoState: Map<string, { content: string; status: string }>;
}

function processSystemEvent(event: AgentEvent, ctx: GroupingContext): void {
  ctx.grouped.push({
    type: "system",
    sequenceNumber: event.sequenceNumber,
    createdAt: event.createdAt,
    eventData: event.eventData,
  });
}

function processResultEvent(event: AgentEvent, ctx: GroupingContext): void {
  ctx.grouped.push({
    type: "result",
    sequenceNumber: event.sequenceNumber,
    createdAt: event.createdAt,
    eventData: event.eventData,
  });
}

function processAssistantEvent(
  event: AgentEvent,
  eventData: GroupingEventData,
  ctx: GroupingContext,
): void {
  const contents = eventData.message?.content ?? [];
  const { textParts, toolOperations } = parseAssistantContent(contents);
  const hasText = textParts.length > 0;

  // Separate TodoWrite from other tools
  const otherToolOps: ToolOperation[] = [];
  const todoWriteOps: ToolOperation[] = [];

  for (const op of toolOperations) {
    if (op.toolName.toLowerCase() === "todowrite") {
      processTodoWrite(op, ctx.todoState);
      todoWriteOps.push(op);
    } else {
      otherToolOps.push(op);
    }
  }

  const hasOtherTools = otherToolOps.length > 0;

  // Rule: Tools without text get appended to the previous assistant card
  if (!hasText && hasOtherTools && todoWriteOps.length === 0) {
    const lastAssistant = getLastMergeableAssistant(ctx.grouped);
    if (lastAssistant) {
      appendToolsToMessage(lastAssistant, otherToolOps, ctx.pendingToolUses);
      return;
    }
  }

  // Create assistant message for text and non-TodoWrite tools
  if (hasText || hasOtherTools) {
    const message: GroupedMessage = {
      type: "assistant",
      sequenceNumber: event.sequenceNumber,
      createdAt: event.createdAt,
      textBefore: hasText ? textParts.join("\n\n") : undefined,
      toolOperations: hasOtherTools ? otherToolOps : undefined,
      eventData: event.eventData,
    };
    ctx.grouped.push(message);
    for (const op of otherToolOps) {
      ctx.pendingToolUses.set(op.toolUseId, { operation: op, message });
    }
  }

  // Create standalone todo card for each TodoWrite
  for (const todoOp of todoWriteOps) {
    const todoMessage: GroupedMessage = {
      type: "todo",
      sequenceNumber: event.sequenceNumber + 0.01,
      createdAt: event.createdAt,
      todoState: Array.from(ctx.todoState.values()),
      eventData: {},
    };
    ctx.grouped.push(todoMessage);
    ctx.pendingToolUses.set(todoOp.toolUseId, {
      operation: todoOp,
      message: todoMessage,
    });
  }
}

function processUserEvent(
  event: AgentEvent,
  eventData: GroupingEventData,
  ctx: GroupingContext,
): void {
  const contents = eventData.message?.content ?? [];
  const toolMeta = eventData.tool_use_result;

  for (const content of contents) {
    if (content.type === "tool_result") {
      processToolResult(
        content as ToolResultContent,
        toolMeta,
        ctx.pendingToolUses,
        event,
        ctx.grouped,
      );
    }
  }
}

/**
 * Groups flat event array into message-centric structure.
 * - Consecutive assistant messages are merged (text + tools in one card)
 * - Tool results are linked to their tool_use calls
 * - TodoWrite operations create standalone "todo" type cards
 * - System and Result events remain independent
 */
export function groupEventsIntoMessages(
  events: AgentEvent[],
): GroupedMessage[] {
  const sorted = [...events].sort((a, b) => {
    return a.sequenceNumber - b.sequenceNumber;
  });

  const seen = new Set<number>();
  const deduped = sorted.filter((e) => {
    if (seen.has(e.sequenceNumber)) {
      return false;
    }
    seen.add(e.sequenceNumber);
    return true;
  });

  const ctx: GroupingContext = {
    grouped: [],
    pendingToolUses: new Map(),
    todoState: new Map(),
  };

  for (const event of deduped) {
    const eventData = event.eventData as GroupingEventData;

    if (event.eventType === "system") {
      processSystemEvent(event, ctx);
    } else if (event.eventType === "result") {
      processResultEvent(event, ctx);
    } else if (event.eventType === "assistant") {
      processAssistantEvent(event, eventData, ctx);
    } else if (event.eventType === "user") {
      processUserEvent(event, eventData, ctx);
    }
  }

  return ctx.grouped;
}

/**
 * Extract visible/searchable text from a grouped message.
 */
function getVisibleGroupedMessageText(message: GroupedMessage): string {
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
      parts.push(
        ...eventData.slash_commands.map((cmd) => {
          return `/${cmd}`;
        }),
      );
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
