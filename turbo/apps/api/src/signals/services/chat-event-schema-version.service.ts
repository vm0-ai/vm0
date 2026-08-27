import {
  CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
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

/** Resolve the explicit wire version during the bounded V5/V6-to-V7 rollout. */
export function resolveChatEventSchemaVersion(
  headerValue: string | undefined,
): ChatEventSchemaVersionResolution {
  if (headerValue === undefined) {
    return invalidVersion();
  }
  if (!/^[1-9]\d*$/.test(headerValue)) {
    return invalidVersion();
  }
  const version = Number(headerValue);
  if (!Number.isSafeInteger(version)) {
    return invalidVersion();
  }
  // Old app bundles can live for about two days, and pinned runner/CLI
  // contexts can live through the queue window plus two hours. Remove these
  // bridges under #29362 after the V7 app floor ships and contexts drain.
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
