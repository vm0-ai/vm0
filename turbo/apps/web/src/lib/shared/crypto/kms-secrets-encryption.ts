import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
  KMSClient,
} from "@aws-sdk/client-kms";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { z } from "zod";

import { env } from "../../../env";
import { decryptSecretValue, encryptSecretValue } from "./secrets-encryption";

const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";
const DATA_KEY_BYTE_LENGTH = 32;
const KMS_ENCRYPTION_CONTEXT = {
  purpose: "vm0-stored-secret",
} as const;

type StoredSecretWriteMode = "legacy" | "dual" | "kms";
type StoredSecretReadMode =
  | "prefer-legacy"
  | "prefer-kms"
  | "legacy-only"
  | "kms-only";

const secretsMapSchema = z.record(z.string(), z.string());

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

interface SecretKmsClient {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

const secretKmsClient: SecretKmsClient = new KMSClient({});

function secretsEncryptionKey(): string {
  return env().SECRETS_ENCRYPTION_KEY;
}

function secretsKmsKeyId(): string | undefined {
  return env().SECRETS_KMS_KEY_ID;
}

function requireSecretsKmsKeyId(): string {
  const keyId = secretsKmsKeyId();
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
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
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
  const response = await secretKmsClient.send(
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
    const response = await secretKmsClient.send(
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

  const response = await secretKmsClient.send(
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

async function encryptSecretValueWithMode(
  plaintext: string,
  mode: StoredSecretWriteMode,
): Promise<string> {
  if (mode === "legacy") {
    return encryptSecretValue(plaintext, secretsEncryptionKey());
  }

  const kms = await encryptSecretValueWithKms(plaintext);
  return encodeStoredSecretEnvelope({
    v: 1,
    kind: "stored-secret",
    legacy:
      mode === "dual"
        ? encryptSecretValue(plaintext, secretsEncryptionKey())
        : undefined,
    kms,
  });
}

async function decryptSecretValueWithMode(
  encrypted: string,
  mode: StoredSecretReadMode,
): Promise<string> {
  const envelope = decodeStoredSecretEnvelope(encrypted);

  if (mode === "legacy-only") {
    if (!envelope.legacy) {
      throw new Error("Stored secret ciphertext does not include legacy data");
    }
    return decryptSecretValue(envelope.legacy, secretsEncryptionKey());
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
    return decryptSecretValue(envelope.legacy, secretsEncryptionKey());
  }

  if (envelope.kms) {
    return await decryptSecretValueWithKms(envelope.kms);
  }

  throw new Error("Stored secret ciphertext does not include decryptable data");
}

function storedSecretWriteMode(
  featureSwitchKey: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): StoredSecretWriteMode {
  if (!secretsKmsKeyId()) {
    return "legacy";
  }
  return isFeatureEnabled(featureSwitchKey, ctx) ? "dual" : "legacy";
}

function storedSecretReadMode(
  featureSwitchKey: FeatureSwitchKey,
  ctx: FeatureSwitchContext,
): StoredSecretReadMode {
  return isFeatureEnabled(featureSwitchKey, ctx)
    ? "prefer-kms"
    : "prefer-legacy";
}

export async function encryptStoredSecretValue(
  plaintext: string,
  ctx: FeatureSwitchContext = {},
): Promise<string> {
  return await encryptSecretValueWithMode(
    plaintext,
    storedSecretWriteMode(FeatureSwitchKey.StoredSecretKmsWrite, ctx),
  );
}

async function decryptStoredSecretValue(
  encrypted: string,
  ctx: FeatureSwitchContext = {},
): Promise<string> {
  return await decryptSecretValueWithMode(
    encrypted,
    storedSecretReadMode(FeatureSwitchKey.StoredSecretKmsRead, ctx),
  );
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

export async function decryptPersistentSecretValue(
  encrypted: string,
  ctx: FeatureSwitchContext = {},
): Promise<string> {
  return await decryptSecretValueWithMode(
    encrypted,
    storedSecretReadMode(FeatureSwitchKey.PersistentSecretKmsRead, ctx),
  );
}
