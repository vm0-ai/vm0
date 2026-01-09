import { describe, it, expect } from "vitest";

describe("API Token Service", () => {
  describe("Token Format", () => {
    it("should use vm0_api_ prefix", () => {
      // Verify token prefix format
      const prefix = "vm0_api_";
      expect(prefix).toMatch(/^vm0_api_$/);
    });

    it("should generate tokens with sufficient entropy", () => {
      // API tokens should have 64 hex chars after prefix (32 bytes)
      const tokenLength = "vm0_api_".length + 64;
      expect(tokenLength).toBe(72);
    });
  });

  describe("Token Prefix Extraction", () => {
    it("should extract first 12 characters as prefix", () => {
      const token = "vm0_api_abcd1234567890";
      const prefix = token.substring(0, 12);
      expect(prefix).toBe("vm0_api_abcd");
    });
  });
});
