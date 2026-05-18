import { describe, it, expect } from "vitest";
import {
  encryptSecretValue,
  decryptSecretValue,
  encryptSecretsMap,
  decryptSecretsMap,
} from "../secrets-encryption";

// Valid 32-byte hex key for testing
const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function storedSecretEnvelope(legacy: string | undefined): string {
  return `vm0secret:v1:${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "stored-secret",
      legacy,
      kms: { keyId: "alias/vm0-secrets", ciphertext: "kms-ciphertext" },
    }),
    "utf8",
  ).toString("base64url")}`;
}

describe("secrets-encryption", () => {
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
      expect(() => {
        return encryptSecretsMap({ KEY: "value" }, undefined);
      }).toThrow("SECRETS_ENCRYPTION_KEY is required");
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

    it("should decrypt the legacy branch of dual stored-secret envelopes", () => {
      const secrets = { API_KEY: "sk-123456" };
      const encrypted = encryptSecretsMap(secrets, TEST_KEY);

      const decrypted = decryptSecretsMap(
        storedSecretEnvelope(encrypted ?? undefined),
        TEST_KEY,
      );

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

      expect(() => {
        return decryptSecretsMap(encrypted, undefined);
      }).toThrow("SECRETS_ENCRYPTION_KEY is required");
    });

    it("should throw for tampered data", () => {
      const encrypted = encryptSecretsMap({ KEY: "value" }, TEST_KEY)!;
      const parts = encrypted.split(":");
      parts[2] = "dGFtcGVyZWQ=";
      const tampered = parts.join(":");

      expect(() => {
        return decryptSecretsMap(tampered, TEST_KEY);
      }).toThrow();
    });
  });

  describe("decryptSecretValue", () => {
    it("should decrypt the legacy branch of dual stored-secret envelopes", () => {
      const encrypted = encryptSecretValue("secret", TEST_KEY);

      expect(
        decryptSecretValue(storedSecretEnvelope(encrypted), TEST_KEY),
      ).toBe("secret");
    });

    it("should throw for KMS-only stored-secret envelopes", () => {
      expect(() => {
        return decryptSecretValue(storedSecretEnvelope(undefined), TEST_KEY);
      }).toThrow("KMS-only stored secret ciphertext is not supported here");
    });
  });
});
