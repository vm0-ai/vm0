import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

export const CHAT_EVENT_SCHEMA_VERSION_HEADERS = Object.freeze({
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
    CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
});

export function assertChatEventSchemaVersion(headers: Headers): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  if (version !== CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}

export function chatEventRowsQuery(cursor: ChatEventCursor, limit: number) {
  return cursor.lastEventId === null
    ? { sinceSeqId: cursor.lastSeqId, limit }
    : {
        sinceSeqId: cursor.lastSeqId,
        sinceEventId: cursor.lastEventId,
        limit,
      };
}
