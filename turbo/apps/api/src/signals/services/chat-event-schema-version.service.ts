import {
  CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  LEGACY_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";

interface VersionErrorResponse {
  readonly status: 400 | 409 | 426;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
}

type ChatEventSchemaVersionResolution =
  | { readonly kind: "ok"; readonly version: number }
  | { readonly kind: "error"; readonly response: VersionErrorResponse };

function invalidVersion(): ChatEventSchemaVersionResolution {
  return {
    kind: "error",
    response: {
      status: 400,
      body: {
        error: {
          message: "Invalid Chat Event schema version",
          code: "CHAT_EVENT_SCHEMA_VERSION_INVALID",
        },
      },
    },
  };
}

/** Resolve the explicit wire version, including the temporary fixed V5 default. */
export function resolveChatEventSchemaVersion(
  headerValue: string | undefined,
): ChatEventSchemaVersionResolution {
  if (headerValue === undefined) {
    // Previous app clients can omit this header for about 2 days, and existing
    // runner/sandbox CLI contexts can remain old for up to 2 hours. Remove the
    // fixed default with #27194 after both rollout windows have drained.
    return { kind: "ok", version: LEGACY_CHAT_EVENT_SCHEMA_VERSION };
  }
  if (!/^[1-9]\d*$/.test(headerValue)) {
    return invalidVersion();
  }
  const version = Number(headerValue);
  if (!Number.isSafeInteger(version)) {
    return invalidVersion();
  }
  if (version < CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR) {
    return {
      kind: "error",
      response: {
        status: 426,
        body: {
          error: {
            message: "The requested Chat Event schema version is retired",
            code: "CHAT_EVENT_SCHEMA_VERSION_RETIRED",
          },
        },
      },
    };
  }
  if (version > CURRENT_CHAT_EVENT_SCHEMA_VERSION) {
    return {
      kind: "error",
      response: {
        status: 409,
        body: {
          error: {
            message:
              "The requested Chat Event schema version is newer than this API",
            code: "CHAT_EVENT_SCHEMA_VERSION_AHEAD",
          },
        },
      },
    };
  }
  return { kind: "ok", version };
}
