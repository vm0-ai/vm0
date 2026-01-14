/**
 * Event parser for Claude Code JSONL events
 * Converts raw JSONL events into simplified, user-friendly format
 *
 * Note: VM0 lifecycle events (vm0_start, vm0_result, vm0_error) are no longer
 * sent as events. Instead, run state is returned in the events API response.
 */

export interface ParsedEvent {
  type: "init" | "text" | "tool_use" | "tool_result" | "result";
  timestamp: Date;
  data: Record<string, unknown>;
}

interface SystemEvent {
  type: "system";
  subtype: string;
  cwd?: string;
  session_id: string;
  tools: string[];
  model: string;
}

interface AssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: Record<string, unknown>;
  };
  session_id: string;
}

interface UserEvent {
  type: "user";
  message: {
    role: "user";
    content: Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
    }>;
  };
  session_id: string;
}

interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: Record<string, unknown>;
}

type RawEvent =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | Record<string, unknown>;

export class ClaudeEventParser {
  /**
   * Parse a raw Claude Code JSONL event into a simplified format
   * Returns null if the event type is unknown or malformed
   */
  static parse(rawEvent: RawEvent): ParsedEvent | null {
    if (!rawEvent || typeof rawEvent !== "object" || !("type" in rawEvent)) {
      return null;
    }

    switch (rawEvent.type) {
      case "system":
        return this.parseSystemEvent(rawEvent as SystemEvent);

      case "assistant":
        return this.parseAssistantMessage(rawEvent as AssistantEvent);

      case "user":
        return this.parseUserMessage(rawEvent as UserEvent);

      case "result":
        return this.parseResultEvent(rawEvent as ResultEvent);

      default:
        return null;
    }
  }

  private static parseSystemEvent(event: SystemEvent): ParsedEvent | null {
    if (event.subtype !== "init") {
      return null;
    }

    return {
      type: "init",
      timestamp: new Date(),
      data: {
        provider: "claude-code",
        sessionId: event.session_id,
        model: event.model,
        tools: event.tools,
        ...(event.cwd && { cwd: event.cwd }),
      },
    };
  }

  private static parseAssistantMessage(
    event: AssistantEvent,
  ): ParsedEvent | null {
    if (!event.message?.content || event.message.content.length === 0) {
      return null;
    }

    const content = event.message.content[0];

    if (!content) {
      return null;
    }

    if (content.type === "text") {
      return {
        type: "text",
        timestamp: new Date(),
        data: { text: content.text },
      };
    }

    if (content.type === "tool_use") {
      return {
        type: "tool_use",
        timestamp: new Date(),
        data: {
          tool: content.name,
          toolUseId: content.id,
          input: content.input || {},
        },
      };
    }

    return null;
  }

  private static parseUserMessage(event: UserEvent): ParsedEvent | null {
    if (!event.message?.content || event.message.content.length === 0) {
      return null;
    }

    const content = event.message.content[0];

    if (!content) {
      return null;
    }

    if (content.type === "tool_result") {
      return {
        type: "tool_result",
        timestamp: new Date(),
        data: {
          toolUseId: content.tool_use_id,
          result: content.content,
          isError: content.is_error || false,
        },
      };
    }

    return null;
  }

  private static parseResultEvent(event: ResultEvent): ParsedEvent | null {
    return {
      type: "result",
      timestamp: new Date(),
      data: {
        success: !event.is_error,
        result: event.result,
        durationMs: event.duration_ms,
        numTurns: event.num_turns,
        cost: event.total_cost_usd,
        usage: event.usage,
      },
    };
  }
}
