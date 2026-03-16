import { describe, it, expect } from "vitest";
import {
  hasCapability,
  isSandboxAuth,
  storageCapability,
  missingCapabilityError,
} from "../capability-check";

describe("capability-check", () => {
  describe("hasCapability", () => {
    it("should return true for CLI auth (no capabilities)", () => {
      expect(hasCapability({ userId: "user-1" }, "volume:read")).toBe(true);
    });

    it("should return true for sandbox auth with matching capability", () => {
      expect(
        hasCapability(
          { userId: "user-1", runId: "run-1", capabilities: ["volume:read"] },
          "volume:read",
        ),
      ).toBe(true);
    });

    it("should return false for sandbox auth without matching capability", () => {
      expect(
        hasCapability(
          { userId: "user-1", runId: "run-1", capabilities: ["volume:read"] },
          "artifact:write",
        ),
      ).toBe(false);
    });

    it("should return false for sandbox auth with empty capabilities", () => {
      expect(
        hasCapability(
          { userId: "user-1", runId: "run-1", capabilities: [] },
          "volume:read",
        ),
      ).toBe(false);
    });
  });

  describe("isSandboxAuth", () => {
    it("should return false for CLI auth", () => {
      expect(isSandboxAuth({ userId: "user-1" })).toBe(false);
    });

    it("should return true for sandbox auth", () => {
      expect(isSandboxAuth({ userId: "user-1", runId: "run-1" })).toBe(true);
    });
  });

  describe("storageCapability", () => {
    it("should map storage type and action to capability string", () => {
      expect(storageCapability("volume", "read")).toBe("volume:read");
      expect(storageCapability("volume", "write")).toBe("volume:write");
      expect(storageCapability("artifact", "read")).toBe("artifact:read");
      expect(storageCapability("artifact", "write")).toBe("artifact:write");
      expect(storageCapability("memory", "read")).toBe("memory:read");
      expect(storageCapability("memory", "write")).toBe("memory:write");
    });
  });

  describe("missingCapabilityError", () => {
    it("should return 403 error body with capability name", () => {
      const error = missingCapabilityError("volume:read");

      expect(error.error.message).toBe(
        "Missing required capability: volume:read",
      );
      expect(error.error.code).toBe("FORBIDDEN");
    });
  });
});
