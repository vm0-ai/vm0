import { describe, expect, it } from "vitest";

import { requireConnectorGrantUserId } from "../grant-result";

describe("requireConnectorGrantUserId", () => {
  it("returns a present user id", () => {
    expect(requireConnectorGrantUserId("user-123", "Test Provider")).toBe(
      "user-123",
    );
  });

  it("rejects missing and empty user ids", () => {
    for (const id of [undefined, null, ""]) {
      expect(() => {
        requireConnectorGrantUserId(id, "Test Provider");
      }).toThrow("No user id in Test Provider user info response");
    }
  });
});
