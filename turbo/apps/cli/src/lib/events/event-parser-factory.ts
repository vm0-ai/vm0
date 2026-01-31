/**
 * Factory for creating the appropriate event parser based on framework type
 * Also supports auto-detection from event format
 */

import { ClaudeEventParser, type ParsedEvent } from "./claude-event-parser";
import { CodexEventParser } from "./codex-event-parser";
import { getValidatedFramework, type SupportedFramework } from "@vm0/core";

type EventParserType = typeof ClaudeEventParser | typeof CodexEventParser;

/**
 * Detect the framework type from event data
 * Returns null if framework cannot be determined
 */
function detectFrameworkFromEvent(
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
 * Get the appropriate event parser for a given framework
 * @param framework The CLI framework type (claude-code or codex)
 * @returns The event parser class for that framework
 * @throws Error if framework is not supported
 */
function getEventParser(framework: SupportedFramework): EventParserType {
  if (framework === "codex") {
    return CodexEventParser;
  }
  return ClaudeEventParser;
}

/**
 * Parse an event using the appropriate parser for the framework
 * @param rawEvent The raw event data from the API
 * @param framework The CLI framework type (optional - will auto-detect if not provided)
 * @returns Parsed event or null if not parseable
 * @throws Error if framework is explicitly provided but not supported
 */
export function parseEvent(
  rawEvent: Record<string, unknown>,
  framework?: string,
): ParsedEvent | null {
  // Use provided framework or auto-detect from event
  // Validate explicitly provided framework; auto-detected frameworks are always valid
  const effectiveFramework: SupportedFramework = framework
    ? getValidatedFramework(framework)
    : ((detectFrameworkFromEvent(rawEvent) ||
        "claude-code") as SupportedFramework);
  const Parser = getEventParser(effectiveFramework);
  return Parser.parse(rawEvent);
}
