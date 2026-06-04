import { describe, expect, it } from "vitest";
import { hasConnectorPermissions } from "../permissions.ts";

describe("hasConnectorPermissions", () => {
  it("should return true for connectors with permissions", () => {
    expect(hasConnectorPermissions("slack")).toBeTruthy();
    expect(hasConnectorPermissions("gmail")).toBeTruthy();
    expect(hasConnectorPermissions("x")).toBeTruthy();
  });

  it("should return false for connectors without permissions", () => {
    expect(hasConnectorPermissions("unknown" as never)).toBeFalsy();
  });

  it("should return false for connectors with config but no permissions", () => {
    // hubspot, atlassian, stripe have connector configs but no permissions defined
    expect(hasConnectorPermissions("hubspot")).toBeFalsy();
    expect(hasConnectorPermissions("atlassian")).toBeFalsy();
    expect(hasConnectorPermissions("stripe")).toBeFalsy();
  });
});
