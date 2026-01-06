import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Version ID query parameter schema (copied from storages.ts for testing)
 *
 * Handles jsonQuery edge case where hex strings like "846e3519"
 * are parsed as JavaScript scientific notation numbers.
 */
const versionQuerySchema = z.preprocess(
  (val) => (val === undefined || val === null ? undefined : String(val)),
  z
    .string()
    .regex(/^[a-f0-9]{8,64}$/i, "Version must be 8-64 hex characters")
    .optional(),
);

/**
 * Compose version query schema (copied from composes.ts for testing)
 * Also accepts "latest" tag
 */
const composeVersionQuerySchema = z.preprocess(
  (val) => (val === undefined || val === null ? undefined : String(val)),
  z
    .string()
    .min(1, "Missing version query parameter")
    .regex(
      /^[a-f0-9]{8,64}$|^latest$/i,
      "Version must be 8-64 hex characters or 'latest'",
    ),
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

    it("should accept null (converts to undefined)", () => {
      expect(versionQuerySchema.parse(null)).toBeUndefined();
    });

    it("should accept uppercase hex characters", () => {
      expect(versionQuerySchema.parse("ABCD1234")).toBe("ABCD1234");
    });

    it("should accept mixed case hex characters", () => {
      expect(versionQuerySchema.parse("AbCd1234")).toBe("AbCd1234");
    });

    it("should handle scientific notation hex strings correctly", () => {
      // This is the exact case that caused the flaky test
      // "846e3519" looks like scientific notation to JSON.parse
      expect(versionQuerySchema.parse("846e3519")).toBe("846e3519");
    });

    it("should handle another scientific notation pattern", () => {
      expect(versionQuerySchema.parse("123e4567")).toBe("123e4567");
    });
  });

  describe("invalid inputs - numbers from JSON.parse", () => {
    it("should convert Infinity (from JSON.parse) to string and reject", () => {
      // JSON.parse("846e3519") returns Infinity
      expect(() => versionQuerySchema.parse(Infinity)).toThrow(
        "Version must be 8-64 hex characters",
      );
    });

    it("should convert plain number to string - valid if 8+ hex digits", () => {
      // JSON.parse("12345678") returns 12345678
      // String(12345678) = "12345678" which IS valid hex (0-9 are hex chars)
      expect(versionQuerySchema.parse(12345678)).toBe("12345678");
    });

    it("should convert short number to string and reject", () => {
      // String(1234567) = "1234567" (7 chars, too short)
      expect(() => versionQuerySchema.parse(1234567)).toThrow(
        "Version must be 8-64 hex characters",
      );
    });

    it("should convert NaN to string and reject", () => {
      expect(() => versionQuerySchema.parse(NaN)).toThrow(
        "Version must be 8-64 hex characters",
      );
    });
  });

  describe("invalid inputs - bad format", () => {
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

    it("should handle scientific notation hex strings correctly", () => {
      expect(composeVersionQuerySchema.parse("846e3519")).toBe("846e3519");
    });
  });

  describe("invalid inputs - numbers from JSON.parse", () => {
    it("should convert Infinity to string and reject", () => {
      expect(() => composeVersionQuerySchema.parse(Infinity)).toThrow(
        "Version must be 8-64 hex characters or 'latest'",
      );
    });

    it("should convert plain number to string - valid if 8+ hex digits", () => {
      // String(12345678) = "12345678" which IS valid hex
      expect(composeVersionQuerySchema.parse(12345678)).toBe("12345678");
    });

    it("should convert short number to string and reject", () => {
      expect(() => composeVersionQuerySchema.parse(1234567)).toThrow(
        "Version must be 8-64 hex characters or 'latest'",
      );
    });
  });

  describe("invalid inputs - bad format", () => {
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
