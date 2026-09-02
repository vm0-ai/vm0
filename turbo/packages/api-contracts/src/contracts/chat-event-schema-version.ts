/**
 * Chat Event rows, Snapshot NDJSON lines, and the browser row cache all use
 * this one schema version. Snapshot storage records the version it contains;
 * live PostgreSQL rows are always represented in the API's current version.
 */
export const PREVIOUS_CHAT_EVENT_SCHEMA_VERSION = 7 as const;
export const CURRENT_CHAT_EVENT_SCHEMA_VERSION = 8 as const;

export const SUPPORTED_CHAT_EVENT_SCHEMA_VERSIONS = [
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
] as const;

export type ChatEventSchemaVersion =
  (typeof SUPPORTED_CHAT_EVENT_SCHEMA_VERSIONS)[number];

export const CHAT_EVENT_SCHEMA_VERSION_HEADER = "X-Chat-Event-Schema-Version";

export type ChatEventCursor =
  | { readonly lastEventId: null; readonly lastSeqId: 0 }
  | {
      readonly lastEventId: string;
      readonly lastSeqId: number;
    };
