import { describe, it, expect } from "vitest";
import { extractPermissions } from "../permission-allow-signals.ts";

describe("extractPermissions", () => {
  it("should return empty array for unknown connector type", () => {
    expect(extractPermissions("nonexistent")).toStrictEqual([]);
  });

  it("should return empty array for empty string", () => {
    expect(extractPermissions("")).toStrictEqual([]);
  });

  it("should return permissions for a valid connector type", () => {
    const permissions = extractPermissions("github");
    expect(permissions.length).toBeGreaterThan(0);
    // Each permission should have a name
    for (const p of permissions) {
      expect(p.name).toBeTruthy();
    }
  });

  it("should deduplicate permissions by name", () => {
    const permissions = extractPermissions("github");
    const names = permissions.map((p) => {
      return p.name;
    });
    const uniqueNames = [...new Set(names)];
    expect(names).toStrictEqual(uniqueNames);
  });

  it("should return permissions with description when available", () => {
    const permissions = extractPermissions("github");
    // At least some permissions should have descriptions
    const withDescription = permissions.filter((p) => {
      return p.description;
    });
    expect(withDescription.length).toBeGreaterThan(0);
  });
});
