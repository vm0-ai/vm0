/**
 * Factory for creating the appropriate event parser based on framework type
 * Also supports auto-detection from event format
 */

import { ClaudeEventParser, type ParsedEvent } from "./claude-event-parser";

/**
 * Parse an event using the Claude Code parser
 * @param rawEvent The raw event data from the API
 * @returns Parsed event or null if not parseable
 */
export function parseEvent(
  rawEvent: Record<string, unknown>,
): ParsedEvent | null {
  return ClaudeEventParser.parse(rawEvent);
}
