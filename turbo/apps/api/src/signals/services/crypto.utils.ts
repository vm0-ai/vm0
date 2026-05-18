import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  EncryptCommand,
  type EncryptCommandOutput,
  KMSClient,
} from "@aws-sdk/client-kms";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { z } from "zod";

import { env } from "../../lib/env";
import { singleton, testOverride } from "../../lib/singleton";

const secretsMapSchema = z.record(z.string(), z.string());
export const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";

export type StoredSecretWriteMode = "legacy" | "dual" | "kms";
type StoredSecretReadMode =
  | "prefer-legacy"
  | "prefer-kms"
  | "legacy-only"
  | "kms-only";

const kmsCiphertextSchema = z.object({
  keyId: z.string().min(1),
  ciphertext: z.string().min(1),
});

const storedSecretEnvelopeSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("stored-secret"),
    legacy: z.string().min(1).optional(),
    kms: kmsCiphertextSchema.optional(),
  })
  .refine(
    (value) => {
      return Boolean(value.legacy ?? value.kms);
    },
    { message: "Stored secret envelope must contain legacy or kms material" },
  );

type KmsCiphertext = z.infer<typeof kmsCiphertextSchema>;
type StoredSecretEnvelope = z.infer<typeof storedSecretEnvelopeSchema>;

export type StoredSecretCiphertextFormat = "legacy" | "dual" | "kms";

interface StoredSecretCiphertextInfo {
  readonly format: StoredSecretCiphertextFormat;
  readonly hasLegacy: boolean;
  readonly hasKms: boolean;
}

export interface SecretKmsClient {
  send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

const secretKmsClient = singleton((): SecretKmsClient => {
  const client = new KMSClient({});
  function send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: EncryptCommand | DecryptCommand,
  ): Promise<EncryptCommandOutput | DecryptCommandOutput> {
    if (command instanceof EncryptCommand) {
      return client.send(command);
    }
    return client.send(command);
  }

  return { send };
});

const {
  get: getSecretKmsClientOverride,
  set: setSecretKmsClientOverride,
  clear: clearSecretKmsClientOverride,
} = testOverride<SecretKmsClient | null>(() => {
  return null;
});

const KMS_ENCRYPTION_CONTEXT = {
  purpose: "vm0-stored-secret",
} as const;

function getSecretKmsClient(): SecretKmsClient {
  return getSecretKmsClientOverride() ?? secretKmsClient();
}

function requireSecretsKmsKeyId(): string {
  const keyId = env("SECRETS_KMS_KEY_ID");
  if (!keyId) {
    throw new Error("SECRETS_KMS_KEY_ID is required for KMS secret encryption");
  }
  return keyId;
}

function encodeStoredSecretEnvelope(envelope: StoredSecretEnvelope): string {
  return `${STORED_SECRET_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify(envelope),
    "utf8",
  ).toString("base64url")}`;
}

function decodeStoredSecretEnvelope(encrypted: string): StoredSecretEnvelope {
  if (!encrypted.startsWith(STORED_SECRET_ENVELOPE_PREFIX)) {
    return { v: 1, kind: "stored-secret", legacy: encrypted };
  }

  const payload = encrypted.slice(STORED_SECRET_ENVELOPE_PREFIX.length);
  return storedSecretEnvelopeSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
  );
}

function storedSecretFormat(
  envelope: StoredSecretEnvelope,
): StoredSecretCiphertextFormat {
  if (envelope.kms && envelope.legacy) {
    return "dual";
  }
  if (envelope.kms) {
    return "kms";
  }
  return "legacy";
}

function storedSecretReadMode(ctx: FeatureSwitchContext): StoredSecretReadMode {
  return isFeatureEnabled(FeatureSwitchKey.StoredSecretKmsRead, ctx)
    ? "prefer-kms"
    : "prefer-legacy";
}

async function encryptSecretValueWithKms(
  plaintext: string,
): Promise<KmsCiphertext> {
  const keyId = requireSecretsKmsKeyId();
  const response = await getSecretKmsClient().send(
    new EncryptCommand({
      KeyId: keyId,
      Plaintext: Buffer.from(plaintext, "utf8"),
      EncryptionContext: KMS_ENCRYPTION_CONTEXT,
    }),
  );
  if (!response.CiphertextBlob) {
    throw new Error("AWS KMS encrypt response did not include ciphertext");
  }

  return {
    keyId: response.KeyId ?? keyId,
    ciphertext: Buffer.from(response.CiphertextBlob).toString("base64"),
  };
}

async function decryptSecretValueWithKms(
  ciphertext: KmsCiphertext,
): Promise<string> {
  const response = await getSecretKmsClient().send(
    new DecryptCommand({
      KeyId: ciphertext.keyId,
      CiphertextBlob: Buffer.from(ciphertext.ciphertext, "base64"),
      EncryptionContext: KMS_ENCRYPTION_CONTEXT,
    }),
  );
  if (!response.Plaintext) {
    throw new Error("AWS KMS decrypt response did not include plaintext");
  }

  return Buffer.from(response.Plaintext).toString("utf8");
}

export function resetSecretKmsClientForTests(): void {
  clearSecretKmsClientOverride();
  secretKmsClient.reset();
}

export function setSecretKmsClientForTests(client: SecretKmsClient): void {
  setSecretKmsClientOverride(client);
}

export function inspectStoredSecretCiphertext(
  encrypted: string,
): StoredSecretCiphertextInfo {
  const envelope = decodeStoredSecretEnvelope(encrypted);
  return {
    format: storedSecretFormat(envelope),
    hasLegacy: Boolean(envelope.legacy),
    hasKms: Boolean(envelope.kms),
  };
}

export async function encryptStoredSecretValueWithMode(
  plaintext: string,
  mode: StoredSecretWriteMode,
): Promise<string> {
  if (mode === "legacy") {
    return encryptSecretValue(plaintext);
  }

  const kms = await encryptSecretValueWithKms(plaintext);
  return encodeStoredSecretEnvelope({
    v: 1,
    kind: "stored-secret",
    legacy: mode === "dual" ? encryptSecretValue(plaintext) : undefined,
    kms,
  });
}

export async function decryptStoredSecretValueWithMode(
  encrypted: string,
  mode: StoredSecretReadMode,
): Promise<string> {
  const envelope = decodeStoredSecretEnvelope(encrypted);

  if (mode === "legacy-only") {
    if (!envelope.legacy) {
      throw new Error("Stored secret ciphertext does not include legacy data");
    }
    return decryptSecretValue(envelope.legacy);
  }

  if (mode === "kms-only") {
    if (!envelope.kms) {
      throw new Error("Stored secret ciphertext does not include KMS data");
    }
    return await decryptSecretValueWithKms(envelope.kms);
  }

  if (mode === "prefer-kms" && envelope.kms) {
    return await decryptSecretValueWithKms(envelope.kms);
  }

  if (envelope.legacy) {
    return decryptSecretValue(envelope.legacy);
  }

  if (envelope.kms) {
    return await decryptSecretValueWithKms(envelope.kms);
  }

  throw new Error("Stored secret ciphertext does not include decryptable data");
}

export async function encryptStoredSecretValue(
  plaintext: string,
): Promise<string> {
  if (!env("SECRETS_KMS_KEY_ID")) {
    return encryptSecretValue(plaintext);
  }

  return await encryptStoredSecretValueWithMode(plaintext, "dual");
}

export async function decryptStoredSecretValue(
  encrypted: string,
  ctx: FeatureSwitchContext = {},
): Promise<string> {
  return await decryptStoredSecretValueWithMode(
    encrypted,
    storedSecretReadMode(ctx),
  );
}

export async function encryptStoredSecretsMap(
  secrets: Record<string, string> | null | undefined,
): Promise<string | null> {
  if (!secrets) {
    return null;
  }

  return await encryptStoredSecretValue(JSON.stringify(secrets));
}

export async function decryptStoredSecretsMap(
  encryptedData: string | null,
  ctx: FeatureSwitchContext = {},
): Promise<Record<string, string> | null> {
  if (!encryptedData) {
    return null;
  }

  return secretsMapSchema.parse(
    JSON.parse(await decryptStoredSecretValue(encryptedData, ctx)) as unknown,
  );
}

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
