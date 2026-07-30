import type { AgentEvent } from "../zero-page/log-types.ts";
import { i18n } from "../../i18n/index.ts";
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
const MAX_DEDUPE_DEPTH = 64;
const MAX_DEDUPE_VALUES = 20_000;
const MAX_DEDUPE_STRING_LENGTH = 1_000_000;

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
        i18n.t(
          ($) => {
            return $.activity.events.moreItems;
          },
          { count: value.length - MAX_STRINGIFY_ARRAY_ITEMS },
        ),
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
      entries.push(
        `${quoteJsonString("...")}:${quoteJsonString(
          i18n.t(($) => {
            return $.activity.events.truncated;
          }),
        )}`,
      );
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

interface DedupeStringifyState {
  seen: WeakSet<object>;
  valueCount: number;
}

function stringifyDedupePrimitive(value: unknown): string | null | undefined {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    if (value.length > MAX_DEDUPE_STRING_LENGTH) {
      return null;
    }
    return `string:${JSON.stringify(value)}`;
  }
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "boolean") {
    return `boolean:${String(value)}`;
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return null;
  }
  return undefined;
}

function stringifyDedupeArrayValue(
  value: unknown[],
  state: DedupeStringifyState,
  depth: number,
): string | null {
  if (value.length > MAX_DEDUPE_VALUES) {
    return null;
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      items.push("[Hole]");
      continue;
    }
    if (!("value" in descriptor)) {
      return null;
    }
    const serialized = stringifyDedupeValue(descriptor.value, state, depth + 1);
    if (serialized === null) {
      return null;
    }
    items.push(serialized);
  }
  return `array:[${items.join(",")}]`;
}

function stringifyDedupeObjectValue(
  value: object,
  state: DedupeStringifyState,
  depth: number,
): string | null {
  const keys = Object.keys(value);
  if (keys.length > MAX_DEDUPE_VALUES) {
    return null;
  }
  const entries: string[] = [];
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      return null;
    }
    const serialized = stringifyDedupeValue(descriptor.value, state, depth + 1);
    if (serialized === null) {
      return null;
    }
    entries.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `object:{${entries.join(",")}}`;
}

function stringifyDedupeValue(
  value: unknown,
  state: DedupeStringifyState,
  depth = 0,
): string | null {
  state.valueCount += 1;
  if (state.valueCount > MAX_DEDUPE_VALUES || depth > MAX_DEDUPE_DEPTH) {
    return null;
  }
  const primitive = stringifyDedupePrimitive(value);
  if (primitive !== undefined) {
    return primitive;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (state.seen.has(value)) {
    return null;
  }
  if (value instanceof Date) {
    return `date:${Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date"}`;
  }

  state.seen.add(value);
  const serialized = Array.isArray(value)
    ? stringifyDedupeArrayValue(value, state, depth)
    : stringifyDedupeObjectValue(value, state, depth);
  state.seen.delete(value);
  return serialized;
}

function eventDedupeKey(event: AgentEvent): string | null {
  return stringifyDedupeValue(event, {
    seen: new WeakSet(),
    valueCount: 0,
  });
}

function eventDedupeKeys(events: AgentEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    const key = eventDedupeKey(event);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

// ============ EVENT GROUP TYPES ============

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

export interface EventGroup {
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
  // For task system events: child groups from sub-agent
  childGroups?: EventGroup[];
}

export function eventGroupKey(group: EventGroup): string {
  return `${group.type}-${group.sequenceNumber}-${group.createdAt}`;
}

interface GroupEventsIntoGroupsOptions {
  framework?: string | null;
}

/**
 * Returns true if an event group should be shown.
 *
 * Claude Code emits a result event that repeats the final assistant text, so
 * Text-only assistant groups immediately before a non-empty result are
 * hidden. Other frameworks keep the assistant group as-is.
 */
function isVisibleEventGroup(
  group: EventGroup,
  nextGroup: EventGroup | undefined,
  framework?: string | null,
): boolean {
  if (group.type !== "assistant") {
    return true;
  }
  if (!nextGroup || nextGroup.type !== "result") {
    return true;
  }
  if (framework !== "claude-code") {
    return true;
  }
  const result = isRecord(nextGroup.eventData)
    ? nextGroup.eventData.result
    : undefined;
  if (typeof result !== "string" || result.trim().length === 0) {
    return true;
  }
  return (
    (group.thinkingBlocks?.length ?? 0) > 0 ||
    (group.toolOperations?.length ?? 0) > 0
  );
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
  group: EventGroup;
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
  const subtype = stringValue(data.subtype);
  const status = stringValue(data.status);
  const summary = stringValue(data.summary);
  const notificationStatus =
    subtype === "task_notification" ? status : undefined;
  const notificationSummary =
    subtype === "task_notification" ? summary : undefined;
  return {
    task_id: data.task_id,
    subtype,
    tool_use_id: stringValue(data.tool_use_id),
    description: stringValue(data.description),
    status,
    summary,
    task_status: stringValue(data.task_status) ?? notificationStatus,
    task_summary: stringValue(data.task_summary) ?? notificationSummary,
    task_completed_at: stringValue(data.task_completed_at),
  };
}

function toGroupingEventData(data: unknown): GroupingEventData {
  return isRecord(data) ? (data as GroupingEventData) : {};
}

function getEventContents(eventData: GroupingEventData): unknown[] {
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
  group: EventGroup,
  parentToolUseId?: string,
): void {
  const pending = pendingToolUses.get(operation.toolUseId) ?? [];
  pending.push({ operation, group, parentToolUseId });
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
  grouped: EventGroup[];
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

  // Orphan tool_result - create standalone group
  grouped.push({
    type: "assistant",
    sequenceNumber: fallbackSequenceNumber,
    createdAt: event.createdAt,
    toolOperations: [
      {
        toolUseId: toolUseId ?? fallbackToolUseIdValue,
        toolName: i18n.t(($) => {
          return $.activity.events.unknownTool;
        }),
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
 * Check if the last event group is an assistant group that can be merged.
 * Returns the group if mergeable, null otherwise.
 */
function getLastMergeableAssistant(grouped: EventGroup[]): EventGroup | null {
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
 * Append tool operations to an existing assistant group and register them as pending.
 */
function appendToolsToGroup(
  group: EventGroup,
  toolOperations: ToolOperation[],
  pendingToolUses: Map<string, PendingToolUse[]>,
  parentToolUseId?: string,
): void {
  if (!group.toolOperations) {
    group.toolOperations = [];
  }
  group.toolOperations.push(...toolOperations);
  for (const op of toolOperations) {
    registerPendingToolUse(pendingToolUses, op, group, parentToolUseId);
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
  grouped: EventGroup[];
  pendingToolUses: Map<string, PendingToolUse[]>;
  todoState: TodoItem[];
  pendingTasks: Map<string, EventGroup>;
  // Map from tool_use_id (that spawned the task) → task EventGroup
  // Used to route child events via parent_tool_use_id
  taskByToolUseId: Map<string, EventGroup>;
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
    const group: EventGroup = {
      type: "system",
      sequenceNumber: event.sequenceNumber,
      createdAt: event.createdAt,
      eventData: taskData,
    };
    ctx.grouped.push(group);
    ctx.pendingTasks.set(taskId, group);
    if (taskData.tool_use_id) {
      ctx.taskByToolUseId.set(taskData.tool_use_id, group);
    }
    return;
  }

  if (subtype === "task_notification") {
    const pending = ctx.pendingTasks.get(taskId);
    if (pending) {
      // Merge notification into the existing task_started group
      const existingData = pending.eventData as TaskEventData;
      existingData.task_status = taskData.task_status;
      existingData.task_summary = taskData.task_summary;
      existingData.task_completed_at = event.createdAt;
      ctx.pendingTasks.delete(taskId);
      return;
    }
    // Orphan notification (no matching task_started) — fall through to standalone
  }

  // task_progress is a heartbeat signal. Ignore it even if it arrives late
  // after the matching task_notification closed the pending task.
  if (subtype === "task_progress") {
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
 * Returns the task EventGroup if found, null otherwise.
 */
function findParentTask(
  eventData: GroupingEventData,
  ctx: GroupingContext,
): EventGroup | null {
  const parentId = stringValue(eventData.parent_tool_use_id);
  if (!parentId) {
    return null;
  }
  return ctx.taskByToolUseId.get(parentId) ?? null;
}

/**
 * Append a child group to a task's childGroups array.
 */
function appendChildToTask(task: EventGroup, child: EventGroup): void {
  if (!task.childGroups) {
    task.childGroups = [];
  }
  task.childGroups.push(child);
}

function getTaskChildren(task: EventGroup): EventGroup[] {
  if (!task.childGroups) {
    task.childGroups = [];
  }
  return task.childGroups;
}

/**
 * Merge tool-only operations into the last child assistant group of a task.
 * Returns true if merged, false if a new child should be created instead.
 */
function mergeToolsIntoLastChild(
  parentTask: EventGroup,
  toolOperations: ToolOperation[],
  pendingToolUses: GroupingContext["pendingToolUses"],
  parentToolUseId: string | undefined,
): boolean {
  const lastChild = parentTask.childGroups?.[parentTask.childGroups.length - 1];
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
  parentTask: EventGroup,
  ctx: GroupingContext,
): void {
  const contents = getEventContents(eventData);
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

  // Merge tool-only events into the last child assistant group
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

  const child: EventGroup = {
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

  const contents = getEventContents(eventData);
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
      appendToolsToGroup(lastAssistant, otherToolOps, ctx.pendingToolUses);
      return;
    }
  }

  // Create assistant group for text and non-TodoWrite tools
  if (hasThinking || hasText || hasOtherTools) {
    const group: EventGroup = {
      type: "assistant",
      sequenceNumber: event.sequenceNumber,
      createdAt: event.createdAt,
      thinkingBlocks: hasThinking ? thinkingParts : undefined,
      textBefore: hasText ? textParts.join("\n\n") : undefined,
      toolOperations: hasOtherTools ? otherToolOps : undefined,
      eventData: event.eventData,
    };
    ctx.grouped.push(group);
    for (const op of otherToolOps) {
      registerPendingToolUse(ctx.pendingToolUses, op, group);
    }
  }

  // Create standalone todo card for each TodoWrite
  for (const [todoIndex, snapshot] of todoWriteSnapshots.entries()) {
    const todoGroup: EventGroup = {
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
    ctx.grouped.push(todoGroup);
    registerPendingToolUse(ctx.pendingToolUses, snapshot.operation, todoGroup);
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

  const contents = getEventContents(eventData);
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
 * Groups flat event array into group-centric structure.
 * - Consecutive assistant groups are merged (text + tools in one card)
 * - Tool results are linked to their tool_use calls
 * - TodoWrite operations create standalone "todo" type cards
 * - System and Result events remain independent
 */
export function groupEventsIntoGroups(
  events: AgentEvent[],
  options: GroupEventsIntoGroupsOptions = {},
): EventGroup[] {
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

    const keys = existing.keys ?? eventDedupeKeys(existing.events);
    existing.keys = keys;

    const key = eventDedupeKey(e);
    if (key && keys.has(key)) {
      return false;
    }
    existing.events.push(e);
    if (key) {
      keys.add(key);
    }
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

export function groupVisibleGroups(
  events: AgentEvent[],
  options: GroupEventsIntoGroupsOptions = {},
): EventGroup[] {
  const allGroups = groupEventsIntoGroups(events, options);
  return allGroups.filter((group, index) => {
    return isVisibleEventGroup(group, allGroups[index + 1], options.framework);
  });
}

/**
 * Extract visible/searchable text from an event group.
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

function getChildGroupSearchText(
  childGroups: EventGroup[] | undefined,
): string[] {
  return (
    childGroups?.map((childGroup) => {
      return getVisibleEventGroupText(childGroup);
    }) ?? []
  );
}

function getSystemGroupSearchText(
  group: EventGroup,
  eventData: GroupingEventData,
): string[] {
  const parts: string[] = [];
  if (typeof eventData.subtype === "string" && eventData.subtype) {
    parts.push(eventData.subtype);
  }
  if (isTaskEventData(group.eventData)) {
    const description = stringValue(group.eventData.description);
    const taskSummary = stringValue(group.eventData.task_summary);
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

function getVisibleEventGroupText(group: EventGroup): string {
  const parts: string[] = [];

  parts.push(group.type);

  if (group.thinkingBlocks) {
    parts.push(...group.thinkingBlocks);
  }

  if (group.textBefore) {
    parts.push(group.textBefore);
  }

  parts.push(
    ...(group.type === "todo"
      ? getToolErrorSearchText(group.toolOperations)
      : getToolSearchText(group.toolOperations)),
  );

  if (group.textAfter) {
    parts.push(group.textAfter);
  }

  parts.push(...getTodoSearchText(group.todoState));
  parts.push(...getChildGroupSearchText(group.childGroups));

  // For system/result events, also extract from eventData
  const eventData = toGroupingEventData(group.eventData);

  if (group.type === "system") {
    parts.push(...getSystemGroupSearchText(group, eventData));
  }

  if (group.type === "result" && typeof eventData.result === "string") {
    parts.push(eventData.result);
  }

  return parts.join(" ");
}

/**
 * Check if an event group matches the search term.
 */
export function eventGroupMatchesSearch(
  group: EventGroup,
  searchTerm: string,
): boolean {
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  if (!normalizedSearchTerm) {
    return true;
  }
  const visibleText = getVisibleEventGroupText(group).toLowerCase();
  return visibleText.includes(normalizedSearchTerm);
}
