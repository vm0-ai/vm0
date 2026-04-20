import { describe, it, expect } from "vitest";
import { isSandboxAuth, missingCapabilityError } from "../capability-check";

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
});
