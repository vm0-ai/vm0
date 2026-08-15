import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

export const CHAT_EVENT_SCHEMA_VERSION_HEADERS = Object.freeze({
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
    CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
});

export function assertChatEventSchemaVersion(headers: Headers): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  // A newly promoted app can briefly reach the previous API during the
  // backend rollout/rollback window (observed maximum: 102 minutes). Remove
  // the missing-header tolerance with #27194 after that window is closed.
  if (
    version !== null &&
    version !== CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()
  ) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}
