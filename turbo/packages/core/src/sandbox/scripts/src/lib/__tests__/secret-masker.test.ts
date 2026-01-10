/**
 * Unit tests for secret-masker module.
 */
import { describe, it, expect } from "vitest";
import { SecretMasker } from "../secret-masker";

describe("SecretMasker", () => {
  describe("constructor", () => {
    it("should create masker with empty secret list", () => {
      const masker = new SecretMasker([]);
      expect(masker.mask("hello")).toBe("hello");
    });

    it("should skip secrets shorter than 5 characters", () => {
      const masker = new SecretMasker(["abc", "1234"]);
      expect(masker.mask("abc 1234")).toBe("abc 1234");
    });

    it("should accept secrets 5 characters or longer", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask("my secret value")).toBe("my *** value");
    });

    it("should skip empty strings", () => {
      const masker = new SecretMasker([""]);
      expect(masker.mask("hello")).toBe("hello");
    });
  });

  describe("mask strings", () => {
    it("should mask exact secret in string", () => {
      const masker = new SecretMasker(["my-secret-key"]);
      expect(masker.mask("token: my-secret-key")).toBe("token: ***");
    });

    it("should mask multiple occurrences", () => {
      const masker = new SecretMasker(["password123"]);
      expect(masker.mask("password123 and password123")).toBe("*** and ***");
    });

    it("should mask multiple different secrets", () => {
      const masker = new SecretMasker(["secret1", "secret2"]);
      expect(masker.mask("secret1 and secret2")).toBe("*** and ***");
    });

    it("should not mask partial matches", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask("sec")).toBe("sec");
    });

    it("should preserve string without secrets", () => {
      const masker = new SecretMasker(["my-api-key"]);
      expect(masker.mask("hello world")).toBe("hello world");
    });
  });

  describe("mask base64 encoded variants", () => {
    it("should mask base64-encoded secret", () => {
      const secret = "my-secret-key";
      const base64 = Buffer.from(secret).toString("base64"); // bXktc2VjcmV0LWtleQ==
      const masker = new SecretMasker([secret]);
      expect(masker.mask(`encoded: ${base64}`)).toBe("encoded: ***");
    });

    it("should mask both original and base64 in same string", () => {
      const secret = "api-token-12345";
      const base64 = Buffer.from(secret).toString("base64");
      const masker = new SecretMasker([secret]);
      expect(masker.mask(`plain: ${secret}, encoded: ${base64}`)).toBe(
        "plain: ***, encoded: ***",
      );
    });
  });

  describe("mask URL encoded variants", () => {
    it("should mask URL-encoded secret with special chars", () => {
      const secret = "pass@word!";
      const urlEnc = encodeURIComponent(secret); // pass%40word%21
      const masker = new SecretMasker([secret]);
      expect(masker.mask(`url: ${urlEnc}`)).toBe("url: ***");
    });

    it("should not add URL encoding if same as original", () => {
      // Simple secret without special chars doesn't change with URL encoding
      const secret = "simplepassword";
      const masker = new SecretMasker([secret]);
      // Verify the secret is masked but URL encoding doesn't create extra patterns
      expect(masker.mask(secret)).toBe("***");
    });
  });

  describe("mask objects", () => {
    it("should recursively mask secrets in objects", () => {
      const masker = new SecretMasker(["secret-value"]);
      const input = {
        key: "secret-value",
        nested: {
          data: "has secret-value inside",
        },
      };
      const result = masker.mask(input);
      expect(result).toEqual({
        key: "***",
        nested: {
          data: "has *** inside",
        },
      });
    });

    it("should preserve non-string values in objects", () => {
      const masker = new SecretMasker(["secret"]);
      const input = {
        str: "secret",
        num: 123,
        bool: true,
        nil: null,
      };
      const result = masker.mask(input);
      expect(result).toEqual({
        str: "***",
        num: 123,
        bool: true,
        nil: null,
      });
    });
  });

  describe("mask arrays", () => {
    it("should mask secrets in arrays", () => {
      const masker = new SecretMasker(["secret"]);
      const input = ["hello", "secret", "world"];
      const result = masker.mask(input);
      expect(result).toEqual(["hello", "***", "world"]);
    });

    it("should mask nested arrays", () => {
      const masker = new SecretMasker(["secret"]);
      const input = [["secret"], [{ key: "secret" }]];
      const result = masker.mask(input);
      expect(result).toEqual([["***"], [{ key: "***" }]]);
    });
  });

  describe("mask mixed structures", () => {
    it("should handle complex nested structures", () => {
      const masker = new SecretMasker(["api-key-12345"]);
      const input = {
        users: [
          { name: "Alice", token: "api-key-12345" },
          { name: "Bob", token: "public-token" },
        ],
        config: {
          auth: {
            key: "api-key-12345",
          },
        },
      };
      const result = masker.mask(input);
      expect(result).toEqual({
        users: [
          { name: "Alice", token: "***" },
          { name: "Bob", token: "public-token" },
        ],
        config: {
          auth: {
            key: "***",
          },
        },
      });
    });
  });

  describe("edge cases", () => {
    it("should handle undefined", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask(undefined)).toBe(undefined);
    });

    it("should handle numbers", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask(12345)).toBe(12345);
    });

    it("should handle booleans", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask(true)).toBe(true);
      expect(masker.mask(false)).toBe(false);
    });

    it("should handle empty string", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask("")).toBe("");
    });

    it("should handle empty object", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask({})).toEqual({});
    });

    it("should handle empty array", () => {
      const masker = new SecretMasker(["secret"]);
      expect(masker.mask([])).toEqual([]);
    });
  });
});
