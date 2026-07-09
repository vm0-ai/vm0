import { describe, it, expect } from "vitest";
import { isStaffOrg } from "../staff-org";

describe("isStaffOrg", () => {
  it("returns false for an arbitrary non-staff org id", () => {
    expect(isStaffOrg("org_random_xyz")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isStaffOrg(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isStaffOrg(null)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isStaffOrg("")).toBe(false);
  });
});
