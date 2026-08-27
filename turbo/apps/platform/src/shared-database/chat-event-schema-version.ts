import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

type ChatEventSchemaVersionHeaders = Readonly<{
  [CHAT_EVENT_SCHEMA_VERSION_HEADER]: string;
}>;

function chatEventSchemaVersionHeaders(
  version: number,
): ChatEventSchemaVersionHeaders {
  return Object.freeze({
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]: version.toString(),
  });
}

export const CHAT_EVENT_SCHEMA_VERSION_HEADERS = chatEventSchemaVersionHeaders(
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
);

function isSchemaVersionAhead(response: {
  readonly status: number;
  readonly body: unknown;
}): boolean {
  if (
    response.status !== 409 ||
    typeof response.body !== "object" ||
    response.body === null ||
    !("error" in response.body)
  ) {
    return false;
  }
  const error = response.body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CHAT_EVENT_SCHEMA_VERSION_AHEAD"
  );
}

/** Bounded V7 client -> V6 API rollback bridge. */
export async function requestWithChatEventSchemaVersionFallback<
  T extends { readonly status: number; readonly body: unknown },
>(
  request: (headers: ChatEventSchemaVersionHeaders) => Promise<T>,
): Promise<{ readonly response: T; readonly requestedVersion: number }> {
  const response = await request(CHAT_EVENT_SCHEMA_VERSION_HEADERS);
  if (!isSchemaVersionAhead(response)) {
    return {
      response,
      requestedVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
    };
  }
  return {
    response: await request(
      chatEventSchemaVersionHeaders(PREVIOUS_CHAT_EVENT_SCHEMA_VERSION),
    ),
    requestedVersion: PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  };
}

export function assertChatEventSchemaVersion(
  headers: Headers,
  requestedVersion: number = CURRENT_CHAT_EVENT_SCHEMA_VERSION,
): void {
  const version = headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER);
  if (version !== requestedVersion.toString()) {
    throw new Error(`Unexpected Chat Event schema version ${version}`);
  }
}
