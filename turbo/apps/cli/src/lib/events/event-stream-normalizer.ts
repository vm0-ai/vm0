import type { ParsedEvent } from "./claude-event-parser";
import { parseEvent } from "./event-parser-factory";

function asRecord(rawEvent: unknown): Record<string, unknown> | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }
  return rawEvent as Record<string, unknown>;
}

function getEventType(
  rawEvent: Record<string, unknown> | null,
): string | undefined {
  const eventType = rawEvent?.type;
  return typeof eventType === "string" ? eventType : undefined;
}

function stringData(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isFailureResult(event: ParsedEvent | null): event is ParsedEvent {
  return event?.type === "result" && event.data.success === false;
}

function isTopLevelCodexError(
  eventType: string | undefined,
  parsed: ParsedEvent | null,
): boolean {
  return eventType === "error" && isFailureResult(parsed);
}

function isTerminalCodexFailure(
  eventType: string | undefined,
  parsed: ParsedEvent | null,
): parsed is ParsedEvent {
  if (!isFailureResult(parsed)) {
    return false;
  }
  return eventType === "turn.failed" || eventType === "turn.completed";
}

function getParsedTurnId(event: ParsedEvent): string | undefined {
  return stringData(event.data.turnId);
}

function getResultText(event: ParsedEvent): string | undefined {
  return stringData(event.data.result);
}

function combineDistinctMessages(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  const messages: string[] = [];
  for (const message of [first, second]) {
    if (!message) {
      continue;
    }
    const containingIndex = messages.findIndex((existing) => {
      return existing === message || existing.includes(message);
    });
    if (containingIndex !== -1) {
      continue;
    }

    const containedIndex = messages.findIndex((existing) => {
      return message.includes(existing);
    });
    if (containedIndex !== -1) {
      messages[containedIndex] = message;
      continue;
    }

    messages.push(message);
  }
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function attachFramework(
  parsed: ParsedEvent | null,
  framework: string | undefined,
): ParsedEvent | null {
  if (!parsed || !framework || parsed.data.framework !== undefined) {
    return parsed;
  }
  return {
    ...parsed,
    data: {
      ...parsed.data,
      framework,
    },
  };
}

/**
 * Preserves single-event parser behavior while applying stream-aware
 * presentation fixes that require one-event lookahead.
 */
export class EventStreamNormalizer {
  private pendingCodexError: ParsedEvent | null = null;

  process(
    rawEvent: unknown,
    framework?: string,
    timestamp?: Date,
  ): ParsedEvent[] {
    const isCodex = framework === "codex";
    const rawRecord = asRecord(rawEvent);
    const eventType = getEventType(rawRecord);
    const parsed = attachFramework(
      rawRecord ? parseEvent(rawRecord, framework) : null,
      framework,
    );
    if (parsed && timestamp) {
      parsed.timestamp = timestamp;
    }

    if (!isCodex) {
      const output = this.flush();
      if (parsed) {
        output.push(parsed);
      }
      return output;
    }

    if (isTopLevelCodexError(eventType, parsed)) {
      const output = this.flush();
      this.pendingCodexError = parsed;
      return output;
    }

    if (isTerminalCodexFailure(eventType, parsed)) {
      if (this.pendingCodexError) {
        const pendingTurnId = getParsedTurnId(this.pendingCodexError);
        const terminalTurnId = getParsedTurnId(parsed);
        const shouldCollapse =
          !pendingTurnId ||
          (terminalTurnId !== undefined && pendingTurnId === terminalTurnId);

        if (shouldCollapse) {
          const mergedResult = combineDistinctMessages(
            getResultText(this.pendingCodexError),
            getResultText(parsed),
          );
          this.pendingCodexError = null;
          return [
            {
              ...parsed,
              data: {
                ...parsed.data,
                ...(mergedResult ? { result: mergedResult } : {}),
              },
            },
          ];
        }

        const output = this.flush();
        output.push(parsed);
        return output;
      }

      this.pendingCodexError = null;
      return [parsed];
    }

    if (!parsed) {
      return [];
    }

    const output = this.flush();
    output.push(parsed);
    return output;
  }

  flush(): ParsedEvent[] {
    if (!this.pendingCodexError) {
      return [];
    }
    const output = [this.pendingCodexError];
    this.pendingCodexError = null;
    return output;
  }
}
