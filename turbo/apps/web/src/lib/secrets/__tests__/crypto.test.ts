import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock env module before importing crypto
// Path: src/lib/secrets/__tests__ -> src/env = ../../../env
vi.mock("../../../env", () => ({
  env: () => ({
    SECRETS_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    NODE_ENV: "test",
  }),
}));

describe("crypto", () => {
  let encryptSecret: (plaintext: string) => string;
  let decryptSecret: (encryptedValue: string) => string;

  beforeAll(async () => {
    // Dynamic import after mock is set up
    const crypto = await import("../crypto");
    encryptSecret = crypto.encryptSecret;
    decryptSecret = crypto.decryptSecret;
  });

  describe("encryptSecret", () => {
    it("encrypts a string and returns base64", () => {
      const plaintext = "my-secret-value";
      const encrypted = encryptSecret(plaintext);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe("string");
      // Should be base64 encoded
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
      // Should not equal plaintext
      expect(encrypted).not.toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random IV)", () => {
      const plaintext = "my-secret-value";
      const encrypted1 = encryptSecret(plaintext);
      const encrypted2 = encryptSecret(plaintext);

      // Due to random IV, same plaintext should produce different ciphertext
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("handles empty string", () => {
      const encrypted = encryptSecret("");
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe("string");
    });

    it("handles unicode characters", () => {
      const plaintext = "密码🔐パスワード";
      const encrypted = encryptSecret(plaintext);
      expect(encrypted).toBeDefined();
    });

    it("handles large values", () => {
      const plaintext = "x".repeat(10000);
      const encrypted = encryptSecret(plaintext);
      expect(encrypted).toBeDefined();
    });
  });

  describe("decryptSecret", () => {
    it("decrypts encrypted value back to plaintext", () => {
      const plaintext = "my-secret-value";
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles empty string round-trip", () => {
      const plaintext = "";
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles unicode characters round-trip", () => {
      const plaintext = "密码🔐パスワード";
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles large values round-trip", () => {
      const plaintext = "x".repeat(10000);
      const encrypted = encryptSecret(plaintext);
      const decrypted = decryptSecret(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("throws on invalid base64", () => {
      expect(() => decryptSecret("not-valid-base64!!!")).toThrow();
    });

    it("throws on tampered ciphertext (auth tag validation)", () => {
      const plaintext = "my-secret-value";
      const encrypted = encryptSecret(plaintext);

      // Tamper with the encrypted value
      const buffer = Buffer.from(encrypted, "base64");
      const lastIndex = buffer.length - 1;
      buffer[lastIndex] = (buffer[lastIndex] ?? 0) ^ 0xff; // Flip bits in ciphertext
      const tampered = buffer.toString("base64");

      expect(() => decryptSecret(tampered)).toThrow();
    });
  });
});
