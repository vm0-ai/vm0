import { describe, it, expect } from "vitest";
import { hasRequiredScopes } from "../connectors";

describe("hasRequiredScopes", () => {
  it("returns true for non-OAuth connector type", () => {
    // computer connector has no oauth config
    expect(hasRequiredScopes("computer", null)).toBe(true);
  });

  it("returns true when connector has empty required scopes", () => {
    // notion has scopes: []
    expect(hasRequiredScopes("notion", null)).toBe(true);
    expect(hasRequiredScopes("notion", [])).toBe(true);
    expect(hasRequiredScopes("notion", ["some-scope"])).toBe(true);
  });

  it("returns false when storedScopes is null", () => {
    // github requires ["repo"]
    expect(hasRequiredScopes("github", null)).toBe(false);
  });

  it("returns false when required scope is missing", () => {
    expect(hasRequiredScopes("github", [])).toBe(false);
    expect(hasRequiredScopes("github", ["read:org"])).toBe(false);
  });

  it("returns true when all required scopes are present", () => {
    expect(hasRequiredScopes("github", ["repo"])).toBe(true);
  });

  it("returns true when stored scopes are a superset of required", () => {
    expect(hasRequiredScopes("github", ["repo", "read:org", "user"])).toBe(
      true,
    );
  });
});
