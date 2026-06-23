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
  thread_id: string;
}

interface TurnStartedEvent {
  type: "turn.started";
}

interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface TurnFailedEvent {
  type: "turn.failed";
  error?: string;
}

interface TurnPlanUpdatedEvent {
  type: "turn.plan.updated";
  explanation?: unknown;
  plan?: unknown;
}

interface FileChange {
  kind: "add" | "modify" | "delete";
  path: string;
}

interface CodexItem {
  id: string;
  type: string;
  status?: string;
  // For command_execution
  command?: string;
  exit_code?: number;
  output?: string;
  aggregated_output?: string;
  // For agent_message, plan, and reasoning
  text?: string;
  // For file operations
  path?: string;
  diff?: string;
  // For file_change
  changes?: FileChange[];
  // For reasoning (text field is used)
}

interface ItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item: CodexItem;
}

interface ErrorEvent {
  type: "error";
  message?: string;
  error?: string;
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
        sessionId: event.thread_id,
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
        usage: event.usage || {},
      },
    };
  }

  private static parseTurnFailed(event: TurnFailedEvent): ParsedEvent | null {
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: false,
        result: event.error || "Turn failed",
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
    if (!item) {
      return null;
    }

    const itemType = item.type;

    if (itemType === "agent_message" && item.text) {
      return { type: "text", timestamp: new Date(), data: { text: item.text } };
    }
    if (itemType === "plan" && item.text) {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: `[plan] ${item.text}` },
      };
    }
    if (itemType === "command_execution") {
      return this.parseCommandExecution(event);
    }
    if (itemType === "file_edit" || itemType === "file_write") {
      return this.parseFileEditOrWrite(event);
    }
    if (itemType === "file_read") {
      return this.parseFileRead(event);
    }
    if (itemType === "file_change") {
      return this.parseFileChange(item);
    }
    if (itemType === "reasoning" && item.text) {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: `[thinking] ${item.text}` },
      };
    }

    return null;
  }

  private static parseCommandExecution(event: ItemEvent): ParsedEvent | null {
    const item = event.item;

    if (event.type === "item.started" && item.command) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Bash",
          toolUseId: item.id,
          input: { command: item.command },
        },
      };
    }

    if (event.type === "item.completed") {
      const output = item.aggregated_output ?? item.output ?? "";
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: item.id,
          result: output,
          isError: isCommandExecutionError(item),
        },
      };
    }

    return null;
  }

  private static parseFileEditOrWrite(event: ItemEvent): ParsedEvent | null {
    const item = event.item;

    if (event.type === "item.started" && item.path) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: item.type === "file_edit" ? "Edit" : "Write",
          toolUseId: item.id,
          input: { file_path: item.path },
        },
      };
    }

    if (event.type === "item.completed") {
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: item.id,
          result: item.diff || "File operation completed",
          isError: false,
        },
      };
    }

    return null;
  }

  private static parseFileRead(event: ItemEvent): ParsedEvent | null {
    const item = event.item;

    if (event.type === "item.started" && item.path) {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: "Read",
          toolUseId: item.id,
          input: { file_path: item.path },
        },
      };
    }

    if (event.type === "item.completed") {
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: item.id,
          result: "File read completed",
          isError: false,
        },
      };
    }

    return null;
  }

  private static parseFileChange(item: CodexItem): ParsedEvent | null {
    if (!item.changes || item.changes.length === 0) {
      return null;
    }

    const changes = item.changes
      .map((c) => {
        const action =
          c.kind === "add"
            ? "Created"
            : c.kind === "modify"
              ? "Modified"
              : "Deleted";
        return `${action}: ${c.path}`;
      })
      .join("\n");

    return {
      type: "text",
      timestamp: new Date(),
      data: { text: `[files]\n${changes}` },
    };
  }

  private static parseErrorEvent(event: ErrorEvent): ParsedEvent | null {
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: false,
        result: event.message || event.error || "Unknown error",
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

function isCommandExecutionError(item: CodexItem): boolean {
  if (item.status === "failed" || item.status === "declined") {
    return true;
  }
  if (item.status === "completed") {
    return typeof item.exit_code === "number" ? item.exit_code !== 0 : false;
  }
  return typeof item.exit_code === "number" ? item.exit_code !== 0 : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function formatCodexWarningMessage(event: WarningEvent): string | null {
  if (typeof event.message === "string") {
    const message = event.message.trim();
    if (message) {
      return message;
    }
  }

  return formatCodexErrorMessage(event.error);
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
