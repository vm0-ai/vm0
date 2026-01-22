/**
 * Event parser for OpenAI Codex CLI JSONL events
 * Converts raw JSONL events into simplified, user-friendly format
 *
 * Codex event types:
 * - thread.started: Session initialization
 * - turn.started/turn.completed/turn.failed: Turn lifecycle
 * - item.started/item.updated/item.completed: Individual items (messages, commands, etc.)
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
  // For agent_message
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

type RawCodexEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemEvent
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

    const eventType = rawEvent.type as string;

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

  // eslint-disable-next-line complexity -- TODO: refactor complex function
  private static parseItemEvent(event: ItemEvent): ParsedEvent | null {
    const item = event.item;
    if (!item) {
      return null;
    }

    const itemType = item.type;

    // Agent message = text output
    if (itemType === "agent_message" && item.text) {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: item.text },
      };
    }

    // Command execution = tool use
    if (itemType === "command_execution") {
      // item.started = tool_use, item.completed = tool_result
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

      // Codex uses aggregated_output for command output
      if (event.type === "item.completed") {
        const output = item.aggregated_output ?? item.output ?? "";
        return {
          type: "tool_result",
          timestamp: new Date(),
          data: {
            toolUseId: item.id,
            result: output,
            isError: item.exit_code !== 0,
          },
        };
      }
    }

    // File operations = tool use/result
    if (itemType === "file_edit" || itemType === "file_write") {
      if (event.type === "item.started" && item.path) {
        return {
          type: "tool_use",
          timestamp: new Date(),
          data: {
            tool: itemType === "file_edit" ? "Edit" : "Write",
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
    }

    // File read = tool use/result
    if (itemType === "file_read") {
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
    }

    // File change = text showing what files were modified
    if (itemType === "file_change" && item.changes && item.changes.length > 0) {
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

    // Reasoning = text (Codex uses text field for reasoning content)
    if (itemType === "reasoning" && item.text) {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: `[thinking] ${item.text}` },
      };
    }

    return null;
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
}
