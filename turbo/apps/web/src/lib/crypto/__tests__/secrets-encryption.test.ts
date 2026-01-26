import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encryptSecrets,
  decryptSecrets,
  encryptSecretsMap,
  decryptSecretsMap,
} from "../secrets-encryption";

// Valid 32-byte hex key for testing
const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("secrets-encryption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("encryptSecrets (array)", () => {
    it("should return null for null input", () => {
      const result = encryptSecrets(null, TEST_KEY);
      expect(result).toBeNull();
    });

    it("should return null for empty array", () => {
      const result = encryptSecrets([], TEST_KEY);
      expect(result).toBeNull();
    });

    it("should encrypt secrets array", () => {
      const secrets = ["API_KEY", "DB_PASSWORD"];
      const encrypted = encryptSecrets(secrets, TEST_KEY);

      expect(encrypted).not.toBeNull();
      expect(encrypted).toContain(":"); // Format: iv:authTag:data
      expect(encrypted!.split(":")).toHaveLength(3);
    });

    it("should produce different ciphertext for same input (random IV)", () => {
      const secrets = ["SECRET_VALUE"];
      const encrypted1 = encryptSecrets(secrets, TEST_KEY);
      const encrypted2 = encryptSecrets(secrets, TEST_KEY);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it("should throw when key not provided", () => {
      expect(() => encryptSecrets(["SECRET"], undefined)).toThrow(
        "SECRETS_ENCRYPTION_KEY is required",
      );
    });

    it("should throw for invalid key length", () => {
      expect(() => encryptSecrets(["SECRET"], "tooshort")).toThrow(
        "SECRETS_ENCRYPTION_KEY must be 32 bytes",
      );
    });
  });

  describe("decryptSecrets (array)", () => {
    it("should return null for null input", () => {
      const result = decryptSecrets(null, TEST_KEY);
      expect(result).toBeNull();
    });

    it("should decrypt encrypted secrets", () => {
      const secrets = ["API_KEY", "DB_PASSWORD", "WEBHOOK_SECRET"];
      const encrypted = encryptSecrets(secrets, TEST_KEY);
      const decrypted = decryptSecrets(encrypted, TEST_KEY);

      expect(decrypted).toEqual(secrets);
    });

    it("should throw when key not provided", () => {
      const encrypted = encryptSecrets(["SECRET"], TEST_KEY);

      expect(() => decryptSecrets(encrypted, undefined)).toThrow(
        "SECRETS_ENCRYPTION_KEY is required",
      );
    });

    it("should throw for invalid format", () => {
      expect(() => decryptSecrets("invalid:format", TEST_KEY)).toThrow(
        "Invalid encrypted secrets format",
      );
    });

    it("should throw for tampered data (auth tag verification)", () => {
      const encrypted = encryptSecrets(["SECRET"], TEST_KEY)!;
      const parts = encrypted.split(":");
      // Tamper with the encrypted data
      parts[2] = "dGFtcGVyZWQ="; // "tampered" in base64
      const tampered = parts.join(":");

      expect(() => decryptSecrets(tampered, TEST_KEY)).toThrow();
    });
  });

  describe("encryptSecretsMap", () => {
    it("should return null for null input", () => {
      const result = encryptSecretsMap(null, TEST_KEY);
      expect(result).toBeNull();
    });

    it("should return null for empty object", () => {
      const result = encryptSecretsMap({}, TEST_KEY);
      expect(result).toBeNull();
    });

    it("should encrypt secrets map", () => {
      const secrets = {
        API_KEY: "sk-123456",
        DB_PASSWORD: "supersecret",
      };
      const encrypted = encryptSecretsMap(secrets, TEST_KEY);

      expect(encrypted).not.toBeNull();
      expect(encrypted).toContain(":");
      expect(encrypted!.split(":")).toHaveLength(3);
    });

    it("should produce different ciphertext for same input", () => {
      const secrets = { KEY: "value" };
      const encrypted1 = encryptSecretsMap(secrets, TEST_KEY);
      const encrypted2 = encryptSecretsMap(secrets, TEST_KEY);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it("should throw when key not provided", () => {
      expect(() => encryptSecretsMap({ KEY: "value" }, undefined)).toThrow(
        "SECRETS_ENCRYPTION_KEY is required",
      );
    });
  });

  describe("decryptSecretsMap", () => {
    it("should return null for null input", () => {
      const result = decryptSecretsMap(null, TEST_KEY);
      expect(result).toBeNull();
    });

    it("should decrypt encrypted secrets map", () => {
      const secrets = {
        API_KEY: "sk-123456",
        DB_PASSWORD: "supersecret",
        WEBHOOK_URL: "https://example.com/webhook",
      };
      const encrypted = encryptSecretsMap(secrets, TEST_KEY);
      const decrypted = decryptSecretsMap(encrypted, TEST_KEY);

      expect(decrypted).toEqual(secrets);
    });

    it("should preserve all key-value pairs through encryption cycle", () => {
      const secrets = {
        key1: "value1",
        key2: "value2",
        key3: "value with spaces",
        key4: "value-with-special!@#$%",
      };
      const encrypted = encryptSecretsMap(secrets, TEST_KEY);
      const decrypted = decryptSecretsMap(encrypted, TEST_KEY);

      expect(decrypted).toEqual(secrets);
      expect(Object.keys(decrypted!)).toHaveLength(4);
    });

    it("should throw when key not provided", () => {
      const encrypted = encryptSecretsMap({ KEY: "value" }, TEST_KEY);

      expect(() => decryptSecretsMap(encrypted, undefined)).toThrow(
        "SECRETS_ENCRYPTION_KEY is required",
      );
    });

    it("should throw for tampered data", () => {
      const encrypted = encryptSecretsMap({ KEY: "value" }, TEST_KEY)!;
      const parts = encrypted.split(":");
      parts[2] = "dGFtcGVyZWQ=";
      const tampered = parts.join(":");

      expect(() => decryptSecretsMap(tampered, TEST_KEY)).toThrow();
    });
  });
});
