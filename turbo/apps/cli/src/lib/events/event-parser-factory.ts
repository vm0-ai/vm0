/**
 * Factory for creating the appropriate event parser based on framework.
 */

import { getValidatedFramework } from "@vm0/core";
import { ClaudeEventParser, type ParsedEvent } from "./claude-event-parser";
import { CodexEventParser } from "./codex-event-parser";

/**
 * Parse a raw JSONL event using the parser for the given framework.
 * Defaults to claude-code when framework is undefined.
 *
 * @param rawEvent The raw event payload from the API
 * @param framework Framework identifier from the events response
 * @returns Parsed event or null if not parseable
 * @throws Error if framework is defined but not supported
 */
export function parseEvent(
  rawEvent: Record<string, unknown>,
  framework?: string,
): ParsedEvent | null {
  const validated = getValidatedFramework(framework);
  if (validated === "codex") {
    return CodexEventParser.parse(rawEvent);
  }
  return ClaudeEventParser.parse(rawEvent);
}
