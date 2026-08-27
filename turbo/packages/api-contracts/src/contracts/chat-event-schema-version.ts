/**
 * Chat Event rows, Snapshot NDJSON lines, and the browser row cache all use
 * this one schema version. Snapshot storage records the version it contains;
 * live PostgreSQL rows are always represented in the API's current version.
 */
export const CURRENT_CHAT_EVENT_SCHEMA_VERSION = 7 as const;

/** Previous API/App/CLI wire version retained during the V7 rollout. */
export const PREVIOUS_CHAT_EVENT_SCHEMA_VERSION = 6 as const;

/**
 * V5/V6 app and pinned CLI -> V7 API fallback. Remove with #29362 after the
 * V7 app floor is live and V5/V6 queued or claimed contexts have drained.
 */
export const CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR = 5 as const;

export const CHAT_EVENT_SCHEMA_VERSION_HEADER = "X-Chat-Event-Schema-Version";

export const CHAT_EVENT_SNAPSHOT_PROJECTIONS = [
  "full",
  "tool-redacted",
] as const;

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
      /**
       * V5/V6 client cursor -> V7 API fallback. Remove with #29362 after the
       * V7 app floor is live, legacy caches rebuild, and pinned contexts drain.
       */
      readonly projection?: ChatEventSnapshotProjection;
    };
