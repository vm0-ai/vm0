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
      expect(hasCapability({ userId: "user-1" }, "storage:read")).toBe(true);
    });

    it("should return true for sandbox auth with matching capability", () => {
      expect(
        hasCapability(
          { userId: "user-1", runId: "run-1", capabilities: ["storage:read"] },
          "storage:read",
        ),
      ).toBe(true);
    });

    it("should return false for sandbox auth without matching capability", () => {
      expect(
        hasCapability(
          { userId: "user-1", runId: "run-1", capabilities: ["storage:read"] },
          "storage:write",
        ),
      ).toBe(false);
    });

    it("should return false for sandbox auth with empty capabilities", () => {
      expect(
        hasCapability(
          { userId: "user-1", runId: "run-1", capabilities: [] },
          "storage:read",
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
    it("should map all storage types to unified storage capability", () => {
      expect(storageCapability("volume", "read")).toBe("storage:read");
      expect(storageCapability("volume", "write")).toBe("storage:write");
      expect(storageCapability("artifact", "read")).toBe("storage:read");
      expect(storageCapability("artifact", "write")).toBe("storage:write");
      expect(storageCapability("memory", "read")).toBe("storage:read");
      expect(storageCapability("memory", "write")).toBe("storage:write");
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
