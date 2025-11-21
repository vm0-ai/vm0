import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

export interface EncryptedToken {
  algorithm: string;
  iv: string;
  authTag: string;
  encrypted: string;
}

/**
 * Derive encryption key from user ID and global secret
 */
function deriveKey(userId: string, secret: string): Buffer {
  return crypto.scryptSync(userId, secret, KEY_LENGTH);
}

/**
 * Encrypt a token using AES-256-GCM
 * Format: encrypted:AES256:iv:authTag:encrypted (all base64)
 */
export function encryptToken(
  token: string,
  userId: string,
  secret: string,
): string {
  const key = deriveKey(userId, secret);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `encrypted:AES256:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt an encrypted token
 */
export function decryptToken(
  encryptedToken: string,
  userId: string,
  secret: string,
): string {
  const parts = encryptedToken.split(":");
  if (parts.length !== 5 || parts[0] !== "encrypted" || parts[1] !== "AES256") {
    throw new Error("Invalid encrypted token format");
  }

  const iv = Buffer.from(parts[2]!, "base64");
  const authTag = Buffer.from(parts[3]!, "base64");
  const encrypted = Buffer.from(parts[4]!, "base64");

  const key = deriveKey(userId, secret);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
}

/**
 * Check if a token string is encrypted
 */
export function isEncryptedToken(token: string): boolean {
  return token.startsWith("encrypted:AES256:");
}
