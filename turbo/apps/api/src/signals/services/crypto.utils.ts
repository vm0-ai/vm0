import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
  KMSClient,
} from "@aws-sdk/client-kms";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { z } from "zod";

import { env } from "../../lib/env";
import { singleton, testOverride } from "../../lib/singleton";

const secretsMapSchema = z.record(z.string(), z.string());
export const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";

export type StoredSecretWriteMode = "legacy" | "dual" | "kms";
export type StoredSecretReadMode =
  | "prefer-legacy"
  | "prefer-kms"
  | "legacy-only"
  | "kms-only";

const directKmsCiphertextSchema = z.object({
  keyId: z.string().min(1),
  ciphertext: z.string().min(1),
});

const envelopeKmsCiphertextSchema = z.object({
  keyId: z.string().min(1),
  encryptedDataKey: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
});

const kmsCiphertextSchema = z.union([
  envelopeKmsCiphertextSchema,
  directKmsCiphertextSchema,
]);

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
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

const secretKmsClient = singleton((): SecretKmsClient => {
  const client = new KMSClient({});
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
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
const DATA_KEY_BYTE_LENGTH = 32;

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

function encryptSecretValueWithDataKey(
  plaintext: string,
  key: Buffer,
): {
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: data.toString("base64"),
  };
}

function decryptSecretValueWithDataKey(
  ciphertext: z.infer<typeof envelopeKmsCiphertextSchema>,
  key: Buffer,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ciphertext.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(ciphertext.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext.ciphertext, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

async function encryptSecretValueWithKms(
  plaintext: string,
): Promise<KmsCiphertext> {
  const keyId = requireSecretsKmsKeyId();
  const response = await getSecretKmsClient().send(
    new GenerateDataKeyCommand({
      KeyId: keyId,
      KeySpec: "AES_256",
      EncryptionContext: KMS_ENCRYPTION_CONTEXT,
    }),
  );
  if (!response.Plaintext) {
    throw new Error(
      "AWS KMS GenerateDataKey response did not include plaintext",
    );
  }
  if (!response.CiphertextBlob) {
    throw new Error(
      "AWS KMS GenerateDataKey response did not include encrypted data key",
    );
  }

  const plaintextDataKey = Buffer.from(response.Plaintext);
  if (plaintextDataKey.byteLength !== DATA_KEY_BYTE_LENGTH) {
    throw new Error(
      "AWS KMS GenerateDataKey response used an invalid key size",
    );
  }

  const encrypted = encryptSecretValueWithDataKey(plaintext, plaintextDataKey);
  plaintextDataKey.fill(0);
  return {
    keyId: response.KeyId ?? keyId,
    encryptedDataKey: Buffer.from(response.CiphertextBlob).toString("base64"),
    ...encrypted,
  };
}

async function decryptSecretValueWithKms(
  ciphertext: KmsCiphertext,
): Promise<string> {
  if (!("encryptedDataKey" in ciphertext)) {
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

  const response = await getSecretKmsClient().send(
    new DecryptCommand({
      KeyId: ciphertext.keyId,
      CiphertextBlob: Buffer.from(ciphertext.encryptedDataKey, "base64"),
      EncryptionContext: KMS_ENCRYPTION_CONTEXT,
    }),
  );
  if (!response.Plaintext) {
    throw new Error("AWS KMS decrypt response did not include plaintext");
  }

  const plaintextDataKey = Buffer.from(response.Plaintext);
  if (plaintextDataKey.byteLength !== DATA_KEY_BYTE_LENGTH) {
    throw new Error("AWS KMS decrypt response used an invalid key size");
  }

  const plaintext = decryptSecretValueWithDataKey(ciphertext, plaintextDataKey);
  plaintextDataKey.fill(0);
  return plaintext;
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
  _ctx: FeatureSwitchContext = {},
): Promise<string> {
  if (!env("SECRETS_KMS_KEY_ID")) {
    return encryptSecretValue(plaintext);
  }

  return await encryptStoredSecretValueWithMode(plaintext, "dual");
}

export async function decryptStoredSecretValue(
  encrypted: string,
  _ctx: FeatureSwitchContext = {},
): Promise<string> {
  return await decryptStoredSecretValueWithMode(encrypted, "prefer-kms");
}

export async function encryptStoredSecretsMap(
  secrets: Record<string, string> | null | undefined,
  ctx: FeatureSwitchContext = {},
): Promise<string | null> {
  if (!secrets) {
    return null;
  }

  return await encryptStoredSecretValue(JSON.stringify(secrets), ctx);
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

export function inspectPersistentSecretCiphertext(encrypted: string): {
  readonly format: "legacy" | "dual" | "kms";
  readonly hasLegacy: boolean;
  readonly hasKms: boolean;
} {
  return inspectStoredSecretCiphertext(encrypted);
}

export async function encryptPersistentSecretValueWithMode(
  plaintext: string,
  mode: StoredSecretWriteMode,
): Promise<string> {
  return await encryptStoredSecretValueWithMode(plaintext, mode);
}

export async function decryptPersistentSecretValueWithMode(
  encrypted: string,
  mode: StoredSecretReadMode,
): Promise<string> {
  return await decryptStoredSecretValueWithMode(encrypted, mode);
}

export async function encryptPersistentSecretValue(
  plaintext: string,
  _ctx: FeatureSwitchContext,
): Promise<string> {
  if (!env("SECRETS_KMS_KEY_ID")) {
    return encryptSecretValue(plaintext);
  }

  return await encryptPersistentSecretValueWithMode(plaintext, "dual");
}

export async function decryptPersistentSecretValue(
  encrypted: string,
  _ctx: FeatureSwitchContext,
): Promise<string> {
  return await decryptPersistentSecretValueWithMode(encrypted, "prefer-kms");
}

export async function encryptPersistentSecretsMap(
  secrets: Record<string, string> | null | undefined,
  ctx: FeatureSwitchContext,
): Promise<string | null> {
  if (!secrets) {
    return null;
  }

  return await encryptPersistentSecretValue(JSON.stringify(secrets), ctx);
}

export async function encryptPersistentSecretsMapWithMode(
  secrets: Record<string, string> | null | undefined,
  mode: StoredSecretWriteMode,
): Promise<string | null> {
  if (!secrets) {
    return null;
  }

  return await encryptPersistentSecretValueWithMode(
    JSON.stringify(secrets),
    mode,
  );
}

export async function decryptPersistentSecretsMap(
  encryptedData: string | null,
  ctx: FeatureSwitchContext,
): Promise<Record<string, string> | null> {
  if (!encryptedData) {
    return null;
  }

  return secretsMapSchema.parse(
    JSON.parse(
      await decryptPersistentSecretValue(encryptedData, ctx),
    ) as unknown,
  );
}

export async function decryptPersistentSecretsMapWithMode(
  encryptedData: string | null,
  mode: StoredSecretReadMode,
): Promise<Record<string, string> | null> {
  if (!encryptedData) {
    return null;
  }

  return secretsMapSchema.parse(
    JSON.parse(
      await decryptPersistentSecretValueWithMode(encryptedData, mode),
    ) as unknown,
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
