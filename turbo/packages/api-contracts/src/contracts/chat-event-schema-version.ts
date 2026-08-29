/**
 * Chat Event rows, Snapshot NDJSON lines, and the browser row cache all use
 * this one schema version. Snapshot storage records the version it contains;
 * live PostgreSQL rows are always represented in the API's current version.
 */
export const CURRENT_CHAT_EVENT_SCHEMA_VERSION = 7 as const;

export const CHAT_EVENT_SCHEMA_VERSION_HEADER = "X-Chat-Event-Schema-Version";

export const CHAT_EVENT_SNAPSHOT_PROJECTIONS = ["tool-redacted"] as const;

/** V7 has one output.tool-free canonical Snapshot projection. */
export const CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION =
  "tool-redacted" as const;

export type ChatEventSnapshotProjection =
  (typeof CHAT_EVENT_SNAPSHOT_PROJECTIONS)[number];

export type ChatEventCursor =
  | { readonly lastEventId: null; readonly lastSeqId: 0 }
  | {
      readonly lastEventId: string;
      readonly lastSeqId: number;
      readonly projection: ChatEventSnapshotProjection;
    };
