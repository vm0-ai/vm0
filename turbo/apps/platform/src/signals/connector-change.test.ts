import { describe, expect, it } from "vitest";
import { isConnectorChangedPayloadFor } from "./connector-change";

describe("isConnectorChangedPayloadFor", () => {
  it("matches a valid payload for the requested connector", () => {
    expect(
      isConnectorChangedPayloadFor(
        { connectorSlug: "google-drive" },
        "google-drive",
      ),
    ).toBe(true);
  });

  it("rejects payloads without a connector identity", () => {
    expect(isConnectorChangedPayloadFor(null, "google-drive")).toBe(false);
  });
});
