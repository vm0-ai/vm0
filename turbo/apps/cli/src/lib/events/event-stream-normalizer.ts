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
    const parsed = rawRecord ? parseEvent(rawRecord, framework) : null;
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

    if (eventType === "error" && parsed?.type === "result") {
      const output = this.flush();
      this.pendingCodexError = parsed;
      return output;
    }

    if (eventType === "turn.failed") {
      const pendingCodexError = this.pendingCodexError;
      this.pendingCodexError = null;
      if (
        pendingCodexError &&
        shouldPreferPendingCodexError(pendingCodexError, parsed)
      ) {
        return [pendingCodexError];
      }
      return parsed ? [parsed] : [];
    }

    const output = parsed?.type === "result" ? this.flush() : [];
    if (parsed) {
      output.push(parsed);
    }
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

function shouldPreferPendingCodexError(
  pendingCodexError: ParsedEvent,
  turnFailedEvent: ParsedEvent | null,
): boolean {
  const pendingResult = getResultText(pendingCodexError);
  const turnFailedResult = getResultText(turnFailedEvent);
  if (!turnFailedResult) {
    return pendingResult !== null;
  }
  return (
    pendingResult !== null &&
    !isGenericCodexFailureResult(pendingResult) &&
    isGenericCodexFailureResult(turnFailedResult)
  );
}

function getResultText(event: ParsedEvent | null): string | null {
  const result = event?.data.result;
  if (typeof result !== "string") {
    return null;
  }
  return result.trim() || null;
}

function isGenericCodexFailureResult(result: string): boolean {
  const normalized = result.toLowerCase();
  return (
    normalized === "error" ||
    normalized === "turn failed" ||
    normalized === "turn interrupted" ||
    normalized === "unknown error" ||
    normalized === "codex error"
  );
}
