import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

import { env } from "../../lib/env";

const secretsMapSchema = z.record(z.string(), z.string());

/**
 * Encrypt a single secret value using AES-256-GCM.
 *
 * Reads `SECRETS_ENCRYPTION_KEY` from env so call sites stay clean — symmetric
 * counterpart to `decryptSecretValue` below. Output format
 * `iv:authTag:ciphertext` (all base64) matches what `encryptSecretForTests`
 * already produces, so encrypt/decrypt round-trip is provably consistent.
 */
export function encryptSecretValue(plaintext: string): string {
  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    data.toString("base64"),
  ].join(":");
}

export function decryptSecretValue(encrypted: string): string {
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

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function decryptSecretsMap(
  encryptedData: string | null,
): Record<string, string> | null {
  if (!encryptedData) {
    return null;
  }

  return secretsMapSchema.parse(
    JSON.parse(decryptSecretValue(encryptedData)) as unknown,
  );
}

export function encryptSecretsMap(
  secrets: Record<string, string> | null | undefined,
): string | null {
  if (!secrets) {
    return null;
  }

  return encryptSecretValue(JSON.stringify(secrets));
}
