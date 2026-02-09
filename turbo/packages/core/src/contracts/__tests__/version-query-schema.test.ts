import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Version ID query parameter schema (copied from storages.ts for testing)
 */
const versionQuerySchema = z
  .string()
  .regex(/^[a-f0-9]{8,64}$/i, "Version must be 8-64 hex characters")
  .optional();

/**
 * Compose version query schema (copied from composes.ts for testing)
 * Also accepts "latest" tag
 */
const composeVersionQuerySchema = z
  .string()
  .min(1, "Missing version query parameter")
  .regex(
    /^[a-f0-9]{8,64}$|^latest$/i,
    "Version must be 8-64 hex characters or 'latest'",
  );

describe("versionQuerySchema (storages)", () => {
  describe("valid inputs", () => {
    it("should accept valid 8-char hex string", () => {
      expect(versionQuerySchema.parse("abcd1234")).toBe("abcd1234");
    });

    it("should accept valid 64-char hex string (full SHA-256)", () => {
      const fullHash =
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
      expect(versionQuerySchema.parse(fullHash)).toBe(fullHash);
    });

    it("should accept undefined (optional)", () => {
      expect(versionQuerySchema.parse(undefined)).toBeUndefined();
    });

    it("should accept uppercase hex characters", () => {
      expect(versionQuerySchema.parse("ABCD1234")).toBe("ABCD1234");
    });

    it("should accept mixed case hex characters", () => {
      expect(versionQuerySchema.parse("AbCd1234")).toBe("AbCd1234");
    });

    it("should accept hex strings that resemble scientific notation", () => {
      // "846e3519" looks like scientific notation to JSON.parse but is valid hex
      expect(versionQuerySchema.parse("846e3519")).toBe("846e3519");
    });

    it("should accept another scientific notation pattern", () => {
      expect(versionQuerySchema.parse("123e4567")).toBe("123e4567");
    });
  });

  describe("invalid inputs", () => {
    it("should reject strings shorter than 8 chars", () => {
      expect(() => versionQuerySchema.parse("abc1234")).toThrow(
        "Version must be 8-64 hex characters",
      );
    });

    it("should reject strings longer than 64 chars", () => {
      const tooLong = "a".repeat(65);
      expect(() => versionQuerySchema.parse(tooLong)).toThrow(
        "Version must be 8-64 hex characters",
      );
    });

    it("should reject strings with non-hex characters", () => {
      expect(() => versionQuerySchema.parse("ghijklmn")).toThrow(
        "Version must be 8-64 hex characters",
      );
    });

    it("should reject empty string", () => {
      expect(() => versionQuerySchema.parse("")).toThrow(
        "Version must be 8-64 hex characters",
      );
    });

    it("should reject 'latest' (not valid for storage versions)", () => {
      expect(() => versionQuerySchema.parse("latest")).toThrow(
        "Version must be 8-64 hex characters",
      );
    });
  });
});

describe("composeVersionQuerySchema (composes)", () => {
  describe("valid inputs", () => {
    it("should accept valid 8-char hex string", () => {
      expect(composeVersionQuerySchema.parse("abcd1234")).toBe("abcd1234");
    });

    it("should accept 'latest' tag", () => {
      expect(composeVersionQuerySchema.parse("latest")).toBe("latest");
    });

    it("should accept 'LATEST' (case insensitive)", () => {
      expect(composeVersionQuerySchema.parse("LATEST")).toBe("LATEST");
    });

    it("should accept hex strings that resemble scientific notation", () => {
      expect(composeVersionQuerySchema.parse("846e3519")).toBe("846e3519");
    });
  });

  describe("invalid inputs", () => {
    it("should reject undefined (required field)", () => {
      expect(() => composeVersionQuerySchema.parse(undefined)).toThrow();
    });

    it("should reject empty string", () => {
      expect(() => composeVersionQuerySchema.parse("")).toThrow(
        "Missing version query parameter",
      );
    });

    it("should reject strings shorter than 8 chars (not 'latest')", () => {
      expect(() => composeVersionQuerySchema.parse("abc1234")).toThrow(
        "Version must be 8-64 hex characters or 'latest'",
      );
    });
  });
});
