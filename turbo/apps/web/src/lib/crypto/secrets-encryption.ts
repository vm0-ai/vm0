import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt secrets using AES-256-GCM
 * Returns base64-encoded ciphertext in format: iv:authTag:encryptedData
 */
export function encryptSecrets(
  secrets: string[] | null,
  encryptionKey: string | undefined,
): string | null {
  if (!secrets || secrets.length === 0) {
    return null;
  }

  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const plaintext = JSON.stringify(secrets);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Encode as: iv:authTag:encryptedData (all base64)
  const result = [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");

  return result;
}

/**
 * Decrypt secrets encrypted with AES-256-GCM
 * Input format: iv:authTag:encryptedData (all base64)
 */
export function decryptSecrets(
  encryptedData: string | null,
  encryptionKey: string | undefined,
): string[] | null {
  if (!encryptedData) {
    return null;
  }

  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secrets format");
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

  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Encrypt a secrets map (key-value pairs) using AES-256-GCM
 * Used for schedule secrets that need to persist both keys and values
 * Returns base64-encoded ciphertext in format: iv:authTag:encryptedData
 */
export function encryptSecretsMap(
  secrets: Record<string, string> | null,
  encryptionKey: string | undefined,
): string | null {
  if (!secrets || Object.keys(secrets).length === 0) {
    return null;
  }

  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const plaintext = JSON.stringify(secrets);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const result = [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");

  return result;
}

/**
 * Decrypt a secrets map encrypted with AES-256-GCM
 * Returns the original key-value pairs
 * Input format: iv:authTag:encryptedData (all base64)
 */
export function decryptSecretsMap(
  encryptedData: string | null,
  encryptionKey: string | undefined,
): Record<string, string> | null {
  if (!encryptedData) {
    return null;
  }

  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secrets format");
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

  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Encrypt a single credential value using AES-256-GCM
 * Returns base64-encoded ciphertext in format: iv:authTag:encryptedData
 */
export function encryptCredentialValue(
  value: string,
  encryptionKey: string | undefined,
): string {
  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

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

/**
 * Decrypt a single credential value encrypted with AES-256-GCM
 * Input format: iv:authTag:encryptedData (all base64)
 */
export function decryptCredentialValue(
  encryptedData: string,
  encryptionKey: string | undefined,
): string {
  if (!encryptionKey) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encryptionKey, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }

  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted credential format");
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
