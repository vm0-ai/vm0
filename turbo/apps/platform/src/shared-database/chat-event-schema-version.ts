import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

type ChatEventSchemaVersionHeaders = Readonly<{
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]: string;
}>;

function chatEventSchemaVersionHeaders(): ChatEventSchemaVersionHeaders {
  return Object.freeze({
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
  });
}

export const CHAT_EVENT_SCHEMA_VERSION_HEADERS =
  chatEventSchemaVersionHeaders();

export function assertChatEventSchemaVersion(headers: Headers): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  if (version !== CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}
