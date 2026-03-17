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
    it("should map volume to agent capability", () => {
      expect(storageCapability("read", "volume")).toBe("agent:read");
      expect(storageCapability("write", "volume")).toBe("agent:write");
    });

    it("should map artifact to artifact capability", () => {
      expect(storageCapability("read", "artifact")).toBe("artifact:read");
      expect(storageCapability("write", "artifact")).toBe("artifact:write");
    });

    it("should map memory to artifact capability", () => {
      expect(storageCapability("read", "memory")).toBe("artifact:read");
      expect(storageCapability("write", "memory")).toBe("artifact:write");
    });

    it("should default to artifact capability when no type provided", () => {
      expect(storageCapability("read")).toBe("artifact:read");
      expect(storageCapability("write")).toBe("artifact:write");
    });
  });

  describe("missingCapabilityError", () => {
    it("should return 403 error body with capability name", () => {
      const error = missingCapabilityError("artifact:read");

      expect(error.error.message).toBe(
        "Missing required capability: artifact:read",
      );
      expect(error.error.code).toBe("FORBIDDEN");
    });
  });
});
