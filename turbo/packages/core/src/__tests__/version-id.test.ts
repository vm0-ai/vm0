import { describe, it, expect } from "vitest";
import {
  VERSION_ID_LENGTH,
  VERSION_ID_DISPLAY_LENGTH,
  MIN_VERSION_PREFIX_LENGTH,
  formatVersionIdForDisplay,
  isValidVersionPrefix,
} from "../version-id";

describe("version-id", () => {
  describe("constants", () => {
    it("VERSION_ID_LENGTH should be 64 (SHA256 hex)", () => {
      expect(VERSION_ID_LENGTH).toBe(64);
    });

    it("VERSION_ID_DISPLAY_LENGTH should be 8 (matches artifact/storage)", () => {
      expect(VERSION_ID_DISPLAY_LENGTH).toBe(8);
    });

    it("MIN_VERSION_PREFIX_LENGTH should be 8 (matches artifact/storage)", () => {
      expect(MIN_VERSION_PREFIX_LENGTH).toBe(8);
    });
  });

  describe("formatVersionIdForDisplay", () => {
    it("should return first 8 characters of version ID", () => {
      const fullVersionId =
        "a1b2c3d4e5f6789012345678901234567890123456789012345678901234";
      expect(formatVersionIdForDisplay(fullVersionId)).toBe("a1b2c3d4");
    });

    it("should handle version IDs shorter than display length", () => {
      const shortVersionId = "a1b2c3";
      expect(formatVersionIdForDisplay(shortVersionId)).toBe("a1b2c3");
    });

    it("should handle empty string", () => {
      expect(formatVersionIdForDisplay("")).toBe("");
    });
  });

  describe("isValidVersionPrefix", () => {
    it("should return true for valid hex prefix of minimum length (8+)", () => {
      expect(isValidVersionPrefix("a1b2c3d4")).toBe(true);
      expect(isValidVersionPrefix("a1b2c3d4e5f6")).toBe(true);
    });

    it("should return true for uppercase hex characters", () => {
      expect(isValidVersionPrefix("A1B2C3D4")).toBe(true);
      expect(isValidVersionPrefix("A1B2C3D4E5F6")).toBe(true);
    });

    it("should return false for prefix shorter than minimum length (8)", () => {
      expect(isValidVersionPrefix("a")).toBe(false);
      expect(isValidVersionPrefix("a1b2")).toBe(false);
      expect(isValidVersionPrefix("a1b2c3")).toBe(false);
      expect(isValidVersionPrefix("a1b2c3d")).toBe(false); // 7 chars
    });

    it("should return false for non-hex characters", () => {
      expect(isValidVersionPrefix("ghijklmn")).toBe(false);
      expect(isValidVersionPrefix("a1b2c3d4-")).toBe(false);
      expect(isValidVersionPrefix("a1b2c3d4_")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isValidVersionPrefix("")).toBe(false);
    });
  });
});
