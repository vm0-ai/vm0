import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { describe, expect, it } from "vitest";

import { assertChatEventSchemaVersion } from "../chat-event-schema-version.ts";

describe("assertChatEventSchemaVersion", () => {
  it("accepts the current response schema version", () => {
    const headers = new Headers({
      [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
        CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    });

    expect(() => {
      assertChatEventSchemaVersion(headers);
    }).not.toThrow();
  });

  it("rejects a missing response schema version", () => {
    expect(() => {
      assertChatEventSchemaVersion(new Headers());
    }).toThrow("Unexpected Chat Event schema version null");
  });
});
