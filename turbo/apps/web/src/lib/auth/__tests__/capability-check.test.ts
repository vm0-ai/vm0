import { describe, it, expect } from "vitest";
import {
  hasRequiredCapability,
  isSandboxAuth,
  missingCapabilityError,
} from "../capability-check";

describe("capability-check", () => {
  describe("isSandboxAuth", () => {
    it("should return false for CLI auth", () => {
      expect(isSandboxAuth({ userId: "user-1" })).toBe(false);
    });

    it("should return true for sandbox auth", () => {
      expect(isSandboxAuth({ userId: "user-1", runId: "run-1" })).toBe(true);
    });
  });

  describe("missingCapabilityError", () => {
    it("should return 403 error body with capability name", () => {
      const error = missingCapabilityError("agent:read");

      expect(error.error.message).toBe(
        "Missing required capability: agent:read",
      );
      expect(error.error.code).toBe("FORBIDDEN");
    });
  });

  describe("hasRequiredCapability", () => {
    it("should match exact capabilities", () => {
      expect(hasRequiredCapability(["telegram:read"], "telegram:read")).toBe(
        true,
      );
    });

    it("should let telegram:write satisfy telegram:read", () => {
      expect(hasRequiredCapability(["telegram:write"], "telegram:read")).toBe(
        true,
      );
    });

    it("should not let telegram:read satisfy telegram:write", () => {
      expect(hasRequiredCapability(["telegram:read"], "telegram:write")).toBe(
        false,
      );
    });

    it("should let phone:write satisfy phone:read", () => {
      expect(hasRequiredCapability(["phone:write"], "phone:read")).toBe(true);
    });

    it("should not let phone:read satisfy phone:write", () => {
      expect(hasRequiredCapability(["phone:read"], "phone:write")).toBe(false);
    });

    it("should reject missing capabilities", () => {
      expect(hasRequiredCapability(["file:read"], "telegram:read")).toBe(false);
    });
  });
});
