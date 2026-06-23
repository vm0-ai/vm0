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
  private pendingCodexError: {
    event: ParsedEvent;
    turnId: string | null;
  } | null = null;

  process(
    rawEvent: unknown,
    framework?: string,
    timestamp?: Date,
  ): ParsedEvent[] {
    const isCodex = framework === "codex";
    const rawRecord = asRecord(rawEvent);
    const eventType = getEventType(rawRecord);
    const turnId = getCodexTurnId(rawRecord);
    const parsed = rawRecord ? parseEvent(rawRecord, framework) : null;
    if (parsed && timestamp) {
      parsed.timestamp = timestamp;
    }

    if (!isCodex) {
      return this.processNonCodexEvent(parsed);
    }

    return this.processCodexEvent(eventType, turnId, parsed);
  }

  private processNonCodexEvent(parsed: ParsedEvent | null): ParsedEvent[] {
    const output = this.flush();
    if (parsed) {
      output.push(parsed);
    }
    return output;
  }

  private processCodexEvent(
    eventType: string | undefined,
    turnId: string | null,
    parsed: ParsedEvent | null,
  ): ParsedEvent[] {
    if (eventType === "error" && parsed?.type === "result") {
      return this.processCodexError(parsed, turnId);
    }

    if (eventType === "turn.failed") {
      return this.processCodexTurnFailed(turnId, parsed);
    }

    if (this.shouldFlushPendingCodexErrorBefore(eventType, turnId)) {
      const output = this.flush();
      if (parsed) {
        output.push(parsed);
      }
      return output;
    }

    const output = parsed?.type === "result" ? this.flush() : [];
    if (parsed) {
      output.push(parsed);
    }
    return output;
  }

  private processCodexError(
    parsed: ParsedEvent,
    turnId: string | null,
  ): ParsedEvent[] {
    const output = this.flush();
    this.pendingCodexError = { event: parsed, turnId };
    return output;
  }

  private processCodexTurnFailed(
    turnId: string | null,
    parsed: ParsedEvent | null,
  ): ParsedEvent[] {
    const pendingCodexError = this.pendingCodexError;
    this.pendingCodexError = null;

    if (
      pendingCodexError &&
      shouldPairCodexFailureEvents(pendingCodexError.turnId, turnId)
    ) {
      if (shouldPreferPendingCodexError(pendingCodexError.event, parsed)) {
        return [pendingCodexError.event];
      }
      return parsed ? [parsed] : [];
    }

    const output = pendingCodexError ? [pendingCodexError.event] : [];
    if (parsed) {
      output.push(parsed);
    }
    return output;
  }

  private shouldFlushPendingCodexErrorBefore(
    eventType: string | undefined,
    turnId: string | null,
  ): boolean {
    return (
      Boolean(this.pendingCodexError) &&
      eventType === "turn.started" &&
      Boolean(turnId) &&
      this.pendingCodexError?.turnId !== turnId
    );
  }

  flush(): ParsedEvent[] {
    if (!this.pendingCodexError) {
      return [];
    }
    const output = [this.pendingCodexError.event];
    this.pendingCodexError = null;
    return output;
  }
}

function getCodexTurnId(
  rawEvent: Record<string, unknown> | null,
): string | null {
  const topLevelTurnId = getTrimmedString(rawEvent?.turn_id);
  if (topLevelTurnId) {
    return topLevelTurnId;
  }

  const turn = asRecord(rawEvent?.turn);
  return getTrimmedString(turn?.id);
}

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() || null;
}

function shouldPairCodexFailureEvents(
  pendingTurnId: string | null,
  turnFailedTurnId: string | null,
): boolean {
  if (pendingTurnId && turnFailedTurnId) {
    return pendingTurnId === turnFailedTurnId;
  }
  return true;
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
