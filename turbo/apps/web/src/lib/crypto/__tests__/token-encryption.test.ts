import { describe, it, expect } from "vitest";
import {
  encryptToken,
  decryptToken,
  isEncryptedToken,
} from "../token-encryption";

describe("token-encryption", () => {
  const testUserId = "user-123";
  const testSecret = "test-secret-key-32-chars-long!!";
  const testToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

  describe("encryptToken", () => {
    it("should encrypt a token", () => {
      const encrypted = encryptToken(testToken, testUserId, testSecret);

      expect(encrypted).toMatch(/^encrypted:AES256:.+:.+:.+$/);
      expect(encrypted).not.toContain(testToken);
    });

    it("should generate different encrypted tokens each time", () => {
      const encrypted1 = encryptToken(testToken, testUserId, testSecret);
      const encrypted2 = encryptToken(testToken, testUserId, testSecret);

      expect(encrypted1).not.toBe(encrypted2);
    });
  });

  describe("decryptToken", () => {
    it("should decrypt an encrypted token", () => {
      const encrypted = encryptToken(testToken, testUserId, testSecret);
      const decrypted = decryptToken(encrypted, testUserId, testSecret);

      expect(decrypted).toBe(testToken);
    });

    it("should fail with wrong user ID", () => {
      const encrypted = encryptToken(testToken, testUserId, testSecret);

      expect(() => decryptToken(encrypted, "wrong-user", testSecret)).toThrow();
    });

    it("should fail with wrong secret", () => {
      const encrypted = encryptToken(testToken, testUserId, testSecret);

      expect(() =>
        decryptToken(encrypted, testUserId, "wrong-secret-key-32-chars-long!"),
      ).toThrow();
    });

    it("should fail with invalid format", () => {
      expect(() =>
        decryptToken("invalid-format", testUserId, testSecret),
      ).toThrow("Invalid encrypted token format");
    });

    it("should fail with tampered data", () => {
      const encrypted = encryptToken(testToken, testUserId, testSecret);
      const parts = encrypted.split(":");
      parts[4] = "tampered";
      const tampered = parts.join(":");

      expect(() => decryptToken(tampered, testUserId, testSecret)).toThrow();
    });
  });

  describe("isEncryptedToken", () => {
    it("should identify encrypted tokens", () => {
      const encrypted = encryptToken(testToken, testUserId, testSecret);
      expect(isEncryptedToken(encrypted)).toBe(true);
    });

    it("should identify plaintext tokens", () => {
      expect(isEncryptedToken(testToken)).toBe(false);
      expect(isEncryptedToken("ghp_123")).toBe(false);
      expect(isEncryptedToken("")).toBe(false);
    });
  });
});
