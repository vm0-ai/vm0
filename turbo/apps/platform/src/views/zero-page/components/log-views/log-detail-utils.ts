import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";
import { normalizeCodexEventsForGrouping } from "./codex-activity-normalizer.ts";

interface ToolResultContent {
  type: "tool_result";
  tool_use_id?: string;
  // API may return non-string values (numbers, objects, etc.)
  content: unknown;
  is_error?: boolean;
}

const MAX_STRINGIFY_DEPTH = 32;
const MAX_STRINGIFY_ARRAY_ITEMS = 100;
const MAX_STRINGIFY_OBJECT_FIELDS = 100;

/**
 * Normalizes tool result content to a string.
 * The API may return non-string values that need to be converted.
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  return stringifyUnknownValue(content);
}

function quoteJsonString(value: string): string {
  return JSON.stringify(value);
}

function stringifyPrimitiveJsonValue(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return quoteJsonString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return quoteJsonString(value.toString());
  }
  return undefined;
}

function stringifyArrayJsonValue(
  value: unknown[],
  seen: WeakSet<object>,
  depth: number,
): string {
  const items: string[] = [];
  const itemCount = Math.min(value.length, MAX_STRINGIFY_ARRAY_ITEMS);
  for (let index = 0; index < itemCount; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const item =
      descriptor && "value" in descriptor
        ? stringifyUnknownJsonValue(descriptor.value, seen, depth + 1)
        : undefined;
    items.push(item ?? "null");
  }
  if (value.length > MAX_STRINGIFY_ARRAY_ITEMS) {
    items.push(
      quoteJsonString(
        `... ${value.length - MAX_STRINGIFY_ARRAY_ITEMS} more items`,
      ),
    );
  }
  return `[${items.join(",")}]`;
}

function stringifyObjectJsonValue(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): string {
  const entries: string[] = [];
  let inspectedFields = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (inspectedFields >= MAX_STRINGIFY_OBJECT_FIELDS) {
      entries.push(`${quoteJsonString("...")}:${quoteJsonString("truncated")}`);
      break;
    }
    inspectedFields += 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    const serialized = stringifyUnknownJsonValue(
      descriptor.value,
      seen,
      depth + 1,
    );
    if (serialized !== undefined) {
      entries.push(`${quoteJsonString(key)}:${serialized}`);
    }
  }
  return `{${entries.join(",")}}`;
}

function stringifyUnknownJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): string | undefined {
  const primitive = stringifyPrimitiveJsonValue(value);
  if (primitive !== undefined) {
    return primitive;
  }

  if (value === null || typeof value !== "object") {
    return undefined;
  }

  if (seen.has(value)) {
    return quoteJsonString("[Circular]");
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? quoteJsonString(value.toISOString())
      : "null";
  }

  if (depth >= MAX_STRINGIFY_DEPTH) {
    return quoteJsonString("[MaxDepth]");
  }

  seen.add(value);
  const serialized = Array.isArray(value)
    ? stringifyArrayJsonValue(value, seen, depth)
    : stringifyObjectJsonValue(value, seen, depth);
  seen.delete(value);
  return serialized;
}

export function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "function") {
    return "[function]";
  }
  return stringifyUnknownJsonValue(value, new WeakSet()) ?? "[unserializable]";
}

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
  thinkingBlocks?: string[];
  textBefore?: string;
  textAfter?: string;
  toolOperations?: ToolOperation[];
  // For "todo" type: current state of all tasks
  todoState?: TodoItem[];
  eventData: unknown;
  // For task system events: child messages from sub-agent
  childMessages?: GroupedMessage[];
}

export function groupedMessageKey(message: GroupedMessage): string {
  return JSON.stringify([
    message.type,
    String(message.sequenceNumber),
    message.createdAt,
    message.thinkingBlocks ?? null,
    message.textBefore ?? null,
    message.textAfter ?? null,
    message.toolOperations?.map((operation) => {
      return operation.toolUseId;
    }) ?? null,
    message.todoState?.map((todo) => {
      return [todo.status, todo.content];
    }) ?? null,
  ]);
}

interface GroupEventsIntoMessagesOptions {
  framework?: string | null;
}

const FALLBACK_CONTENT_SEQUENCE_OFFSET_SCALE = 1_000_000;

// ============ EVENT GROUPING ============

interface ToolResultMeta {
  bytes?: number | null;
  durationMs?: number | null;
}

interface GroupingEventData {
  subtype?: string;
  parent_tool_use_id?: string;
  message?: {
    content: unknown[] | null;
  };
  tool_use_result?: ToolResultMeta;
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  result?: string | null;
  is_error?: boolean;
}

/**
 * Shape of task-related system event data (task_started, task_notification, task_progress).
 */
interface TaskEventData extends GroupingEventData {
  task_id: string;
  // Present in task_started
  tool_use_id?: string;
  description?: string;
  // Present in task_notification
  status?: string;
  summary?: string;
  // Augmented in-place when a notification is merged into a started event
  task_status?: string;
  task_summary?: string;
  task_completed_at?: string;
}

interface PendingToolUse {
  operation: ToolOperation;
  message: GroupedMessage;
  parentToolUseId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isTaskEventData(data: unknown): data is TaskEventData {
  return isRecord(data) && typeof data.task_id === "string";
}

function toTaskEventData(data: TaskEventData): TaskEventData {
  return {
    task_id: data.task_id,
    subtype: stringValue(data.subtype),
    tool_use_id: stringValue(data.tool_use_id),
    description: stringValue(data.description),
    status: stringValue(data.status),
    summary: stringValue(data.summary),
    task_status: stringValue(data.task_status),
    task_summary: stringValue(data.task_summary),
    task_completed_at: stringValue(data.task_completed_at),
  };
}

function toGroupingEventData(data: unknown): GroupingEventData {
  return isRecord(data) ? (data as GroupingEventData) : {};
}

function getMessageContents(eventData: GroupingEventData): unknown[] {
  const contents = eventData.message?.content;
  return Array.isArray(contents) ? contents : [];
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

function toToolResultMeta(value: unknown): ToolResultMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const meta: ToolResultMeta = {};
  if (
    typeof value.bytes === "number" &&
    Number.isFinite(value.bytes) &&
    value.bytes >= 0
  ) {
    meta.bytes = value.bytes;
  }
  if (
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  ) {
    meta.durationMs = value.durationMs;
  }
  return meta.bytes === undefined && meta.durationMs === undefined
    ? undefined
    : meta;
}

function eventDedupeKey(event: AgentEvent): string {
  return stringifyUnknownValue({
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    createdAt: event.createdAt,
    eventData: event.eventData,
  });
}

interface SeenSequenceEvents {
  events: AgentEvent[];
  keys?: Set<string>;
}

function disambiguateDuplicateSequenceNumbers(
  events: readonly AgentEvent[],
): AgentEvent[] {
  const occurrenceCountBySequence = new Map<number, number>();
  const distinctSequenceNumbers: number[] = [];
  for (const event of events) {
    const existing = occurrenceCountBySequence.get(event.sequenceNumber) ?? 0;
    if (existing === 0) {
      distinctSequenceNumbers.push(event.sequenceNumber);
    }
    occurrenceCountBySequence.set(event.sequenceNumber, existing + 1);
  }

  const nextSequenceNumberBySequence = new Map<number, number>();
  for (let i = 0; i < distinctSequenceNumbers.length - 1; i++) {
    nextSequenceNumberBySequence.set(
      distinctSequenceNumbers[i]!,
      distinctSequenceNumbers[i + 1]!,
    );
  }

  const seenCountBySequence = new Map<number, number>();

  return events.map((event) => {
    const seenCount = seenCountBySequence.get(event.sequenceNumber) ?? 0;
    seenCountBySequence.set(event.sequenceNumber, seenCount + 1);
    if (seenCount === 0) {
      return event;
    }

    const occurrenceCount = occurrenceCountBySequence.get(
      event.sequenceNumber,
    )!;
    const nextSequenceNumber = nextSequenceNumberBySequence.get(
      event.sequenceNumber,
    );
    const gap =
      nextSequenceNumber !== undefined
        ? nextSequenceNumber - event.sequenceNumber
        : 1;
    const sequenceNumber =
      event.sequenceNumber + (gap * seenCount) / occurrenceCount;

    return {
      ...event,
      sequenceNumber,
    };
  });
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
function fallbackToolUseId(
  prefix: "orphan" | "unknown",
  sequenceNumber: number,
  contentIndex: number,
): string {
  return `${prefix}-${sequenceNumber}-${contentIndex}`;
}

function registerPendingToolUse(
  pendingToolUses: Map<string, PendingToolUse[]>,
  operation: ToolOperation,
  message: GroupedMessage,
  parentToolUseId?: string,
): void {
  const pending = pendingToolUses.get(operation.toolUseId) ?? [];
  pending.push({ operation, message, parentToolUseId });
  pendingToolUses.set(operation.toolUseId, pending);
}

function takePendingToolUse(
  pendingToolUses: Map<string, PendingToolUse[]>,
  toolUseId: string,
  parentToolUseId: string | undefined,
): PendingToolUse | undefined {
  const pending = pendingToolUses.get(toolUseId);
  if (!pending) {
    return undefined;
  }

  let index =
    parentToolUseId !== undefined
      ? pending.findIndex((item) => {
          return item.parentToolUseId === parentToolUseId;
        })
      : -1;

  if (index === -1 && parentToolUseId === undefined) {
    index = 0;
  }

  if (index === -1) {
    return undefined;
  }

  const [matched] = pending.splice(index, 1);
  if (pending.length === 0) {
    pendingToolUses.delete(toolUseId);
  }
  return matched;
}

function sequenceNumberWithContentOffset(params: {
  sequenceNumber: number;
  contentIndex: number;
  contentCount: number;
  nextSequenceNumber?: number;
}): number {
  const { sequenceNumber, contentIndex, contentCount, nextSequenceNumber } =
    params;
  const nextGap =
    nextSequenceNumber !== undefined ? nextSequenceNumber - sequenceNumber : 0;
  const hasBoundedGap = Number.isFinite(nextGap) && nextGap > 0;
  const offset = hasBoundedGap
    ? (nextGap * (contentIndex + 1)) / (contentCount + 1)
    : (contentIndex + 1) / FALLBACK_CONTENT_SEQUENCE_OFFSET_SCALE;
  return sequenceNumber + offset;
}

function parseAssistantContent(
  contents: readonly unknown[],
  sequenceNumber: number,
): {
  thinkingParts: string[];
  textParts: string[];
  toolOperations: ToolOperation[];
  foundToolUse: boolean;
} {
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const toolOperations: ToolOperation[] = [];
  let foundToolUse = false;

  for (const [contentIndex, content] of contents.entries()) {
    if (!isRecord(content)) {
      continue;
    }
    if (content.type === "thinking") {
      if (typeof content.thinking === "string" && content.thinking) {
        thinkingParts.push(content.thinking);
      }
    } else if (content.type === "text") {
      if (typeof content.text === "string" && content.text) {
        textParts.push(content.text);
      }
    } else if (content.type === "tool_use") {
      if (typeof content.name !== "string" || !content.name) {
        continue;
      }
      foundToolUse = true;
      const input = isRecord(content.input) ? content.input : {};
      const toolUseId =
        typeof content.id === "string" && content.id.length > 0
          ? content.id
          : fallbackToolUseId("unknown", sequenceNumber, contentIndex);
      toolOperations.push({
        toolUseId,
        toolName: content.name,
        keyParam: extractKeyParam(content.name, input),
        input,
      });
    }
  }

  return { thinkingParts, textParts, toolOperations, foundToolUse };
}

/**
 * Process a tool_result content block and attach to pending tool use or create orphan.
 */
function processToolResult(params: {
  resultContent: ToolResultContent;
  toolMeta: ToolResultMeta | undefined;
  pendingToolUses: Map<string, PendingToolUse[]>;
  parentToolUseId?: string;
  event: AgentEvent;
  fallbackSequenceNumber: number;
  fallbackToolUseIdValue: string;
  grouped: GroupedMessage[];
}): void {
  const {
    resultContent,
    toolMeta,
    pendingToolUses,
    parentToolUseId,
    event,
    fallbackSequenceNumber,
    fallbackToolUseIdValue,
    grouped,
  } = params;
  const toolUseId = resultContent.tool_use_id;
  const pending = toolUseId
    ? takePendingToolUse(pendingToolUses, toolUseId, parentToolUseId)
    : undefined;

  const content = normalizeToolResultContent(resultContent.content);

  if (pending) {
    pending.operation.result = {
      content,
      isError: resultContent.is_error === true,
      durationMs: toolMeta?.durationMs ?? undefined,
      bytes: toolMeta?.bytes ?? undefined,
    };
    return;
  }

  // Orphan tool_result - create standalone message
  grouped.push({
    type: "assistant",
    sequenceNumber: fallbackSequenceNumber,
    createdAt: event.createdAt,
    toolOperations: [
      {
        toolUseId: toolUseId ?? fallbackToolUseIdValue,
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
    eventData: toGroupingEventData(event.eventData),
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
  pendingToolUses: Map<string, PendingToolUse[]>,
  parentToolUseId?: string,
): void {
  if (!message.toolOperations) {
    message.toolOperations = [];
  }
  message.toolOperations.push(...toolOperations);
  for (const op of toolOperations) {
    registerPendingToolUse(pendingToolUses, op, message, parentToolUseId);
  }
}

/**
 * Extract the latest todo snapshot from a TodoWrite operation.
 */
function processTodoWrite(op: ToolOperation): TodoItem[] | null {
  if (op.toolName.toLowerCase() !== "todowrite") {
    return null;
  }
  const todos = op.input.todos;
  if (!Array.isArray(todos)) {
    return null;
  }

  return todos.map((todo) => {
    const item = isRecord(todo) ? todo : {};
    const content =
      typeof item.content === "string"
        ? item.content
        : stringifyUnknownValue(todo);
    const status = typeof item.status === "string" ? item.status : "pending";
    return { content, status };
  });
}

interface GroupingContext {
  grouped: GroupedMessage[];
  pendingToolUses: Map<string, PendingToolUse[]>;
  todoState: TodoItem[];
  pendingTasks: Map<string, GroupedMessage>;
  // Map from tool_use_id (that spawned the task) → task GroupedMessage
  // Used to route child events via parent_tool_use_id
  taskByToolUseId: Map<string, GroupedMessage>;
}

function processSystemEvent(event: AgentEvent, ctx: GroupingContext): void {
  const eventData = toGroupingEventData(event.eventData);
  const subtype = stringValue(eventData.subtype);

  if (subtype === "thinking_tokens") {
    return;
  }

  if (!isTaskEventData(event.eventData)) {
    ctx.grouped.push({
      type: "system",
      sequenceNumber: event.sequenceNumber,
      createdAt: event.createdAt,
      eventData,
    });
    return;
  }

  const taskData = toTaskEventData(event.eventData);
  const taskId = taskData.task_id;

  // Merge task_started + task_notification into a single row by task_id
  if (subtype === "task_started") {
    const message: GroupedMessage = {
      type: "system",
      sequenceNumber: event.sequenceNumber,
      createdAt: event.createdAt,
      eventData: taskData,
    };
    ctx.grouped.push(message);
    ctx.pendingTasks.set(taskId, message);
    if (taskData.tool_use_id) {
      ctx.taskByToolUseId.set(taskData.tool_use_id, message);
    }
    return;
  }

  if (subtype === "task_notification") {
    const pending = ctx.pendingTasks.get(taskId);
    if (pending) {
      // Merge notification into the existing task_started message
      const existingData = pending.eventData as TaskEventData;
      existingData.task_status = taskData.status;
      existingData.task_summary = taskData.summary;
      existingData.task_completed_at = event.createdAt;
      ctx.pendingTasks.delete(taskId);
      return;
    }
    // Orphan notification (no matching task_started) — fall through to standalone
  }

  // task_progress is a heartbeat signal — absorb it into the parent task row
  if (subtype === "task_progress" && ctx.pendingTasks.has(taskId)) {
    return;
  }

  ctx.grouped.push({
    type: "system",
    sequenceNumber: event.sequenceNumber,
    createdAt: event.createdAt,
    eventData: taskData,
  });
}

function processResultEvent(event: AgentEvent, ctx: GroupingContext): void {
  ctx.grouped.push({
    type: "result",
    sequenceNumber: event.sequenceNumber,
    createdAt: event.createdAt,
    eventData: toGroupingEventData(event.eventData),
  });
}

/**
 * Find the parent task for a child event via parent_tool_use_id.
 * Returns the task GroupedMessage if found, null otherwise.
 */
function findParentTask(
  eventData: GroupingEventData,
  ctx: GroupingContext,
): GroupedMessage | null {
  const parentId = stringValue(eventData.parent_tool_use_id);
  if (!parentId) {
    return null;
  }
  return ctx.taskByToolUseId.get(parentId) ?? null;
}

/**
 * Append a child message to a task's childMessages array.
 */
function appendChildToTask(task: GroupedMessage, child: GroupedMessage): void {
  if (!task.childMessages) {
    task.childMessages = [];
  }
  task.childMessages.push(child);
}

function getTaskChildren(task: GroupedMessage): GroupedMessage[] {
  if (!task.childMessages) {
    task.childMessages = [];
  }
  return task.childMessages;
}

/**
 * Merge tool-only operations into the last child assistant message of a task.
 * Returns true if merged, false if a new child should be created instead.
 */
function mergeToolsIntoLastChild(
  parentTask: GroupedMessage,
  toolOperations: ToolOperation[],
  pendingToolUses: GroupingContext["pendingToolUses"],
  parentToolUseId: string | undefined,
): boolean {
  const lastChild =
    parentTask.childMessages?.[parentTask.childMessages.length - 1];
  if (lastChild?.type !== "assistant") {
    return false;
  }
  if (!lastChild.toolOperations) {
    lastChild.toolOperations = [];
  }
  lastChild.toolOperations.push(...toolOperations);
  for (const op of toolOperations) {
    registerPendingToolUse(pendingToolUses, op, lastChild, parentToolUseId);
  }
  return true;
}

/**
 * Process assistant event that belongs to a child (sub-agent) task.
 */
function processChildAssistantEvent(
  event: AgentEvent,
  eventData: GroupingEventData,
  parentTask: GroupedMessage,
  ctx: GroupingContext,
): void {
  const contents = getMessageContents(eventData);
  const { thinkingParts, textParts, toolOperations } = parseAssistantContent(
    contents,
    event.sequenceNumber,
  );
  const hasThinking = thinkingParts.length > 0;
  const hasText = textParts.length > 0;
  const hasTools = toolOperations.length > 0;

  if (!hasThinking && !hasText && !hasTools) {
    return;
  }

  // Merge tool-only events into the last child assistant message
  if (!hasThinking && !hasText && hasTools) {
    if (
      mergeToolsIntoLastChild(
        parentTask,
        toolOperations,
        ctx.pendingToolUses,
        stringValue(eventData.parent_tool_use_id),
      )
    ) {
      return;
    }
  }

  const child: GroupedMessage = {
    type: "assistant",
    sequenceNumber: event.sequenceNumber,
    createdAt: event.createdAt,
    thinkingBlocks: hasThinking ? thinkingParts : undefined,
    textBefore: hasText ? textParts.join("\n\n") : undefined,
    toolOperations: hasTools ? toolOperations : undefined,
    eventData: event.eventData,
  };
  appendChildToTask(parentTask, child);
  for (const op of toolOperations) {
    registerPendingToolUse(
      ctx.pendingToolUses,
      op,
      child,
      stringValue(eventData.parent_tool_use_id),
    );
  }
}

function processAssistantEvent(
  event: AgentEvent,
  eventData: GroupingEventData,
  ctx: GroupingContext,
  nextSequenceNumber: number | undefined,
): void {
  // Route child events into their parent task
  const parentTask = findParentTask(eventData, ctx);
  if (parentTask) {
    processChildAssistantEvent(event, eventData, parentTask, ctx);
    return;
  }

  const contents = getMessageContents(eventData);
  const { thinkingParts, textParts, toolOperations } = parseAssistantContent(
    contents,
    event.sequenceNumber,
  );
  const hasThinking = thinkingParts.length > 0;
  const hasText = textParts.length > 0;

  // Separate TodoWrite from other tools
  const otherToolOps: ToolOperation[] = [];
  const todoWriteSnapshots: {
    operation: ToolOperation;
    todoState: TodoItem[];
  }[] = [];

  for (const op of toolOperations) {
    if (op.toolName.toLowerCase() === "todowrite") {
      const nextTodoState = processTodoWrite(op);
      if (!nextTodoState) {
        otherToolOps.push(op);
        continue;
      }
      ctx.todoState = nextTodoState;
      todoWriteSnapshots.push({
        operation: op,
        todoState: ctx.todoState,
      });
    } else {
      otherToolOps.push(op);
    }
  }

  const hasOtherTools = otherToolOps.length > 0;

  // Rule: Tools without text get appended to the previous assistant card
  if (
    !hasThinking &&
    !hasText &&
    hasOtherTools &&
    todoWriteSnapshots.length === 0
  ) {
    const lastAssistant = getLastMergeableAssistant(ctx.grouped);
    if (lastAssistant) {
      appendToolsToMessage(lastAssistant, otherToolOps, ctx.pendingToolUses);
      return;
    }
  }

  // Create assistant message for text and non-TodoWrite tools
  if (hasThinking || hasText || hasOtherTools) {
    const message: GroupedMessage = {
      type: "assistant",
      sequenceNumber: event.sequenceNumber,
      createdAt: event.createdAt,
      thinkingBlocks: hasThinking ? thinkingParts : undefined,
      textBefore: hasText ? textParts.join("\n\n") : undefined,
      toolOperations: hasOtherTools ? otherToolOps : undefined,
      eventData: event.eventData,
    };
    ctx.grouped.push(message);
    for (const op of otherToolOps) {
      registerPendingToolUse(ctx.pendingToolUses, op, message);
    }
  }

  // Create standalone todo card for each TodoWrite
  for (const [todoIndex, snapshot] of todoWriteSnapshots.entries()) {
    const todoMessage: GroupedMessage = {
      type: "todo",
      sequenceNumber: sequenceNumberWithContentOffset({
        sequenceNumber: event.sequenceNumber,
        contentIndex: todoIndex,
        contentCount: todoWriteSnapshots.length,
        nextSequenceNumber,
      }),
      createdAt: event.createdAt,
      todoState: snapshot.todoState,
      toolOperations: [snapshot.operation],
      eventData: {},
    };
    ctx.grouped.push(todoMessage);
    registerPendingToolUse(
      ctx.pendingToolUses,
      snapshot.operation,
      todoMessage,
    );
  }
}

function processUserEvent(
  event: AgentEvent,
  eventData: GroupingEventData,
  ctx: GroupingContext,
  nextSequenceNumber: number | undefined,
): void {
  // Child user events belong to a task — route orphan results there
  const parentTask = findParentTask(eventData, ctx);
  const target = parentTask ? getTaskChildren(parentTask) : ctx.grouped;

  const contents = getMessageContents(eventData);
  const toolMeta = toToolResultMeta(eventData.tool_use_result);
  const toolResults = contents.flatMap((content, contentIndex) => {
    return isRecord(content) && content.type === "tool_result"
      ? [{ content, contentIndex }]
      : [];
  });

  for (const [
    toolResultIndex,
    { content, contentIndex },
  ] of toolResults.entries()) {
    const resultContent: ToolResultContent = {
      type: "tool_result",
      content: content.content,
      is_error: content.is_error === true,
    };
    if (typeof content.tool_use_id === "string") {
      resultContent.tool_use_id = content.tool_use_id;
    }
    processToolResult({
      resultContent,
      toolMeta,
      pendingToolUses: ctx.pendingToolUses,
      parentToolUseId: stringValue(eventData.parent_tool_use_id),
      event,
      fallbackSequenceNumber: sequenceNumberWithContentOffset({
        sequenceNumber: event.sequenceNumber,
        contentIndex: toolResultIndex,
        contentCount: toolResults.length,
        nextSequenceNumber,
      }),
      fallbackToolUseIdValue: fallbackToolUseId(
        "orphan",
        event.sequenceNumber,
        contentIndex,
      ),
      grouped: target,
    });
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
  options: GroupEventsIntoMessagesOptions = {},
): GroupedMessage[] {
  const sorted = [...events].sort((a, b) => {
    return a.sequenceNumber - b.sequenceNumber;
  });

  const seen = new Map<number, SeenSequenceEvents>();
  const deduped = sorted.filter((e) => {
    const existing = seen.get(e.sequenceNumber);
    if (!existing) {
      seen.set(e.sequenceNumber, { events: [e] });
      return true;
    }

    const keys =
      existing.keys ??
      new Set(
        existing.events.map((event) => {
          return eventDedupeKey(event);
        }),
      );
    existing.keys = keys;

    const key = eventDedupeKey(e);
    if (keys.has(key)) {
      return false;
    }
    existing.events.push(e);
    keys.add(key);
    return true;
  });

  const disambiguatedEvents = disambiguateDuplicateSequenceNumbers(deduped);

  const ctx: GroupingContext = {
    grouped: [],
    pendingToolUses: new Map(),
    todoState: [],
    pendingTasks: new Map(),
    taskByToolUseId: new Map(),
  };

  const normalizedEvents = normalizeCodexEventsForGrouping(
    disambiguatedEvents,
    options,
  );

  for (const [eventIndex, event] of normalizedEvents.entries()) {
    const nextSequenceNumber = normalizedEvents[eventIndex + 1]?.sequenceNumber;
    const eventData = toGroupingEventData(event.eventData);

    if (event.eventType === "system") {
      processSystemEvent(event, ctx);
    } else if (event.eventType === "result") {
      processResultEvent(event, ctx);
    } else if (event.eventType === "assistant") {
      processAssistantEvent(event, eventData, ctx, nextSequenceNumber);
    } else if (event.eventType === "user") {
      processUserEvent(event, eventData, ctx, nextSequenceNumber);
    }
  }

  return ctx.grouped;
}

/**
 * Extract visible/searchable text from a grouped message.
 */
function getToolSearchText(operations: ToolOperation[] | undefined): string[] {
  const parts: string[] = [];
  for (const op of operations ?? []) {
    parts.push(op.toolName);
    if (op.keyParam) {
      parts.push(op.keyParam);
    }
    if (op.result?.content) {
      parts.push(op.result.content);
    }
  }
  return parts;
}

function getToolErrorSearchText(
  operations: ToolOperation[] | undefined,
): string[] {
  const parts: string[] = [];
  for (const op of operations ?? []) {
    if (op.result?.isError) {
      parts.push(op.result.content.trim() || `${op.toolName} failed`);
    }
  }
  return parts;
}

function getTodoSearchText(todos: TodoItem[] | undefined): string[] {
  return (
    todos?.flatMap((todo) => {
      return [todo.content, todo.status];
    }) ?? []
  );
}

function getChildMessageSearchText(
  childMessages: GroupedMessage[] | undefined,
): string[] {
  return (
    childMessages?.map((childMessage) => {
      return getVisibleGroupedMessageText(childMessage);
    }) ?? []
  );
}

function getSystemMessageSearchText(
  message: GroupedMessage,
  eventData: GroupingEventData,
): string[] {
  const parts: string[] = [];
  if (typeof eventData.subtype === "string" && eventData.subtype) {
    parts.push(eventData.subtype);
  }
  if (isTaskEventData(message.eventData)) {
    const description = stringValue(message.eventData.description);
    const taskSummary = stringValue(message.eventData.task_summary);
    if (description) {
      parts.push(description);
    }
    if (taskSummary) {
      parts.push(taskSummary);
    }
  }
  parts.push(...toStringList(eventData.tools));
  parts.push(...toStringList(eventData.agents));
  parts.push(
    ...toStringList(eventData.slash_commands).map((cmd) => {
      return `/${cmd}`;
    }),
  );
  return parts;
}

function getVisibleGroupedMessageText(message: GroupedMessage): string {
  const parts: string[] = [];

  parts.push(message.type);

  if (message.thinkingBlocks) {
    parts.push(...message.thinkingBlocks);
  }

  if (message.textBefore) {
    parts.push(message.textBefore);
  }

  parts.push(
    ...(message.type === "todo"
      ? getToolErrorSearchText(message.toolOperations)
      : getToolSearchText(message.toolOperations)),
  );

  if (message.textAfter) {
    parts.push(message.textAfter);
  }

  parts.push(...getTodoSearchText(message.todoState));
  parts.push(...getChildMessageSearchText(message.childMessages));

  // For system/result events, also extract from eventData
  const eventData = toGroupingEventData(message.eventData);

  if (message.type === "system") {
    parts.push(...getSystemMessageSearchText(message, eventData));
  }

  if (message.type === "result" && typeof eventData.result === "string") {
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
