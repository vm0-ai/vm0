import { describe, expect, it } from "vitest";

import { assistantMessageIdForRunEvent } from "../assistant-message-id";

describe("assistantMessageIdForRunEvent", () => {
  it("matches the cross-language golden vector", () => {
    expect(
      assistantMessageIdForRunEvent(
        "11111111-1111-4111-8111-111111111111",
        "msg_01",
      ),
    ).toBe("f819e443-a3fc-5990-920b-5eb8e51e038e");
  });
});
