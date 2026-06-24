/**
 * Event parser for OpenAI Codex CLI JSONL events.
 *
 * The parser accepts both legacy `codex exec --json` events and the
 * Codex-style compatibility events produced by the vm0 guest-agent app-server
 * adapter. It deliberately does not consume raw app-server JSON-RPC
 * notifications.
 */

import type { ParsedEvent } from "./claude-event-parser";

type JsonRecord = Record<string, unknown>;

const MAX_FORMATTED_ARRAY_ITEMS = 6;
const MAX_FORMATTED_OBJECT_FIELDS = 8;
const MAX_FORMATTED_TEXT_LENGTH = 240;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyStringValue(value: unknown): string | undefined {
  const valueString = stringValue(value);
  return valueString && valueString.length > 0 ? valueString : undefined;
}

function trimmedStringValue(value: unknown): string | undefined {
  const valueString = stringValue(value)?.trim();
  return valueString && valueString.length > 0 ? valueString : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getFirstString(
  record: JsonRecord,
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

function getFirstNumber(
  record: JsonRecord,
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
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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

  const record = asRecord(value);
  if (!record || depth > 0) {
    return undefined;
  }

  const fields: string[] = [];
  for (const [key, fieldValue] of Object.entries(record)) {
    if (fields.length >= MAX_FORMATTED_OBJECT_FIELDS) {
      fields.push("...");
      break;
    }
    const formatted = formatUnknownValue(fieldValue, depth + 1);
    if (formatted !== undefined) {
      fields.push(`${key}=${formatted}`);
    }
  }
  return fields.length > 0 ? `{${fields.join(", ")}}` : undefined;
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
    if (
      messages.some((existing) => {
        return existing === trimmed || existing.includes(trimmed);
      })
    ) {
      continue;
    }
    messages.push(trimmed);
  }
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function formatDetailSuffix(details: readonly string[]): string {
  return details.length > 0 ? ` (${details.join("; ")})` : "";
}

function extractErrorMessage(value: unknown): string | undefined {
  if (value === null || value === undefined || value === false) {
    return undefined;
  }

  const direct = trimmedStringValue(value);
  if (direct) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return formatUnknownValue(value);
  }

  const message =
    getFirstString(record, ["message"]) ??
    getFirstString(record, ["error", "code", "failureReason"]);
  const details = [
    getFirstString(record, ["additional_details", "additionalDetails"]),
    getFirstString(record, ["codex_error_info", "codexErrorInfo"]),
    formatUnknownValue(record.connectors),
  ].filter((detail): detail is string => {
    return detail !== undefined && detail.length > 0;
  });

  if (message) {
    const uniqueDetails = details.filter((detail) => {
      return !message.includes(detail);
    });
    return `${message}${formatDetailSuffix(uniqueDetails)}`;
  }

  const nested = extractErrorMessage(record.error);
  if (nested) {
    return nested;
  }

  return formatUnknownValue(record);
}

function extractEventErrorMessage(event: JsonRecord): string | undefined {
  return combineDistinctMessages(
    trimmedStringValue(event.message),
    extractErrorMessage(event.error),
  );
}

function getTurnRecord(event: JsonRecord): JsonRecord | null {
  return asRecord(event.turn);
}

function getTurnId(event: JsonRecord): string | undefined {
  const topLevelId = getFirstString(event, ["turn_id", "turnId"]);
  if (topLevelId) {
    return topLevelId;
  }
  const turn = getTurnRecord(event);
  return turn ? getFirstString(turn, ["id"]) : undefined;
}

function getTurnStatus(event: JsonRecord): string | undefined {
  const turn = getTurnRecord(event);
  return (
    (turn ? getFirstString(turn, ["status"]) : undefined) ??
    getFirstString(event, ["status"])
  );
}

const FAILED_STATUSES = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "declined",
  "error",
  "failed",
  "interrupted",
  "timed_out",
  "timeout",
]);

const SUCCESSFUL_TURN_COMPLETION_STATUSES = new Set([
  "completed",
  "success",
  "succeeded",
]);

function isFailedStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED_STATUSES.has(status.toLowerCase());
}

function isUnsuccessfulTurnCompletionStatus(
  status: string | undefined,
): boolean {
  return (
    status !== undefined &&
    !SUCCESSFUL_TURN_COMPLETION_STATUSES.has(status.toLowerCase())
  );
}

function hasExtractableError(value: unknown): boolean {
  return extractErrorMessage(value) !== undefined;
}

function hasTurnCompletionError(
  event: JsonRecord,
  turn: JsonRecord | null,
): boolean {
  return (
    (turn !== null && hasExtractableError(turn.error)) ||
    hasExtractableError(event.error)
  );
}

function getTurnCompletionErrorMessage(
  event: JsonRecord,
  turn: JsonRecord | null,
): string | undefined {
  return combineDistinctMessages(
    turn !== null ? extractErrorMessage(turn.error) : undefined,
    extractEventErrorMessage(event),
  );
}

function getUsage(event: JsonRecord): JsonRecord {
  const turn = getTurnRecord(event);
  return asRecord(event.usage) ?? (turn ? asRecord(turn.usage) : null) ?? {};
}

function getItem(event: JsonRecord): JsonRecord | null {
  return asRecord(event.item);
}

function getItemId(item: JsonRecord): string | undefined {
  return getFirstString(item, ["id"]);
}

function getItemType(item: JsonRecord): string | undefined {
  return getFirstString(item, ["type"]);
}

function getItemStatus(item: JsonRecord): string | undefined {
  return getFirstString(item, ["status"]);
}

function formatPlanStatus(status: string | undefined): string {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in progress";
  if (status === "pending") return "pending";
  return status ?? "step";
}

function formatPlanLines(plan: unknown): string[] {
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan
    .map((step) => {
      const stepRecord = asRecord(step);
      if (!stepRecord) {
        return undefined;
      }
      const text = trimmedStringValue(stepRecord.step);
      if (!text) {
        return undefined;
      }
      const status = formatPlanStatus(trimmedStringValue(stepRecord.status));
      return `- ${status}: ${text}`;
    })
    .filter((line): line is string => {
      return line !== undefined;
    });
}

function formatGenericItem(item: JsonRecord): string | undefined {
  const itemType = getItemType(item);
  if (!itemType) {
    return undefined;
  }

  const fields: string[] = [itemType];
  const id = getItemId(item);
  if (id) {
    fields.push(`id=${id}`);
  }
  const status = getItemStatus(item);
  if (status) {
    fields.push(`status=${status}`);
  }

  for (const [key, value] of Object.entries(item)) {
    if (key === "id" || key === "type" || key === "status") {
      continue;
    }
    if (fields.length >= MAX_FORMATTED_OBJECT_FIELDS + 3) {
      fields.push("...");
      break;
    }
    const formatted = formatUnknownValue(value);
    if (formatted !== undefined) {
      fields.push(`${key}=${formatted}`);
    }
  }

  return `[item] ${fields.join(" ")}`;
}

function formatFileChangeAction(kind: string | undefined): string {
  if (kind === "add") return "Created";
  if (kind === "modify") return "Modified";
  if (kind === "delete") return "Deleted";
  return "Changed";
}

export class CodexEventParser {
  /**
   * Parse a raw Codex JSONL event into the shared CLI parsed-event format.
   * Returns null if the event type is unknown or too malformed to display.
   */
  static parse(rawEvent: unknown): ParsedEvent | null {
    const event = asRecord(rawEvent);
    if (!event) {
      return null;
    }

    const eventType = stringValue(event.type);
    if (!eventType) {
      return null;
    }

    if (eventType === "thread.started") {
      return this.parseThreadStarted(event);
    }

    if (eventType === "turn.completed") {
      return this.parseTurnCompleted(event);
    }

    if (eventType === "turn.failed") {
      return this.parseTurnFailed(event);
    }

    if (eventType === "turn.plan.updated") {
      return this.parseTurnPlanUpdated(event);
    }

    if (eventType === "warning") {
      return this.parseWarning(event);
    }

    if (eventType.startsWith("item.")) {
      return this.parseItemEvent(event, eventType);
    }

    if (eventType === "error") {
      return this.parseErrorEvent(event);
    }

    return null;
  }

  private static parseThreadStarted(event: JsonRecord): ParsedEvent | null {
    const threadId = getFirstString(event, ["thread_id", "threadId"]);
    if (!threadId) {
      return null;
    }

    return {
      type: "init",
      timestamp: new Date(),
      data: {
        framework: "codex",
        sessionId: threadId,
        tools: [],
      },
    };
  }

  private static parseTurnCompleted(event: JsonRecord): ParsedEvent | null {
    const status = getTurnStatus(event);
    const turn = getTurnRecord(event);
    const turnId = getTurnId(event);
    const durationMs =
      (turn
        ? getFirstNumber(turn, ["duration_ms", "durationMs"])
        : undefined) ??
      getFirstNumber(event, ["duration_ms", "durationMs"]) ??
      0;

    if (
      isUnsuccessfulTurnCompletionStatus(status) ||
      hasTurnCompletionError(event, turn)
    ) {
      const result =
        getTurnCompletionErrorMessage(event, turn) ??
        (status ? `Turn ${status}` : "Turn failed");
      return {
        type: "result",
        timestamp: new Date(),
        data: {
          success: false,
          result,
          durationMs,
          numTurns: 1,
          cost: 0,
          usage: getUsage(event),
          ...(turnId ? { turnId } : {}),
        },
      };
    }

    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: true,
        result: "",
        durationMs,
        numTurns: 1,
        cost: 0,
        usage: getUsage(event),
        ...(turnId ? { turnId } : {}),
      },
    };
  }

  private static parseTurnFailed(event: JsonRecord): ParsedEvent | null {
    const turnId = getTurnId(event);
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: false,
        result: extractEventErrorMessage(event) ?? "Turn failed",
        durationMs: 0,
        numTurns: 1,
        cost: 0,
        usage: {},
        ...(turnId ? { turnId } : {}),
      },
    };
  }

  private static parseTurnPlanUpdated(event: JsonRecord): ParsedEvent | null {
    const lines = formatPlanLines(event.plan);
    const explanation = trimmedStringValue(event.explanation);
    if (lines.length === 0 && !explanation) {
      return null;
    }

    return {
      type: "text",
      timestamp: new Date(),
      data: {
        text: ["[plan]", explanation, ...lines]
          .filter((line): line is string => {
            return line !== undefined && line.length > 0;
          })
          .join("\n"),
      },
    };
  }

  private static parseWarning(event: JsonRecord): ParsedEvent | null {
    const message = extractEventErrorMessage(event);
    if (!message) {
      return null;
    }

    return {
      type: "text",
      timestamp: new Date(),
      data: { text: `[warning] ${message}` },
    };
  }

  private static parseItemEvent(
    event: JsonRecord,
    eventType: string,
  ): ParsedEvent | null {
    const item = getItem(event);
    if (!item) {
      return null;
    }

    const itemType = getItemType(item);
    if (!itemType) {
      return null;
    }

    if (itemType === "agent_message") {
      const text = trimmedStringValue(item.text);
      return text
        ? { type: "text", timestamp: new Date(), data: { text } }
        : null;
    }
    if (itemType === "command_execution") {
      return this.parseCommandExecution(eventType, item);
    }
    if (itemType === "file_edit" || itemType === "file_write") {
      return this.parseFileEditOrWrite(eventType, item);
    }
    if (itemType === "file_read") {
      return this.parseFileRead(eventType, item);
    }
    if (itemType === "file_change") {
      return this.parseFileChange(item);
    }
    if (itemType === "reasoning") {
      const text = trimmedStringValue(item.text);
      return text
        ? {
            type: "text",
            timestamp: new Date(),
            data: { text: `[thinking] ${text}` },
          }
        : null;
    }
    if (itemType === "plan") {
      const text = trimmedStringValue(item.text);
      return text
        ? {
            type: "text",
            timestamp: new Date(),
            data: { text: `[plan]\n${text}` },
          }
        : null;
    }

    if (eventType === "item.completed") {
      const text = formatGenericItem(item);
      return text
        ? { type: "text", timestamp: new Date(), data: { text } }
        : null;
    }

    return null;
  }

  private static parseCommandExecution(
    eventType: string,
    item: JsonRecord,
  ): ParsedEvent | null {
    const itemId = getItemId(item);
    const command = trimmedStringValue(item.command);
    if (!itemId) {
      return null;
    }

    if (eventType === "item.started" && command) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Bash",
          toolUseId: itemId,
          input: { command },
        },
      };
    }

    if (eventType === "item.completed") {
      const output =
        nonEmptyStringValue(item.aggregated_output) ??
        nonEmptyStringValue(item.output) ??
        "";
      const status = getItemStatus(item);
      const exitCode = numberValue(item.exit_code);
      const isError = exitCode !== undefined ? exitCode !== 0 : false;
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          tool: "Bash",
          toolUseId: itemId,
          input: command ? { command } : {},
          result: output || (isFailedStatus(status) ? `Command ${status}` : ""),
          isError: isError || isFailedStatus(status),
        },
      };
    }

    return null;
  }

  private static parseFileEditOrWrite(
    eventType: string,
    item: JsonRecord,
  ): ParsedEvent | null {
    const itemId = getItemId(item);
    const path = trimmedStringValue(item.path);
    if (!itemId) {
      return null;
    }

    if (eventType === "item.started" && path) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: getItemType(item) === "file_edit" ? "Edit" : "Write",
          toolUseId: itemId,
          input: { file_path: path },
        },
      };
    }

    if (eventType === "item.completed") {
      const status = getItemStatus(item);
      const tool = getItemType(item) === "file_edit" ? "Edit" : "Write";
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          tool,
          toolUseId: itemId,
          input: path ? { file_path: path } : {},
          result:
            nonEmptyStringValue(item.diff) ??
            (isFailedStatus(status)
              ? `File operation ${status}`
              : "File operation completed"),
          isError: isFailedStatus(status),
        },
      };
    }

    return null;
  }

  private static parseFileRead(
    eventType: string,
    item: JsonRecord,
  ): ParsedEvent | null {
    const itemId = getItemId(item);
    const path = trimmedStringValue(item.path);
    if (!itemId) {
      return null;
    }

    if (eventType === "item.started" && path) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Read",
          toolUseId: itemId,
          input: { file_path: path },
        },
      };
    }

    if (eventType === "item.completed") {
      const status = getItemStatus(item);
      const output = nonEmptyStringValue(item.output);
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          tool: "Read",
          toolUseId: itemId,
          input: path ? { file_path: path } : {},
          result:
            output ??
            (isFailedStatus(status)
              ? `File read ${status}`
              : "File read completed"),
          isError: isFailedStatus(status),
        },
      };
    }

    return null;
  }

  private static parseFileChange(item: JsonRecord): ParsedEvent | null {
    const status = getItemStatus(item);
    const lines = Array.isArray(item.changes)
      ? item.changes
          .map((change) => {
            const changeRecord = asRecord(change);
            if (!changeRecord) {
              return undefined;
            }
            const path = trimmedStringValue(changeRecord.path);
            if (!path) {
              return undefined;
            }
            const action = formatFileChangeAction(
              trimmedStringValue(changeRecord.kind),
            );
            return `${action}: ${path}`;
          })
          .filter((line): line is string => {
            return line !== undefined;
          })
      : [];

    if (lines.length === 0 && !isFailedStatus(status)) {
      return null;
    }

    const statusLine = isFailedStatus(status) ? `Status: ${status}` : undefined;
    return {
      type: "text",
      timestamp: new Date(),
      data: {
        text: ["[files]", statusLine, ...lines]
          .filter((line): line is string => {
            return line !== undefined && line.length > 0;
          })
          .join("\n"),
      },
    };
  }

  private static parseErrorEvent(event: JsonRecord): ParsedEvent | null {
    const turnId = getTurnId(event);
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: false,
        result: extractEventErrorMessage(event) ?? "Unknown error",
        durationMs: 0,
        numTurns: 0,
        cost: 0,
        usage: {},
        ...(turnId ? { turnId } : {}),
      },
    };
  }
}
