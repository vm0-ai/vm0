import { createDecipheriv } from "node:crypto";

import { env } from "../../lib/env";

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
