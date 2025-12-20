/**
 * Factory for creating the appropriate event parser based on provider type
 * Also supports auto-detection from event format
 */

import { ClaudeEventParser, type ParsedEvent } from "./event-parser";
import { CodexEventParser } from "./codex-event-parser";

export type EventParserType =
  | typeof ClaudeEventParser
  | typeof CodexEventParser;

/**
 * Detect the provider type from event data
 * Returns null if provider cannot be determined
 */
function detectProviderFromEvent(
  rawEvent: Record<string, unknown>,
): string | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }
  const eventType = rawEvent.type as string;

  // Codex-specific event types
  if (
    eventType === "thread.started" ||
    eventType === "turn.started" ||
    eventType === "turn.completed" ||
    eventType === "turn.failed" ||
    eventType?.startsWith("item.")
  ) {
    return "codex";
  }

  // Claude Code-specific event types
  if (
    eventType === "system" ||
    eventType === "assistant" ||
    eventType === "user" ||
    eventType === "result"
  ) {
    return "claude-code";
  }

  return null;
}

/**
 * Get the appropriate event parser for a given provider
 * @param provider The CLI provider type (claude-code or codex)
 * @returns The event parser class for that provider
 */
export function getEventParser(provider: string): EventParserType {
  if (provider === "codex") {
    return CodexEventParser;
  }
  // Default to Claude Code parser
  return ClaudeEventParser;
}

/**
 * Parse an event using the appropriate parser for the provider
 * @param rawEvent The raw event data from the API
 * @param provider The CLI provider type (optional - will auto-detect if not provided)
 * @returns Parsed event or null if not parseable
 */
export function parseEvent(
  rawEvent: Record<string, unknown>,
  provider?: string,
): ParsedEvent | null {
  // Use provided provider or auto-detect from event
  const effectiveProvider =
    provider || detectProviderFromEvent(rawEvent) || "claude-code";
  const Parser = getEventParser(effectiveProvider);
  return Parser.parse(rawEvent);
}
