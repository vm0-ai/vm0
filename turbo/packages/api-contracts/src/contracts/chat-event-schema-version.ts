/**
 * Chat Event rows, Snapshot NDJSON lines, and the browser row cache all use
 * this one schema version. Snapshot storage records the version it contains;
 * live PostgreSQL rows are always represented in the API's current version.
 */
export const CURRENT_CHAT_EVENT_SCHEMA_VERSION = 7 as const;

export const CHAT_EVENT_SCHEMA_VERSION_HEADER = "X-Chat-Event-Schema-Version";

/**
 * Stage 1 mixed-deployment adapter for pre-detachment App, API, and CLI
 * readers. Stale App/SharedWorker clients can remain for about two days; CLI
 * artifacts use the queue plus claimed execution/finalization drain gate, and
 * current clients may still reach retained pre-Stage-1 API targets. Runtime
 * cursor and Snapshot selection must not consult this value. Remove the
 * wire/cache adapter under https://github.com/vm0-ai/vm0/issues/30329 only
 * after every listed gate closes.
 */
export const LEGACY_CHAT_EVENT_PROJECTION = "tool-redacted" as const;
export const LEGACY_CHAT_EVENT_PROJECTIONS = [
  LEGACY_CHAT_EVENT_PROJECTION,
] as const;

export type LegacyChatEventProjection =
  (typeof LEGACY_CHAT_EVENT_PROJECTIONS)[number];

export type ChatEventCursor =
  | { readonly lastEventId: null; readonly lastSeqId: 0 }
  | {
      readonly lastEventId: string;
      readonly lastSeqId: number;
    };

export type LegacyChatEventCursor =
  | { readonly lastEventId: null; readonly lastSeqId: 0 }
  | {
      readonly lastEventId: string;
      readonly lastSeqId: number;
      readonly projection: LegacyChatEventProjection;
    };

/** Add the temporary field only while crossing an old wire/cache boundary. */
export function withLegacyChatEventProjection(
  cursor: ChatEventCursor,
): LegacyChatEventCursor {
  return cursor.lastEventId === null
    ? cursor
    : { ...cursor, projection: LEGACY_CHAT_EVENT_PROJECTION };
}

/** Ignore the temporary field while entering current cursor logic. */
export function withoutLegacyChatEventProjection(
  cursor: LegacyChatEventCursor,
): ChatEventCursor {
  return cursor.lastEventId === null
    ? { lastEventId: null, lastSeqId: 0 }
    : { lastEventId: cursor.lastEventId, lastSeqId: cursor.lastSeqId };
}
