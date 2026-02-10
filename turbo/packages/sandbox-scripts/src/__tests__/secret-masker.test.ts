import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretMasker } from "../scripts/lib/secret-masker";

describe("secret-masker", () => {
  describe("SecretMasker class", () => {
    describe("constructor", () => {
      it("should create empty patterns for empty array", () => {
        const masker = new SecretMasker([]);
        expect(masker.mask("test string")).toBe("test string");
      });

      it("should ignore secrets shorter than 5 characters", () => {
        const masker = new SecretMasker(["abc", "1234", "test"]);
        expect(masker.mask("abc 1234 test")).toBe("abc 1234 test");
      });

      it("should accept secrets of 5+ characters", () => {
        const masker = new SecretMasker(["secret"]);
        expect(masker.mask("my secret value")).toBe("my *** value");
      });

      it("should ignore empty strings and null-like values", () => {
        const masker = new SecretMasker(["", "validSecret"]);
        expect(masker.mask("validSecret")).toBe("***");
      });
    });

    describe("pattern generation", () => {
      it("should mask original value", () => {
        const masker = new SecretMasker(["api-key-123"]);
        expect(masker.mask("token: api-key-123")).toBe("token: ***");
      });

      it("should mask base64 encoded value", () => {
        const secret = "api-key-123";
        const base64 = Buffer.from(secret).toString("base64"); // YXBpLWtleS0xMjM=
        const masker = new SecretMasker([secret]);
        expect(masker.mask(`header: ${base64}`)).toBe("header: ***");
      });

      it("should mask URL encoded value", () => {
        const secret = "key&value=test";
        const urlEncoded = encodeURIComponent(secret); // key%26value%3Dtest
        const masker = new SecretMasker([secret]);
        expect(masker.mask(`param: ${urlEncoded}`)).toBe("param: ***");
      });

      it("should mask multiple occurrences", () => {
        const masker = new SecretMasker(["secret"]);
        expect(masker.mask("secret and secret again")).toBe(
          "*** and *** again",
        );
      });

      it("should mask multiple different secrets", () => {
        const masker = new SecretMasker(["secret1", "secret2"]);
        expect(masker.mask("secret1 and secret2")).toBe("*** and ***");
      });
    });

    describe("mask() method", () => {
      it("should mask strings", () => {
        const masker = new SecretMasker(["password"]);
        expect(masker.mask("my password is here")).toBe("my *** is here");
      });

      it("should mask arrays recursively", () => {
        const masker = new SecretMasker(["secret"]);
        const input = ["secret", "public", "another secret"];
        expect(masker.mask(input)).toEqual(["***", "public", "another ***"]);
      });

      it("should mask nested arrays", () => {
        const masker = new SecretMasker(["secret"]);
        const input = [["secret"], ["nested", ["deep secret"]]];
        expect(masker.mask(input)).toEqual([["***"], ["nested", ["deep ***"]]]);
      });

      it("should mask objects recursively", () => {
        const masker = new SecretMasker(["secret"]);
        const input = { key: "secret", nested: { value: "secret here" } };
        expect(masker.mask(input)).toEqual({
          key: "***",
          nested: { value: "*** here" },
        });
      });

      it("should mask mixed arrays and objects", () => {
        const masker = new SecretMasker(["secret"]);
        const input = {
          items: ["secret", { key: "secret value" }],
          data: { nested: ["contains secret"] },
        };
        expect(masker.mask(input)).toEqual({
          items: ["***", { key: "*** value" }],
          data: { nested: ["contains ***"] },
        });
      });

      it("should pass through primitives unchanged", () => {
        const masker = new SecretMasker(["secret"]);
        expect(masker.mask(123)).toBe(123);
        expect(masker.mask(true)).toBe(true);
        expect(masker.mask(false)).toBe(false);
        expect(masker.mask(null)).toBe(null);
        expect(masker.mask(undefined)).toBe(undefined);
      });

      it("should handle empty objects and arrays", () => {
        const masker = new SecretMasker(["secret"]);
        expect(masker.mask({})).toEqual({});
        expect(masker.mask([])).toEqual([]);
      });
    });

    describe("edge cases", () => {
      it("should handle secrets with special regex characters", () => {
        const secret = "pass.word*test";
        const masker = new SecretMasker([secret]);
        expect(masker.mask(`my ${secret} here`)).toBe("my *** here");
      });

      it("should handle overlapping secrets", () => {
        const masker = new SecretMasker(["secret", "secretKey"]);
        // "secret" is masked first, leaving "Key"
        // Note: Order depends on Set iteration, but both should be masked
        expect(masker.mask("secretKey")).toContain("***");
        expect(masker.mask("secret")).toBe("***");
      });

      it("should handle very long secrets", () => {
        const longSecret = "a".repeat(1000);
        const masker = new SecretMasker([longSecret]);
        expect(masker.mask(`prefix ${longSecret} suffix`)).toBe(
          "prefix *** suffix",
        );
      });

      it("should not affect strings without the secret pattern", () => {
        const masker = new SecretMasker(["password"]);
        expect(masker.mask("no secrets here")).toBe("no secrets here");
      });

      it("should mask substrings that contain the secret", () => {
        // The masker does substring matching, so "secret" in "secrets" is masked
        const masker = new SecretMasker(["secret"]);
        expect(masker.mask("no secrets here")).toBe("no ***s here");
      });
    });
  });

  describe("getMasker and maskData", () => {
    const originalEnv = process.env.VM0_SECRET_VALUES;

    beforeEach(() => {
      // Reset the global masker by clearing the module cache
      vi.resetModules();
    });

    afterEach(() => {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.VM0_SECRET_VALUES = originalEnv;
      } else {
        delete process.env.VM0_SECRET_VALUES;
      }
    });

    it("should return empty masker when VM0_SECRET_VALUES is not set", async () => {
      delete process.env.VM0_SECRET_VALUES;
      const { getMasker: freshGetMasker } = await import(
        "../scripts/lib/secret-masker"
      );
      const masker = freshGetMasker();
      expect(masker.mask("test secret")).toBe("test secret");
    });

    it("should parse base64-encoded secrets from VM0_SECRET_VALUES", async () => {
      // "mySecret" base64 encoded is "bXlTZWNyZXQ="
      const secret = "mySecret";
      const encoded = Buffer.from(secret).toString("base64");
      process.env.VM0_SECRET_VALUES = encoded;

      const { getMasker: freshGetMasker } = await import(
        "../scripts/lib/secret-masker"
      );
      const masker = freshGetMasker();
      expect(masker.mask("my mySecret here")).toBe("my *** here");
    });

    it("should parse multiple comma-separated secrets", async () => {
      const secret1 = "secret1";
      const secret2 = "secret2";
      const encoded1 = Buffer.from(secret1).toString("base64");
      const encoded2 = Buffer.from(secret2).toString("base64");
      process.env.VM0_SECRET_VALUES = `${encoded1},${encoded2}`;

      const { getMasker: freshGetMasker } = await import(
        "../scripts/lib/secret-masker"
      );
      const masker = freshGetMasker();
      expect(masker.mask("secret1 and secret2")).toBe("*** and ***");
    });

    it("should handle whitespace in comma-separated values", async () => {
      const secret = "mySecret";
      const encoded = Buffer.from(secret).toString("base64");
      process.env.VM0_SECRET_VALUES = `  ${encoded}  ,  ${encoded}  `;

      const { getMasker: freshGetMasker } = await import(
        "../scripts/lib/secret-masker"
      );
      const masker = freshGetMasker();
      expect(masker.mask("mySecret")).toBe("***");
    });

    it("should skip invalid base64 values", async () => {
      const validSecret = "validSecret";
      const validEncoded = Buffer.from(validSecret).toString("base64");
      // "!!!" is not valid base64
      process.env.VM0_SECRET_VALUES = `${validEncoded},not-valid-base64-!!!`;

      const { getMasker: freshGetMasker } = await import(
        "../scripts/lib/secret-masker"
      );
      const masker = freshGetMasker();
      expect(masker.mask("validSecret")).toBe("***");
    });
  });
});
