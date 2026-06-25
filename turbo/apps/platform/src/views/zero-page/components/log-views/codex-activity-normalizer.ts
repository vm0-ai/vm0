import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";

interface NormalizeCodexEventsOptions {
  framework?: string | null;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexFileChange {
  kind?: string;
  path?: string;
  diff?: string;
}

interface CodexNormalizedEvent {
  event: AgentEvent | null;
  codexType?: string;
  turnId?: string;
  isTopLevelError?: boolean;
  isTerminal?: boolean;
  isTerminalFailure?: boolean;
}

const MAX_FORMATTED_ARRAY_ITEMS = 6;
const MAX_FORMATTED_ARRAY_DEPTH = 4;
const MAX_FORMATTED_OBJECT_FIELDS = 8;
const MAX_FORMATTED_OBJECT_INSPECTED_FIELDS = 16;
const MAX_FORMATTED_TEXT_LENGTH = 240;
const MAX_FORMATTED_PLAN_STEPS = 20;
const MAX_FORMATTED_FILE_CHANGES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trimmedStringValue(value: unknown): string | undefined {
  const valueString = stringValue(value)?.trim();
  return valueString && valueString.length > 0 ? valueString : undefined;
}

function nonBlankStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = trimmedStringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function getFirstNonBlankString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = nonBlankStringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function getFirstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function truncate(text: string): string {
  if (text.length <= MAX_FORMATTED_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_FORMATTED_TEXT_LENGTH - 3)}...`;
}

function formatScalar(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? truncate(value) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return truncate(String(value));
  }
  return undefined;
}

function formatUnknownValue(value: unknown, depth = 0): string | undefined {
  const scalar = formatScalar(value);
  if (scalar !== undefined) {
    return scalar;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_FORMATTED_ARRAY_DEPTH) {
      return "...";
    }
    const items = value
      .slice(0, MAX_FORMATTED_ARRAY_ITEMS)
      .map((item) => {
        return formatUnknownValue(item, depth + 1);
      })
      .filter((item): item is string => {
        return item !== undefined && item.length > 0;
      });
    if (items.length === 0) {
      return undefined;
    }
    const suffix = value.length > MAX_FORMATTED_ARRAY_ITEMS ? ", ..." : "";
    return `[${items.join(", ")}${suffix}]`;
  }

  if (!isRecord(value) || depth > 0) {
    return undefined;
  }

  const fields: string[] = [];
  let inspectedFields = 0;
  for (const key in value) {
    if (!hasOwnKey(value, key)) {
      continue;
    }
    if (
      fields.length >= MAX_FORMATTED_OBJECT_FIELDS ||
      inspectedFields >= MAX_FORMATTED_OBJECT_INSPECTED_FIELDS
    ) {
      fields.push("...");
      break;
    }
    inspectedFields += 1;
    const formatted = formatUnknownValue(value[key], depth + 1);
    if (formatted !== undefined) {
      fields.push(`${key}=${formatted}`);
    }
  }
  return fields.length > 0 ? `{${fields.join(", ")}}` : undefined;
}

function hasSignalValue(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (depth >= MAX_FORMATTED_ARRAY_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_FORMATTED_ARRAY_ITEMS).some((item) => {
      return hasSignalValue(item, depth + 1);
    });
  }
  if (!isRecord(value)) {
    return false;
  }

  let inspectedFields = 0;
  for (const key in value) {
    if (!hasOwnKey(value, key)) {
      continue;
    }
    if (inspectedFields >= MAX_FORMATTED_OBJECT_INSPECTED_FIELDS) {
      return false;
    }
    inspectedFields += 1;
    if (hasSignalValue(value[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

function formatSignalValue(value: unknown): string | undefined {
  const formatted = formatUnknownValue(value);
  if (!formatted) {
    return undefined;
  }
  return hasSignalValue(value) ? formatted : undefined;
}

function combineDistinctMessages(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  const messages: string[] = [];
  for (const message of [first, second]) {
    const trimmed = message?.trim();
    if (!trimmed) {
      continue;
    }
    const containingIndex = messages.findIndex((existing) => {
      return existing === trimmed || existing.includes(trimmed);
    });
    if (containingIndex !== -1) {
      continue;
    }

    const containedIndex = messages.findIndex((existing) => {
      return trimmed.includes(existing);
    });
    if (containedIndex !== -1) {
      messages[containedIndex] = trimmed;
      continue;
    }

    messages.push(trimmed);
  }
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function combineContentWithError(
  content: string | undefined,
  errorMessage: string | undefined,
): string | undefined {
  const contentText =
    content !== undefined && content.trim().length > 0 ? content : undefined;
  const errorText = errorMessage?.trim();

  if (!contentText) {
    return errorText && errorText.length > 0 ? errorText : undefined;
  }
  if (!errorText) {
    return contentText;
  }

  const trimmedContent = contentText.trim();
  if (trimmedContent === errorText || trimmedContent.includes(errorText)) {
    return contentText;
  }

  return contentText.endsWith("\n")
    ? `${contentText}${errorText}`
    : `${contentText}\n${errorText}`;
}

function formatDetailSuffix(details: readonly string[]): string {
  return details.length > 0 ? ` (${details.join("; ")})` : "";
}

function extractErrorMessage(value: unknown, depth = 0): string | undefined {
  if (value === null || value === undefined || value === false) {
    return undefined;
  }

  const direct = trimmedStringValue(value);
  if (direct) {
    return direct;
  }

  if (!isRecord(value)) {
    return hasSignalValue(value, depth) ? formatUnknownValue(value) : undefined;
  }

  const message =
    getFirstString(value, ["message"]) ??
    getFirstString(value, ["error", "code", "failureReason"]);
  const details = [
    getFirstString(value, ["additional_details", "additionalDetails"]),
    getFirstString(value, ["codex_error_info", "codexErrorInfo"]),
    formatSignalValue(value.connectors),
  ].filter((detail): detail is string => {
    return detail !== undefined && detail.length > 0;
  });

  if (message) {
    const uniqueDetails = details.filter((detail) => {
      return !message.includes(detail);
    });
    return `${message}${formatDetailSuffix(uniqueDetails)}`;
  }

  if (details.length > 0) {
    return details.join("; ");
  }

  if (depth >= MAX_FORMATTED_ARRAY_DEPTH) {
    return undefined;
  }

  const nested = extractErrorMessage(value.error, depth + 1);
  if (nested) {
    return nested;
  }

  return hasSignalValue(value, depth) ? formatUnknownValue(value) : undefined;
}

function extractEventErrorMessage(
  eventData: Record<string, unknown>,
): string | undefined {
  return combineDistinctMessages(
    trimmedStringValue(eventData.message),
    extractErrorMessage(eventData.error),
  );
}

function getTurnRecord(
  eventData: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(eventData.turn) ? eventData.turn : null;
}

function getTurnId(eventData: Record<string, unknown>): string | undefined {
  const topLevelId = getFirstString(eventData, ["turn_id", "turnId"]);
  if (topLevelId) {
    return topLevelId;
  }
  const turn = getTurnRecord(eventData);
  return turn ? getFirstString(turn, ["id"]) : undefined;
}

function getTurnStatus(eventData: Record<string, unknown>): string | undefined {
  const turn = getTurnRecord(eventData);
  return (
    (turn ? getFirstString(turn, ["status"]) : undefined) ??
    getFirstString(eventData, ["status"])
  );
}

function getUsage(eventData: Record<string, unknown>): CodexUsage | undefined {
  const turn = getTurnRecord(eventData);
  const value = isRecord(eventData.usage)
    ? eventData.usage
    : turn && isRecord(turn.usage)
      ? turn.usage
      : null;
  if (!value) {
    return undefined;
  }

  return {
    input_tokens: getFirstNumber(value, ["input_tokens", "inputTokens"]),
    cached_input_tokens: getFirstNumber(value, [
      "cached_input_tokens",
      "cachedInputTokens",
    ]),
    output_tokens: getFirstNumber(value, ["output_tokens", "outputTokens"]),
    reasoning_output_tokens: getFirstNumber(value, [
      "reasoning_output_tokens",
      "reasoningOutputTokens",
    ]),
  };
}

function getTurnDurationMs(eventData: Record<string, unknown>): number {
  const turn = getTurnRecord(eventData);
  return (
    (turn ? getFirstNumber(turn, ["duration_ms", "durationMs"]) : undefined) ??
    getFirstNumber(eventData, ["duration_ms", "durationMs"]) ??
    0
  );
}

function getTurnErrorMessage(
  eventData: Record<string, unknown>,
): string | undefined {
  const turn = getTurnRecord(eventData);
  const turnMessage = turn ? extractErrorMessage(turn.error) : undefined;
  const eventMessage = extractEventErrorMessage(eventData);
  return combineDistinctMessages(turnMessage, eventMessage);
}

function hasTurnCompletionError(eventData: Record<string, unknown>): boolean {
  return getTurnErrorMessage(eventData) !== undefined;
}

function isFailedStatus(status: string | undefined): boolean {
  switch (status?.toLowerCase()) {
    case "aborted":
    case "cancelled":
    case "canceled":
    case "declined":
    case "error":
    case "failed":
    case "interrupted":
    case "timed_out":
    case "timeout": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isSuccessfulTurnCompletionStatus(status: string | undefined): boolean {
  switch (status?.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isUnsuccessfulTurnCompletionStatus(
  status: string | undefined,
): boolean {
  return status !== undefined && !isSuccessfulTurnCompletionStatus(status);
}

function getItem(
  eventData: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(eventData.item) ? eventData.item : null;
}

function getItemId(item: Record<string, unknown>): string | undefined {
  return getFirstString(item, ["id"]);
}

function getItemType(item: Record<string, unknown>): string | undefined {
  return getFirstString(item, ["type"]);
}

function getItemStatus(item: Record<string, unknown>): string | undefined {
  return getFirstString(item, ["status"]);
}

function getItemErrorMessage(
  item: Record<string, unknown>,
): string | undefined {
  return extractErrorMessage(item.error);
}

function parseCodexChanges(value: unknown): CodexFileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, MAX_FORMATTED_FILE_CHANGES)
    .filter(isRecord)
    .map((change) => {
      return {
        kind: getFirstString(change, ["kind"]),
        path: getFirstString(change, ["path"]),
        diff: getFirstNonBlankString(change, ["diff"]),
      };
    });
}

function isUnambiguousCodexType(eventType: string): boolean {
  return (
    eventType === "thread.started" ||
    eventType === "turn.started" ||
    eventType === "turn.completed" ||
    eventType === "turn.failed" ||
    eventType === "turn.plan.updated" ||
    eventType.startsWith("item.")
  );
}

function isCodexType(eventType: string): boolean {
  return (
    isUnambiguousCodexType(eventType) ||
    eventType === "error" ||
    eventType === "warning"
  );
}

function getCodexType(
  event: AgentEvent,
  eventData: Record<string, unknown> | null,
  framework: string | null | undefined,
): string | undefined {
  if (isUnambiguousCodexType(event.eventType)) {
    return event.eventType;
  }

  const dataType = eventData ? trimmedStringValue(eventData.type) : undefined;
  if (dataType && isUnambiguousCodexType(dataType)) {
    return dataType;
  }

  if (framework !== "codex") {
    return undefined;
  }

  if (isCodexType(event.eventType)) {
    return event.eventType;
  }
  return dataType && isCodexType(dataType) ? dataType : undefined;
}

function makeCodexSystemEvent(
  event: AgentEvent,
  eventData: Record<string, unknown>,
  codexType: string,
): AgentEvent {
  return {
    ...event,
    eventType: "system",
    eventData: {
      subtype: "init",
      framework: "codex",
      session_id: getFirstString(eventData, ["thread_id", "threadId"]) ?? null,
      tools: [],
      agents: [],
      slash_commands: [],
      codex_event_type: codexType,
    },
  };
}

function makeCodexResultEvent(params: {
  event: AgentEvent;
  success: boolean;
  result: string;
  usage?: CodexUsage;
  durationMs?: number;
  turnId?: string;
}): AgentEvent {
  const { event, success, result, usage, durationMs = 0, turnId } = params;
  return {
    ...event,
    eventType: "result",
    eventData: {
      type: "result",
      is_error: !success,
      result,
      duration_ms: durationMs,
      num_turns: 1,
      modelUsage: usage
        ? {
            codex: {
              inputTokens: usage.input_tokens ?? null,
              outputTokens: usage.output_tokens ?? null,
            },
          }
        : undefined,
      codex_usage: usage,
      turn_id: turnId,
    },
  };
}

function makeCodexAssistantTextEvent(
  event: AgentEvent,
  text: string,
): AgentEvent {
  return {
    ...event,
    eventType: "assistant",
    eventData: {
      message: {
        content: [{ type: "text", text }],
      },
    },
  };
}

function makeCodexToolUseEvent(params: {
  event: AgentEvent;
  itemId: string;
  toolName: string;
  input: Record<string, unknown>;
}): AgentEvent {
  const { event, itemId, toolName, input } = params;
  return {
    ...event,
    eventType: "assistant",
    eventData: {
      message: {
        content: [
          {
            type: "tool_use",
            id: itemId,
            name: toolName,
            input,
          },
        ],
      },
    },
  };
}

function makeCodexToolResultEvent(params: {
  event: AgentEvent;
  itemId: string;
  content: string;
  isError?: boolean;
  durationMs?: number;
}): AgentEvent {
  const { event, itemId, content, isError = false, durationMs } = params;
  return {
    ...event,
    eventType: "user",
    eventData: {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: itemId,
            content,
            is_error: isError,
          },
        ],
      },
      tool_use_result: durationMs !== undefined ? { durationMs } : undefined,
    },
  };
}

function formatCodexFileChanges(
  changes: readonly CodexFileChange[],
  status: string | undefined,
  errorMessage: string | undefined,
  originalChangeCount: number,
): string {
  const lines: string[] = [];
  if (status && isFailedStatus(status)) {
    lines.push(`Status: ${status}`);
  }
  if (errorMessage) {
    lines.push(`Error: ${errorMessage}`);
  }
  if (changes.length === 0 && lines.length === 0) {
    return "[files] Files changed";
  }

  for (const change of changes) {
    const kind = change.kind ?? "change";
    const path = change.path ?? "unknown path";
    lines.push(`- ${kind} ${path}`);
    if (change.diff) {
      lines.push(change.diff);
    }
  }
  const remaining = originalChangeCount - changes.length;
  if (remaining > 0) {
    lines.push(`- ... +${remaining} more changes`);
  }

  return ["[files] Files changed:", ...lines].join("\n");
}

function formatPlanStatus(status: string | undefined): string {
  if (status === "completed") {
    return "completed";
  }
  if (status === "in_progress") {
    return "in progress";
  }
  if (status === "pending") {
    return "pending";
  }
  return status ?? "step";
}

function formatPlanLines(plan: unknown): string[] {
  if (!Array.isArray(plan)) {
    return [];
  }
  const lines = plan
    .slice(0, MAX_FORMATTED_PLAN_STEPS)
    .map((step) => {
      if (!isRecord(step)) {
        return undefined;
      }
      const text = trimmedStringValue(step.step);
      if (!text) {
        return undefined;
      }
      const status = formatPlanStatus(trimmedStringValue(step.status));
      return `- ${status}: ${text}`;
    })
    .filter((line): line is string => {
      return line !== undefined;
    });
  const remaining = plan.length - MAX_FORMATTED_PLAN_STEPS;
  if (remaining > 0) {
    lines.push(`- ... +${remaining} more steps`);
  }
  return lines;
}

function formatGenericCodexItem(
  eventType: string,
  item: Record<string, unknown> | null,
): string {
  if (!item) {
    return `Codex ${eventType}`;
  }

  const label = getItemType(item) ?? "item";
  const details: string[] = [];
  const status = getItemStatus(item);
  const id = getItemId(item);
  if (status) {
    details.push(`status: ${status}`);
  }
  if (id) {
    details.push(`id: ${id}`);
  }

  const readable =
    getFirstNonBlankString(item, [
      "text",
      "title",
      "name",
      "command",
      "query",
      "url",
      "path",
      "diff",
      "output",
      "aggregated_output",
    ]) ?? getItemErrorMessage(item);
  const extraFields: string[] = [];
  let inspectedFields = 0;
  for (const key in item) {
    if (!hasOwnKey(item, key)) {
      continue;
    }
    if (
      [
        "id",
        "type",
        "status",
        "text",
        "title",
        "name",
        "command",
        "query",
        "url",
        "path",
        "diff",
        "output",
        "aggregated_output",
        "error",
      ].includes(key)
    ) {
      continue;
    }
    if (
      extraFields.length >= MAX_FORMATTED_OBJECT_FIELDS ||
      inspectedFields >= MAX_FORMATTED_OBJECT_INSPECTED_FIELDS
    ) {
      extraFields.push("...");
      break;
    }
    inspectedFields += 1;
    const formatted = formatUnknownValue(item[key]);
    if (formatted !== undefined) {
      extraFields.push(`${key}: ${formatted}`);
    }
  }
  details.push(...extraFields);

  const suffix = readable ? `\n${readable}` : "";
  return `Codex ${label} (${eventType}${details.length > 0 ? `, ${details.join(", ")}` : ""})${suffix}`;
}

function normalizeCodexRunEvent(
  event: AgentEvent,
  codexType: string,
  eventData: Record<string, unknown>,
): CodexNormalizedEvent {
  const turnId = getTurnId(eventData);
  const usage = getUsage(eventData);
  const durationMs = getTurnDurationMs(eventData);

  switch (codexType) {
    case "thread.started": {
      return {
        event: makeCodexSystemEvent(event, eventData, codexType),
        codexType,
      };
    }
    case "turn.started": {
      return { event: null, codexType, turnId };
    }
    case "turn.completed": {
      const status = getTurnStatus(eventData);
      const failed =
        isUnsuccessfulTurnCompletionStatus(status) ||
        hasTurnCompletionError(eventData);
      const result = failed
        ? (getTurnErrorMessage(eventData) ??
          (status ? `Turn ${status}` : "Turn failed"))
        : "";
      return {
        event: makeCodexResultEvent({
          event,
          success: !failed,
          result,
          usage,
          durationMs,
          turnId,
        }),
        codexType,
        turnId,
        isTerminal: true,
        isTerminalFailure: failed,
      };
    }
    case "turn.failed": {
      return {
        event: makeCodexResultEvent({
          event,
          success: false,
          result: getTurnErrorMessage(eventData) ?? "Turn failed",
          usage,
          durationMs,
          turnId,
        }),
        codexType,
        turnId,
        isTerminal: true,
        isTerminalFailure: true,
      };
    }
    case "error": {
      return {
        event: makeCodexResultEvent({
          event,
          success: false,
          result: getTurnErrorMessage(eventData) ?? "Codex error",
          usage,
          durationMs,
          turnId,
        }),
        codexType,
        turnId,
        isTopLevelError: true,
      };
    }
    case "warning": {
      return {
        event: makeCodexAssistantTextEvent(
          event,
          `[warning] ${extractEventErrorMessage(eventData) ?? "Codex warning"}`,
        ),
        codexType,
        turnId,
      };
    }
    case "turn.plan.updated": {
      const lines = formatPlanLines(eventData.plan);
      const explanation = trimmedStringValue(eventData.explanation);
      const text = ["[plan]", explanation, ...lines]
        .filter((line): line is string => {
          return line !== undefined && line.length > 0;
        })
        .join("\n");
      return {
        event:
          text.trim().length > 0
            ? makeCodexAssistantTextEvent(event, text)
            : null,
        codexType,
        turnId,
      };
    }
    default: {
      return { event, codexType, turnId };
    }
  }
}

function normalizeCodexCommandEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent | null {
  const itemId = getItemId(item);
  const command = getFirstNonBlankString(item, ["command"]);
  if (!itemId) {
    return null;
  }

  if (codexType === "item.started" && command) {
    return makeCodexToolUseEvent({
      event,
      itemId,
      toolName: "Bash",
      input: { command },
    });
  }

  if (codexType === "item.completed") {
    const output =
      getFirstNonBlankString(item, ["aggregated_output", "aggregatedOutput"]) ??
      getFirstNonBlankString(item, ["output"]) ??
      "";
    const status = getItemStatus(item);
    const exitCode = numberValue(item.exit_code);
    const errorMessage = getItemErrorMessage(item);
    const isError =
      (exitCode !== undefined ? exitCode !== 0 : false) ||
      isFailedStatus(status) ||
      errorMessage !== undefined;
    return makeCodexToolResultEvent({
      event,
      itemId,
      content:
        combineContentWithError(output, errorMessage) ??
        (isFailedStatus(status) ? `Command ${status}` : ""),
      isError,
      durationMs: getFirstNumber(item, ["duration_ms", "durationMs"]),
    });
  }

  return null;
}

function normalizeCodexFileMutationEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent | null {
  const itemId = getItemId(item);
  if (!itemId) {
    return null;
  }
  const itemType = getItemType(item);
  const toolName = itemType === "file_edit" ? "Edit" : "Write";
  const path = getFirstString(item, ["path"]);

  if (codexType === "item.started" && path) {
    return makeCodexToolUseEvent({
      event,
      itemId,
      toolName,
      input: { file_path: path },
    });
  }

  if (codexType === "item.completed") {
    const status = getItemStatus(item);
    const errorMessage = getItemErrorMessage(item);
    return makeCodexToolResultEvent({
      event,
      itemId,
      content:
        combineContentWithError(
          getFirstNonBlankString(item, ["diff"]),
          errorMessage,
        ) ??
        (isFailedStatus(status)
          ? `File operation ${status}`
          : "File operation completed"),
      isError: isFailedStatus(status) || errorMessage !== undefined,
      durationMs: getFirstNumber(item, ["duration_ms", "durationMs"]),
    });
  }

  return null;
}

function normalizeCodexFileReadEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent | null {
  const itemId = getItemId(item);
  if (!itemId) {
    return null;
  }
  const path = getFirstString(item, ["path"]);

  if (codexType === "item.started" && path) {
    return makeCodexToolUseEvent({
      event,
      itemId,
      toolName: "Read",
      input: { file_path: path },
    });
  }

  if (codexType === "item.completed") {
    const status = getItemStatus(item);
    const errorMessage = getItemErrorMessage(item);
    return makeCodexToolResultEvent({
      event,
      itemId,
      content:
        combineContentWithError(
          getFirstNonBlankString(item, ["output"]),
          errorMessage,
        ) ??
        (isFailedStatus(status)
          ? `File read ${status}`
          : "File read completed"),
      isError: isFailedStatus(status) || errorMessage !== undefined,
      durationMs: getFirstNumber(item, ["duration_ms", "durationMs"]),
    });
  }

  return null;
}

function normalizeCodexTextItemEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
  prefix?: string,
): AgentEvent {
  const text = getFirstNonBlankString(item, ["text"]);
  if (text) {
    return makeCodexAssistantTextEvent(
      event,
      prefix ? `${prefix} ${text}` : text,
    );
  }
  return makeCodexAssistantTextEvent(
    event,
    formatGenericCodexItem(codexType, item),
  );
}

function normalizeCodexPlanItemEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent | null {
  const text = getFirstNonBlankString(item, ["text"]);
  if (!text && codexType !== "item.completed") {
    return null;
  }
  return makeCodexAssistantTextEvent(
    event,
    text ? `[plan]\n${text}` : formatGenericCodexItem(codexType, item),
  );
}

function normalizeCodexFileChangeEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent {
  if (codexType !== "item.completed") {
    return makeCodexAssistantTextEvent(
      event,
      formatGenericCodexItem(codexType, item),
    );
  }

  const changes = parseCodexChanges(item.changes);
  const status = getItemStatus(item);
  const errorMessage = getItemErrorMessage(item);
  const originalChangeCount = Array.isArray(item.changes)
    ? item.changes.length
    : changes.length;
  return makeCodexAssistantTextEvent(
    event,
    formatCodexFileChanges(changes, status, errorMessage, originalChangeCount),
  );
}

function normalizeGenericCodexItemEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent | null {
  if (codexType !== "item.completed") {
    return null;
  }
  return makeCodexAssistantTextEvent(
    event,
    formatGenericCodexItem(codexType, item),
  );
}

function normalizeCodexItemAgentEvent(
  event: AgentEvent,
  codexType: string,
  item: Record<string, unknown>,
): AgentEvent | null {
  const itemType = getItemType(item);
  switch (itemType) {
    case "agent_message": {
      return normalizeCodexTextItemEvent(event, codexType, item);
    }
    case "reasoning": {
      return normalizeCodexTextItemEvent(event, codexType, item, "[thinking]");
    }
    case "plan": {
      return normalizeCodexPlanItemEvent(event, codexType, item);
    }
    case "command_execution": {
      return (
        normalizeCodexCommandEvent(event, codexType, item) ??
        makeCodexAssistantTextEvent(
          event,
          formatGenericCodexItem(codexType, item),
        )
      );
    }
    case "file_edit":
    case "file_write": {
      return (
        normalizeCodexFileMutationEvent(event, codexType, item) ??
        makeCodexAssistantTextEvent(
          event,
          formatGenericCodexItem(codexType, item),
        )
      );
    }
    case "file_read": {
      return (
        normalizeCodexFileReadEvent(event, codexType, item) ??
        makeCodexAssistantTextEvent(
          event,
          formatGenericCodexItem(codexType, item),
        )
      );
    }
    case "file_change": {
      return normalizeCodexFileChangeEvent(event, codexType, item);
    }
    default: {
      return normalizeGenericCodexItemEvent(event, codexType, item);
    }
  }
}

function normalizeCodexItemEvent(
  event: AgentEvent,
  codexType: string,
  eventData: Record<string, unknown>,
): CodexNormalizedEvent {
  const item = getItem(eventData);
  const turnId = getTurnId(eventData);
  if (!item) {
    return {
      event: makeCodexAssistantTextEvent(
        event,
        formatGenericCodexItem(codexType, null),
      ),
      codexType,
      turnId,
    };
  }

  return {
    event: normalizeCodexItemAgentEvent(event, codexType, item),
    codexType,
    turnId,
  };
}

function normalizeCodexEvent(
  event: AgentEvent,
  framework: string | null | undefined,
): CodexNormalizedEvent {
  const eventData = isRecord(event.eventData) ? event.eventData : null;
  const codexType = getCodexType(event, eventData, framework);
  if (!codexType || !eventData) {
    return { event };
  }

  if (codexType.startsWith("item.")) {
    return normalizeCodexItemEvent(event, codexType, eventData);
  }

  return normalizeCodexRunEvent(event, codexType, eventData);
}

function resultText(event: AgentEvent): string | undefined {
  if (!isRecord(event.eventData)) {
    return undefined;
  }
  return trimmedStringValue(event.eventData.result);
}

function mergeFailureEvents(
  terminalEvent: AgentEvent,
  pendingErrorEvent: AgentEvent,
): AgentEvent {
  const mergedResult = combineDistinctMessages(
    resultText(pendingErrorEvent),
    resultText(terminalEvent),
  );
  if (!mergedResult || !isRecord(terminalEvent.eventData)) {
    return terminalEvent;
  }
  return {
    ...terminalEvent,
    eventData: {
      ...terminalEvent.eventData,
      result: mergedResult,
    },
  };
}

function shouldCollapseFailure(
  pendingTurnId: string | undefined,
  terminalTurnId: string | undefined,
): boolean {
  if (pendingTurnId && terminalTurnId) {
    return pendingTurnId === terminalTurnId;
  }
  return pendingTurnId === undefined && terminalTurnId === undefined;
}

function shouldKeepPendingErrorForEvent(
  pendingTurnId: string | undefined,
  eventTurnId: string | undefined,
): boolean {
  return (
    pendingTurnId !== undefined &&
    eventTurnId !== undefined &&
    pendingTurnId === eventTurnId
  );
}

export function normalizeCodexEventsForGrouping(
  events: AgentEvent[],
  options: NormalizeCodexEventsOptions = {},
): AgentEvent[] {
  const normalizedEvents: AgentEvent[] = [];
  let pendingCodexError: {
    event: AgentEvent;
    turnId: string | undefined;
  } | null = null;

  const flushPendingCodexError = () => {
    if (!pendingCodexError) {
      return;
    }
    normalizedEvents.push(pendingCodexError.event);
    pendingCodexError = null;
  };

  for (const rawEvent of events) {
    const normalized = normalizeCodexEvent(rawEvent, options.framework);

    if (!normalized.codexType) {
      flushPendingCodexError();
      if (normalized.event) {
        normalizedEvents.push(normalized.event);
      }
      continue;
    }

    if (normalized.isTopLevelError && normalized.event) {
      flushPendingCodexError();
      pendingCodexError = {
        event: normalized.event,
        turnId: normalized.turnId,
      };
      continue;
    }

    if (normalized.isTerminalFailure && normalized.event) {
      if (
        pendingCodexError &&
        shouldCollapseFailure(pendingCodexError.turnId, normalized.turnId)
      ) {
        normalizedEvents.push(
          mergeFailureEvents(normalized.event, pendingCodexError.event),
        );
        pendingCodexError = null;
        continue;
      }
      flushPendingCodexError();
      normalizedEvents.push(normalized.event);
      continue;
    }

    if (normalized.isTerminal && normalized.event) {
      flushPendingCodexError();
      normalizedEvents.push(normalized.event);
      continue;
    }

    if (normalized.event) {
      if (
        !pendingCodexError ||
        !shouldKeepPendingErrorForEvent(
          pendingCodexError.turnId,
          normalized.turnId,
        )
      ) {
        flushPendingCodexError();
      }
      normalizedEvents.push(normalized.event);
    }
  }

  flushPendingCodexError();
  return normalizedEvents.sort((a, b) => {
    return a.sequenceNumber - b.sequenceNumber;
  });
}
