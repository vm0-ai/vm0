import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "../../env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key from environment
 * Falls back to a development-only key if not configured
 */
function getEncryptionKey(): Buffer {
  const keyHex = env().SECRETS_ENCRYPTION_KEY;
  if (!keyHex) {
    // Development fallback - NOT FOR PRODUCTION
    if (env().NODE_ENV === "production") {
      throw new Error("SECRETS_ENCRYPTION_KEY must be set in production");
    }
    // Use a deterministic key for development (32 bytes = 64 hex chars)
    return Buffer.from(
      "0000000000000000000000000000000000000000000000000000000000000000",
      "hex",
    );
  }
  return Buffer.from(keyHex, "hex");
}

/**
 * Encrypt a secret value using AES-256-GCM
 * @param plaintext - The secret value to encrypt
 * @returns Base64 encoded string in format: iv:authTag:ciphertext
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Combine iv + authTag + ciphertext and encode as base64
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt a secret value using AES-256-GCM
 * @param encryptedValue - Base64 encoded string from encryptSecret
 * @returns The decrypted plaintext
 */
export function decryptSecret(encryptedValue: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedValue, "base64");

  // Extract iv, authTag, and ciphertext
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Encrypt a record of secrets (key -> value)
 * @param secrets - Record of secret name to plaintext value
 * @returns Record of secret name to encrypted value
 */
export function encryptSecrets(
  secrets: Record<string, string>,
): Record<string, string> {
  const encrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    encrypted[name] = encryptSecret(value);
  }
  return encrypted;
}

/**
 * Decrypt a record of secrets (key -> encrypted value)
 * @param secrets - Record of secret name to encrypted value
 * @returns Record of secret name to plaintext value
 */
export function decryptSecrets(
  secrets: Record<string, string>,
): Record<string, string> {
  const decrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    decrypted[name] = decryptSecret(value);
  }
  return decrypted;
}
