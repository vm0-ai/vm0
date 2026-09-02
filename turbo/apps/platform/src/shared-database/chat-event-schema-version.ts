import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  type ChatEventSchemaVersion,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

type ChatEventSchemaVersionHeaders = Readonly<{
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]: string;
}>;

export function chatEventSchemaVersionHeaders(
  schemaVersion: ChatEventSchemaVersion,
): ChatEventSchemaVersionHeaders {
  return Object.freeze({
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]: schemaVersion.toString(),
  });
}

export function assertChatEventSchemaVersion(
  headers: Headers,
  schemaVersion: ChatEventSchemaVersion,
): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  if (version !== schemaVersion.toString()) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}

export function isChatEventSchemaVersionAhead(result: {
  readonly status: number;
  readonly body: unknown;
}): boolean {
  return (
    result.status === 409 &&
    typeof result.body === "object" &&
    result.body !== null &&
    "error" in result.body &&
    typeof result.body.error === "object" &&
    result.body.error !== null &&
    "code" in result.body.error &&
    result.body.error.code === "CHAT_EVENT_SCHEMA_VERSION_AHEAD"
  );
}
