import { describe, it, expect } from "vitest";
import {
  isSandboxAuth,
  storageCapability,
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

  describe("storageCapability", () => {
    it("should map action to unified storage capability", () => {
      expect(storageCapability("read")).toBe("storage:read");
      expect(storageCapability("write")).toBe("storage:write");
    });
  });

  describe("missingCapabilityError", () => {
    it("should return 403 error body with capability name", () => {
      const error = missingCapabilityError("storage:read");

      expect(error.error.message).toBe(
        "Missing required capability: storage:read",
      );
      expect(error.error.code).toBe("FORBIDDEN");
    });
  });
});
