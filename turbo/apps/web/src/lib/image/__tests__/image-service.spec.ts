import { describe, expect, it } from "vitest";
import { generateE2bAlias, isSystemTemplate } from "../image-service";

describe("Image Service", () => {
  describe("generateE2bAlias", () => {
    it("should generate E2B alias with user prefix", () => {
      const alias = generateE2bAlias("user123", "my-agent");
      expect(alias).toBe("user-user123-my-agent");
    });

    it("should handle different user IDs", () => {
      const alias1 = generateE2bAlias("abc", "test");
      const alias2 = generateE2bAlias("xyz", "test");
      expect(alias1).toBe("user-abc-test");
      expect(alias2).toBe("user-xyz-test");
    });

    it("should handle special characters in user ID", () => {
      const alias = generateE2bAlias("user_abc-123", "my-image");
      expect(alias).toBe("user-user_abc-123-my-image");
    });
  });

  describe("isSystemTemplate", () => {
    it("should return true for vm0- prefixed templates", () => {
      expect(isSystemTemplate("vm0-claude-code")).toBe(true);
      expect(isSystemTemplate("vm0-base")).toBe(true);
      expect(isSystemTemplate("vm0-")).toBe(true);
    });

    it("should return false for user templates", () => {
      expect(isSystemTemplate("my-agent")).toBe(false);
      expect(isSystemTemplate("user-abc-test")).toBe(false);
      expect(isSystemTemplate("custom-template")).toBe(false);
    });

    it("should return false for templates that contain but don't start with vm0-", () => {
      expect(isSystemTemplate("my-vm0-agent")).toBe(false);
      expect(isSystemTemplate("test-vm0-")).toBe(false);
    });

    it("should be case sensitive", () => {
      expect(isSystemTemplate("VM0-test")).toBe(false);
      expect(isSystemTemplate("Vm0-test")).toBe(false);
    });
  });
});
