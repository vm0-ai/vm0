import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../../../../lib/env";
import { STORED_SECRET_ENVELOPE_PREFIX } from "../../../services/crypto.utils";

const TEST_KMS_KEY_ID = "alias/vm0-secrets-test";
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

export function encryptSecretForTests(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TEST_DATA_KEY, iv, {
    authTagLength: 16,
  });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${STORED_SECRET_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "stored-secret",
      kms: {
        keyId: TEST_KMS_KEY_ID,
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${TEST_KMS_KEY_ID}`,
          "utf8",
        ).toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: data.toString("base64"),
      },
    }),
    "utf8",
  ).toString("base64url")}`;
}

function decryptLegacySecretForTests(encrypted: string): string {
  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const [ivBase64, authTagBase64, dataBase64] = encrypted.split(":");
  if (!ivBase64 || !authTagBase64 || !dataBase64) {
    throw new Error("Invalid encrypted data format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivBase64, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function decryptSecretForTests(encrypted: string): string {
  if (!encrypted.startsWith(STORED_SECRET_ENVELOPE_PREFIX)) {
    return decryptLegacySecretForTests(encrypted);
  }

  const payload = encrypted.slice(STORED_SECRET_ENVELOPE_PREFIX.length);
  const envelope = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as {
    readonly kms?: {
      readonly iv?: string;
      readonly authTag?: string;
      readonly ciphertext: string;
    };
    readonly legacy?: string;
  };
  if (!envelope.kms) {
    if (!envelope.legacy) {
      throw new Error("Stored secret test envelope has no decryptable data");
    }
    return decryptLegacySecretForTests(envelope.legacy);
  }
  if (!envelope.kms.iv || !envelope.kms.authTag) {
    throw new Error("Stored secret test envelope is not data-key encrypted");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    TEST_DATA_KEY,
    Buffer.from(envelope.kms.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(envelope.kms.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.kms.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function decryptSecretsMapForTests(
  encryptedData: string | null,
): Record<string, string> | null {
  if (!encryptedData) {
    return null;
  }

  return JSON.parse(decryptSecretForTests(encryptedData)) as Record<
    string,
    string
  >;
}
