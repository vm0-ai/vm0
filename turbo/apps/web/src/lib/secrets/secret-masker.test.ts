import { describe, it, expect } from "vitest";
import {
  createSecretMasker,
  MASK_PLACEHOLDER,
  MIN_SECRET_LENGTH,
} from "./secret-masker";

describe("secret-masker", () => {
  describe("createSecretMasker", () => {
    it("should mask a simple string containing a secret", () => {
      const masker = createSecretMasker(["my-secret-token"]);
      const result = masker.mask("The token is my-secret-token here");

      expect(result).toBe(`The token is ${MASK_PLACEHOLDER} here`);
    });

    it("should mask multiple occurrences of the same secret", () => {
      const masker = createSecretMasker(["secret123"]);
      const result = masker.mask("secret123 and again secret123");

      expect(result).toBe(`${MASK_PLACEHOLDER} and again ${MASK_PLACEHOLDER}`);
    });

    it("should mask multiple different secrets", () => {
      const masker = createSecretMasker(["password123", "api-key-xyz"]);
      const result = masker.mask("password123 and api-key-xyz");

      expect(result).toBe(`${MASK_PLACEHOLDER} and ${MASK_PLACEHOLDER}`);
    });

    it("should not mask secrets shorter than MIN_SECRET_LENGTH", () => {
      const masker = createSecretMasker(["abc", "1234"]); // 3 and 4 chars
      const result = masker.mask("abc and 1234 should not be masked");

      expect(result).toBe("abc and 1234 should not be masked");
    });

    it("should mask secrets exactly at MIN_SECRET_LENGTH", () => {
      const secret = "a".repeat(MIN_SECRET_LENGTH);
      const masker = createSecretMasker([secret]);
      const result = masker.mask(`The value is ${secret} here`);

      expect(result).toBe(`The value is ${MASK_PLACEHOLDER} here`);
    });

    it("should return string unchanged when no secrets match", () => {
      const masker = createSecretMasker(["secret123"]);
      const result = masker.mask("No secrets here");

      expect(result).toBe("No secrets here");
    });

    it("should handle empty secrets array", () => {
      const masker = createSecretMasker([]);
      const result = masker.mask("Some text");

      expect(result).toBe("Some text");
    });

    it("should handle empty string input", () => {
      const masker = createSecretMasker(["secret123"]);
      const result = masker.mask("");

      expect(result).toBe("");
    });

    it("should handle null and undefined values", () => {
      const masker = createSecretMasker(["secret123"]);

      expect(masker.mask(null)).toBe(null);
      expect(masker.mask(undefined)).toBe(undefined);
    });

    it("should preserve non-string primitive values", () => {
      const masker = createSecretMasker(["secret123"]);

      expect(masker.mask(42)).toBe(42);
      expect(masker.mask(true)).toBe(true);
      expect(masker.mask(false)).toBe(false);
      expect(masker.mask(3.14)).toBe(3.14);
    });
  });

  describe("nested object masking", () => {
    it("should mask secrets in nested objects", () => {
      const masker = createSecretMasker(["secret-value"]);
      const input = {
        level1: {
          level2: {
            data: "contains secret-value here",
          },
        },
      };

      const result = masker.mask(input);

      expect(result).toEqual({
        level1: {
          level2: {
            data: `contains ${MASK_PLACEHOLDER} here`,
          },
        },
      });
    });

    it("should mask secrets in object with mixed value types", () => {
      const masker = createSecretMasker(["my-password"]);
      const input = {
        username: "john",
        password: "my-password",
        count: 42,
        active: true,
        metadata: null,
      };

      const result = masker.mask(input);

      expect(result).toEqual({
        username: "john",
        password: MASK_PLACEHOLDER,
        count: 42,
        active: true,
        metadata: null,
      });
    });
  });

  describe("array masking", () => {
    it("should mask secrets in arrays", () => {
      const masker = createSecretMasker(["secret-item"]);
      const input = ["normal", "secret-item", "another"];

      const result = masker.mask(input);

      expect(result).toEqual(["normal", MASK_PLACEHOLDER, "another"]);
    });

    it("should mask secrets in arrays of objects", () => {
      const masker = createSecretMasker(["api-token"]);
      const input = [
        { name: "item1", token: "api-token" },
        { name: "item2", token: "public" },
      ];

      const result = masker.mask(input);

      expect(result).toEqual([
        { name: "item1", token: MASK_PLACEHOLDER },
        { name: "item2", token: "public" },
      ]);
    });

    it("should handle nested arrays", () => {
      const masker = createSecretMasker(["secret123"]);
      const input = [["secret123", "normal"], ["another"]];

      const result = masker.mask(input);

      expect(result).toEqual([[MASK_PLACEHOLDER, "normal"], ["another"]]);
    });
  });

  describe("encoding variants", () => {
    it("should mask Base64 encoded secrets", () => {
      const secret = "my-secret-value";
      const base64 = Buffer.from(secret).toString("base64");
      const masker = createSecretMasker([secret]);

      const result = masker.mask(`Token: ${base64}`);

      expect(result).toBe(`Token: ${MASK_PLACEHOLDER}`);
    });

    it("should mask URL encoded secrets", () => {
      const secret = "secret with spaces";
      const urlEncoded = encodeURIComponent(secret);
      const masker = createSecretMasker([secret]);

      const result = masker.mask(`Param: ${urlEncoded}`);

      expect(result).toBe(`Param: ${MASK_PLACEHOLDER}`);
    });

    it("should mask both original and encoded versions", () => {
      const secret = "api-key-123";
      const base64 = Buffer.from(secret).toString("base64");
      const masker = createSecretMasker([secret]);

      const result = masker.mask(`Original: ${secret}, Encoded: ${base64}`);

      expect(result).toBe(
        `Original: ${MASK_PLACEHOLDER}, Encoded: ${MASK_PLACEHOLDER}`,
      );
    });

    it("should not add URL encoding if same as original", () => {
      // URL encoding of simple alphanumeric string is the same as original
      const secret = "simpleSecret123";
      const masker = createSecretMasker([secret]);

      // Should still work correctly
      const result = masker.mask(`Value: ${secret}`);

      expect(result).toBe(`Value: ${MASK_PLACEHOLDER}`);
    });
  });

  describe("edge cases", () => {
    it("should handle overlapping secrets (longer first)", () => {
      const masker = createSecretMasker(["secret", "secret-extended"]);
      const result = masker.mask("Value: secret-extended");

      // Longer secret should be masked first
      expect(result).toBe(`Value: ${MASK_PLACEHOLDER}`);
    });

    it("should handle secret that is substring of another", () => {
      const masker = createSecretMasker(["password", "my-password-123"]);
      const result = masker.mask("Using my-password-123 here");

      expect(result).toBe(`Using ${MASK_PLACEHOLDER} here`);
    });

    it("should filter out empty strings from secrets", () => {
      const masker = createSecretMasker(["", "valid-secret"]);
      const result = masker.mask("Contains valid-secret here");

      expect(result).toBe(`Contains ${MASK_PLACEHOLDER} here`);
    });

    it("should handle secrets with special regex characters", () => {
      const secret = "pass.word*test+value";
      const masker = createSecretMasker([secret]);
      const result = masker.mask(`Secret: ${secret}`);

      expect(result).toBe(`Secret: ${MASK_PLACEHOLDER}`);
    });

    it("should handle real-world event data structure", () => {
      const masker = createSecretMasker(["sk-proj-abc123xyz"]);
      const eventData = {
        type: "tool_use",
        timestamp: 1702345678,
        sessionId: "sess-123",
        data: {
          tool: "bash",
          input:
            "curl -H 'Authorization: Bearer sk-proj-abc123xyz' https://api.example.com",
          output: "Response received",
        },
      };

      const result = masker.mask(eventData);

      expect(result).toEqual({
        type: "tool_use",
        timestamp: 1702345678,
        sessionId: "sess-123",
        data: {
          tool: "bash",
          input: `curl -H 'Authorization: Bearer ${MASK_PLACEHOLDER}' https://api.example.com`,
          output: "Response received",
        },
      });
    });
  });
});
