/**
 * Event parser for OpenAI Codex CLI JSONL events
 * Converts raw JSONL events into simplified, user-friendly format
 *
 * Codex event types:
 * - thread.started: Session initialization
 * - turn.started/turn.completed/turn.failed/turn.plan.updated: Turn lifecycle
 * - item.started/item.updated/item.completed: Individual items (messages, commands, etc.)
 * - warning: Recoverable warnings
 * - error: Unrecoverable errors
 */

import type { ParsedEvent } from "./claude-event-parser";

interface ThreadStartedEvent {
  type: "thread.started";
  thread_id?: unknown;
}

interface TurnStartedEvent {
  type: "turn.started";
}

interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: unknown;
}

interface TurnFailedEvent {
  type: "turn.failed";
  message?: unknown;
  error?: unknown;
  turn?: unknown;
}

interface TurnPlanUpdatedEvent {
  type: "turn.plan.updated";
  explanation?: unknown;
  plan?: unknown;
}

interface ItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item?: unknown;
}

interface ErrorEvent {
  type: "error";
  message?: unknown;
  error?: unknown;
}

interface WarningEvent {
  type: "warning";
  message?: unknown;
  error?: unknown;
}

type RawCodexEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnPlanUpdatedEvent
  | ItemEvent
  | WarningEvent
  | ErrorEvent
  | Record<string, unknown>;

export class CodexEventParser {
  /**
   * Parse a raw Codex CLI JSONL event into a simplified format
   * Returns null if the event type is unknown or malformed
   */
  static parse(rawEvent: RawCodexEvent): ParsedEvent | null {
    if (!rawEvent || typeof rawEvent !== "object" || !("type" in rawEvent)) {
      return null;
    }

    const eventType = rawEvent.type;
    if (typeof eventType !== "string") {
      return null;
    }

    // Thread started = init event
    if (eventType === "thread.started") {
      return this.parseThreadStarted(rawEvent as ThreadStartedEvent);
    }

    // Turn completed = result event
    if (eventType === "turn.completed") {
      return this.parseTurnCompleted(rawEvent as TurnCompletedEvent);
    }

    // Turn failed = result event with error
    if (eventType === "turn.failed") {
      return this.parseTurnFailed(rawEvent as TurnFailedEvent);
    }

    if (eventType === "turn.plan.updated") {
      return this.parseTurnPlanUpdated(rawEvent as TurnPlanUpdatedEvent);
    }

    if (eventType === "warning") {
      return this.parseWarningEvent(rawEvent as WarningEvent);
    }

    // Item events (started, updated, completed)
    if (eventType.startsWith("item.")) {
      return this.parseItemEvent(rawEvent as ItemEvent);
    }

    // Error event
    if (eventType === "error") {
      return this.parseErrorEvent(rawEvent as ErrorEvent);
    }

    // Turn started - we skip this, not useful for display
    return null;
  }

  private static parseThreadStarted(
    event: ThreadStartedEvent,
  ): ParsedEvent | null {
    return {
      type: "init",
      timestamp: new Date(),
      data: {
        framework: "codex",
        sessionId: formatCodexString(event.thread_id) ?? "",
        tools: [],
      },
    };
  }

  private static parseTurnCompleted(
    event: TurnCompletedEvent,
  ): ParsedEvent | null {
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: true,
        result: "",
        durationMs: 0,
        numTurns: 1,
        cost: 0,
        usage: parseCodexUsage(event.usage),
      },
    };
  }

  private static parseTurnFailed(event: TurnFailedEvent): ParsedEvent | null {
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: false,
        result:
          formatCodexEventMessage(
            event.message,
            event.error,
            getCodexTurnError(event.turn),
          ) ?? "Turn failed",
        durationMs: 0,
        numTurns: 1,
        cost: 0,
        usage: {},
      },
    };
  }

  private static parseTurnPlanUpdated(
    event: TurnPlanUpdatedEvent,
  ): ParsedEvent | null {
    const text = formatCodexPlanUpdate(event.plan, event.explanation);
    if (!text) {
      return null;
    }

    return {
      type: "text",
      timestamp: new Date(),
      data: { text },
    };
  }

  private static parseItemEvent(event: ItemEvent): ParsedEvent | null {
    const item = event.item;
    if (!isRecord(item)) {
      return null;
    }

    const itemType = getStringField(item, "type");
    const text = getStringField(item, "text");

    if (itemType === "agent_message" && text) {
      return { type: "text", timestamp: new Date(), data: { text } };
    }
    if (itemType === "plan" && text) {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: `[plan] ${text}` },
      };
    }
    if (itemType === "command_execution") {
      return this.parseCommandExecution(event.type, item);
    }
    if (itemType === "file_edit" || itemType === "file_write") {
      return this.parseFileEditOrWrite(event.type, item, itemType);
    }
    if (itemType === "file_read") {
      return this.parseFileRead(event.type, item);
    }
    if (itemType === "file_change") {
      return this.parseFileChange(item);
    }
    if (itemType === "reasoning" && text) {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: `[thinking] ${text}` },
      };
    }

    return null;
  }

  private static parseCommandExecution(
    eventType: ItemEvent["type"],
    item: Record<string, unknown>,
  ): ParsedEvent | null {
    const toolUseId = getCodexItemId(item);
    if (!toolUseId) {
      return null;
    }

    const command = getStringField(item, "command");
    if (eventType === "item.started" && command) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Bash",
          toolUseId,
          input: { command },
        },
      };
    }

    if (eventType === "item.completed") {
      const output =
        getStringField(item, "aggregated_output") ??
        getStringField(item, "output") ??
        "";
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId,
          result: output,
          isError: isCodexItemError(item),
        },
      };
    }

    return null;
  }

  private static parseFileEditOrWrite(
    eventType: ItemEvent["type"],
    item: Record<string, unknown>,
    itemType: string,
  ): ParsedEvent | null {
    const toolUseId = getCodexItemId(item);
    if (!toolUseId) {
      return null;
    }

    const path = getStringField(item, "path");
    if (eventType === "item.started" && path) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: itemType === "file_edit" ? "Edit" : "Write",
          toolUseId,
          input: { file_path: path },
        },
      };
    }

    if (eventType === "item.completed") {
      const isError = isCodexItemError(item);
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId,
          result:
            getStringField(item, "diff") ??
            getStringField(item, "output") ??
            (isError ? "File operation failed" : "File operation completed"),
          isError,
        },
      };
    }

    return null;
  }

  private static parseFileRead(
    eventType: ItemEvent["type"],
    item: Record<string, unknown>,
  ): ParsedEvent | null {
    const toolUseId = getCodexItemId(item);
    if (!toolUseId) {
      return null;
    }

    const path = getStringField(item, "path");
    if (eventType === "item.started" && path) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Read",
          toolUseId,
          input: { file_path: path },
        },
      };
    }

    if (eventType === "item.completed") {
      const isError = isCodexItemError(item);
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId,
          result:
            (isError ? getStringField(item, "output") : undefined) ??
            (isError ? "File read failed" : "File read completed"),
          isError,
        },
      };
    }

    return null;
  }

  private static parseFileChange(
    item: Record<string, unknown>,
  ): ParsedEvent | null {
    const statusText = formatFileChangeStatus(getStringField(item, "status"));
    const changesValue = item.changes;
    if (!Array.isArray(changesValue)) {
      return statusText
        ? {
            type: "text",
            timestamp: new Date(),
            data: { text: `[files]\n${statusText}` },
          }
        : null;
    }

    const changes = changesValue.flatMap((change) => {
      if (!isRecord(change)) {
        return [];
      }
      const path = getStringField(change, "path")?.trim();
      if (!path) {
        return [];
      }
      const action = formatFileChangeAction(change.kind);
      return [`${action}: ${path}`];
    });
    if (changes.length === 0 && !statusText) {
      return null;
    }

    const text = ["[files]", statusText, ...changes]
      .filter((line): line is string => {
        return Boolean(line);
      })
      .join("\n");

    return {
      type: "text",
      timestamp: new Date(),
      data: { text },
    };
  }

  private static parseErrorEvent(event: ErrorEvent): ParsedEvent | null {
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: false,
        result:
          formatCodexEventMessage(event.message, event.error) ??
          "Unknown error",
        durationMs: 0,
        numTurns: 0,
        cost: 0,
        usage: {},
      },
    };
  }

  private static parseWarningEvent(event: WarningEvent): ParsedEvent | null {
    const message = formatCodexWarningMessage(event);
    if (!message) {
      return null;
    }

    return {
      type: "text",
      timestamp: new Date(),
      data: { text: `[warning] ${message}` },
    };
  }
}

function isCodexItemError(item: Record<string, unknown>): boolean {
  const status = getStringField(item, "status");
  if (status === "failed" || status === "declined") {
    return true;
  }
  const exitCode = getNumberField(item, "exit_code");
  if (status === "completed") {
    return typeof exitCode === "number" ? exitCode !== 0 : false;
  }
  return typeof exitCode === "number" ? exitCode !== 0 : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCodexItemId(item: Record<string, unknown>): string | null {
  const id = getStringField(item, "id")?.trim();
  return id || null;
}

function getStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function parseCodexUsage(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(typeof value.input_tokens === "number"
      ? { input_tokens: value.input_tokens }
      : {}),
    ...(typeof value.cached_input_tokens === "number"
      ? { cached_input_tokens: value.cached_input_tokens }
      : {}),
    ...(typeof value.output_tokens === "number"
      ? { output_tokens: value.output_tokens }
      : {}),
  };
}

function formatFileChangeAction(kind: unknown): string {
  switch (kind) {
    case "add":
      return "Created";
    case "modify":
      return "Modified";
    case "delete":
      return "Deleted";
    default:
      return "Changed";
  }
}

function formatFileChangeStatus(status: string | undefined): string | null {
  switch (status) {
    case "failed":
      return "File changes failed";
    case "declined":
      return "File changes declined";
    default:
      return null;
  }
}

function formatCodexWarningMessage(event: WarningEvent): string | null {
  return formatCodexEventMessage(event.message, event.error);
}

function formatCodexEventMessage(
  message: unknown,
  error: unknown,
  fallbackError?: unknown,
): string | null {
  const messageText = formatCodexString(message);
  const errorText = formatCodexErrorMessage(error);
  const fallbackErrorText = formatCodexErrorMessage(fallbackError);

  const result = selectCodexEventMessage(messageText, errorText);
  if (!result) {
    return fallbackErrorText;
  }
  if (fallbackErrorText && isGenericCodexFailureMessage(result)) {
    return fallbackErrorText;
  }

  return result;
}

function selectCodexEventMessage(
  messageText: string | null,
  errorText: string | null,
): string | null {
  if (!messageText) {
    return errorText;
  }
  if (!errorText) {
    return messageText;
  }
  if (
    errorText === messageText ||
    errorText.startsWith(`${messageText} (`) ||
    isGenericCodexFailureMessage(messageText)
  ) {
    return errorText;
  }

  return messageText;
}

function getCodexTurnError(turn: unknown): unknown {
  if (!isRecord(turn)) {
    return undefined;
  }
  return turn.error;
}

function formatCodexString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() || null;
}

function formatCodexErrorMessage(error: unknown): string | null {
  if (typeof error === "string") {
    return error.trim() || null;
  }
  if (!isRecord(error)) {
    return null;
  }

  const message = getStringField(error, "message")?.trim();
  const details =
    getStringField(error, "additional_details")?.trim() ??
    getStringField(error, "additionalDetails")?.trim();

  if (message && details) {
    return `${message} (${details})`;
  }

  return message || details || null;
}

function isGenericCodexFailureMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "turn failed" ||
    normalized === "turn interrupted" ||
    normalized === "unknown error" ||
    normalized === "codex error" ||
    normalized === "error"
  );
}

function formatCodexPlanUpdate(
  plan: unknown,
  explanation: unknown,
): string | null {
  const explanationText =
    typeof explanation === "string" ? explanation.trim() : "";
  const header = explanationText ? `[plan] ${explanationText}` : "[plan]";
  const steps = Array.isArray(plan)
    ? plan.flatMap((step) => {
        if (!isRecord(step)) {
          return [];
        }
        const text = getStringField(step, "step")?.trim();
        if (!text) {
          return [];
        }
        return [`- [${formatCodexPlanStatus(step.status)}] ${text}`];
      })
    : [];

  if (steps.length === 0 && !explanationText) {
    return null;
  }

  return [header, ...steps].join("\n");
}

function formatCodexPlanStatus(status: unknown): string {
  switch (status) {
    case "completed":
    case "pending":
      return status;
    case "inProgress":
    case "in_progress":
      return "in progress";
    default:
      return typeof status === "string"
        ? status.trim() || "unknown"
        : "unknown";
  }
}
