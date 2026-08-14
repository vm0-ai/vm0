/**
 * Chat Event rows, Snapshot NDJSON lines, and the browser row cache all use
 * this one schema version. Snapshot storage records the version it contains;
 * live PostgreSQL rows are always represented in the API's current version.
 */
export const CURRENT_CHAT_EVENT_SCHEMA_VERSION = 5 as const;

/** Oldest version the current API can produce through its downgrade chain. */
export const CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR = 4 as const;

/**
 * Temporary rollout default for callers that omit the version header. Keep it
 * fixed rather than following future current-version bumps.
 */
export const LEGACY_CHAT_EVENT_SCHEMA_VERSION = 5 as const;

export const CHAT_EVENT_SCHEMA_VERSION_HEADER = "X-Chat-Event-Schema-Version";

export type SupportedChatEventSchemaVersion = 4 | 5;

export interface ChatEventCursor {
  readonly lastEventId: string | null;
  readonly lastSeqId: number;
}
