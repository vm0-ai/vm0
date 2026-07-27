import { describe, expect, it } from "vitest";

import { isConnectorChangedPayloadFor } from "../connector-change.ts";

describe("connector change payloads", () => {
  it("matches only the requested connector", () => {
    expect(
      isConnectorChangedPayloadFor({ connectorRef: "gmail" }, "gmail"),
    ).toBeTruthy();
    expect(
      isConnectorChangedPayloadFor({ connectorRef: "github" }, "gmail"),
    ).toBeFalsy();
    expect(isConnectorChangedPayloadFor({}, "gmail")).toBeFalsy();
  });

  it("accepts the legacy null payload during rolling deployments", () => {
    expect(isConnectorChangedPayloadFor(null, "gmail")).toBeTruthy();
  });
});
