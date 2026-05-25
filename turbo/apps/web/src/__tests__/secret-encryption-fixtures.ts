import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";

function legacyCiphertextFromEnvelope(encryptedData: string): string {
  if (!encryptedData.startsWith(STORED_SECRET_ENVELOPE_PREFIX)) {
    return encryptedData;
  }

  const payload = encryptedData.slice(STORED_SECRET_ENVELOPE_PREFIX.length);
  const parsed = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "legacy" in parsed &&
    typeof parsed.legacy === "string"
  ) {
    return parsed.legacy;
  }

  throw new Error("KMS-only stored secret ciphertext is not supported here");
}

function encryptionKeyBuffer(encryptionKey: string | undefined): Buffer {
  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }
  return key;
}

export function encryptTestSecretValue(
  value: string,
  encryptionKey: string | undefined,
): string {
  const key = encryptionKeyBuffer(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptTestSecretValue(
  encryptedData: string,
  encryptionKey: string | undefined,
): string {
  const key = encryptionKeyBuffer(encryptionKey);
  const legacyEncryptedData = legacyCiphertextFromEnvelope(encryptedData);
  const parts = legacyEncryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format");
  }

  const [ivBase64, authTagBase64, dataBase64] = parts;
  const iv = Buffer.from(ivBase64!, "base64");
  const authTag = Buffer.from(authTagBase64!, "base64");
  const encrypted = Buffer.from(dataBase64!, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
