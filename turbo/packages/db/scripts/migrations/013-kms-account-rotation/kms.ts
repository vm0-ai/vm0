import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  ReEncryptCommand,
} from "@aws-sdk/client-kms";

export const prefix = "vm0secret:v1:";
export const encryptionContext = { purpose: "vm0-stored-secret" };
export const keyArnPattern =
  /^arn:aws:kms:([a-z0-9-]+):[0-9]{12}:key\/[0-9a-f-]{36}$/u;

export interface Envelope {
  readonly v: 1;
  readonly kind: "stored-secret";
  readonly kms: {
    readonly keyId: string;
    readonly ciphertext: string;
    readonly encryptedDataKey?: string;
    readonly iv?: string;
    readonly authTag?: string;
  };
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_object");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid_string");
  }
  return value;
}

function base64(value: unknown, length?: number): string {
  const encoded = string(value);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    (length !== undefined && bytes.length !== length)
  ) {
    throw new Error("invalid_base64");
  }
  return encoded;
}

export function decode(value: string): Envelope {
  if (!value.startsWith(prefix)) {
    throw new Error("invalid_envelope_prefix");
  }
  const payload = value.slice(prefix.length);
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.toString("base64url") !== payload) {
    throw new Error("invalid_envelope_encoding");
  }
  const parsed = object(JSON.parse(bytes.toString("utf8")));
  const kms = object(parsed.kms);
  if (parsed.v !== 1 || parsed.kind !== "stored-secret" || !string(kms.keyId)) {
    throw new Error("invalid_envelope_shape");
  }
  const ciphertext = base64(kms.ciphertext);
  const keyId = string(kms.keyId);
  if ("encryptedDataKey" in kms || "iv" in kms || "authTag" in kms) {
    const encryptedDataKey = base64(kms.encryptedDataKey);
    if (!encryptedDataKey) {
      throw new Error("invalid_data_key");
    }
    const iv = base64(kms.iv, 12);
    const authTag = base64(kms.authTag, 16);
    return {
      ...parsed,
      v: 1,
      kind: "stored-secret",
      kms: { ...kms, keyId, ciphertext, encryptedDataKey, iv, authTag },
    };
  } else if (!kms.ciphertext) {
    throw new Error("invalid_direct_ciphertext");
  }
  return {
    ...parsed,
    v: 1,
    kind: "stored-secret",
    kms: { ...kms, keyId, ciphertext },
  };
}

export function encode(envelope: Envelope): string {
  return prefix + Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

export function refersTo(keyId: string, arn: string): boolean {
  return keyId === arn || keyId === arn.split("/").at(-1);
}

export function resolvedKey(
  keyId: string,
  source: string,
  target: string,
): string {
  if (refersTo(keyId, source)) {
    return source;
  }
  if (refersTo(keyId, target)) {
    return target;
  }
  throw new Error("unexpected_key_reference");
}

export async function decrypt(
  kms: KMSClient,
  envelope: Envelope,
  keyArn: string,
): Promise<Buffer> {
  const wrapped = envelope.kms.encryptedDataKey ?? envelope.kms.ciphertext;
  const response = await kms.send(
    new DecryptCommand({
      KeyId: keyArn,
      CiphertextBlob: Buffer.from(wrapped, "base64"),
      EncryptionContext: encryptionContext,
    }),
  );
  if (!response.Plaintext || response.KeyId !== keyArn) {
    throw new Error("unexpected_decrypt_response");
  }
  const plaintext = Buffer.from(response.Plaintext);
  response.Plaintext.fill(0);
  if (!envelope.kms.encryptedDataKey) {
    return plaintext;
  }
  try {
    if (plaintext.length !== 32) {
      throw new Error("invalid_data_key_size");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      plaintext,
      Buffer.from(string(envelope.kms.iv), "base64"),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(string(envelope.kms.authTag), "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.kms.ciphertext, "base64")),
      decipher.final(),
    ]);
  } finally {
    plaintext.fill(0);
  }
}

export async function encrypt(
  kms: KMSClient,
  plaintext: Buffer,
  keyArn: string,
): Promise<Envelope> {
  const response = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: keyArn,
      KeySpec: "AES_256",
      EncryptionContext: encryptionContext,
    }),
  );
  if (
    !response.Plaintext ||
    !response.CiphertextBlob ||
    response.KeyId !== keyArn
  ) {
    response.Plaintext?.fill(0);
    throw new Error("unexpected_generate_data_key_response");
  }
  try {
    if (response.Plaintext.length !== 32) {
      throw new Error("invalid_data_key_size");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", response.Plaintext, iv, {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      v: 1,
      kind: "stored-secret",
      kms: {
        keyId: keyArn,
        encryptedDataKey: Buffer.from(response.CiphertextBlob).toString(
          "base64",
        ),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    };
  } finally {
    response.Plaintext.fill(0);
  }
}

export async function rewrap(
  kms: KMSClient,
  envelope: Envelope,
  source: string,
  target: string,
): Promise<Envelope> {
  if (resolvedKey(envelope.kms.keyId, source, target) !== source) {
    return { ...envelope, kms: { ...envelope.kms, keyId: target } };
  }
  const response = await kms.send(
    new ReEncryptCommand({
      SourceKeyId: source,
      DestinationKeyId: target,
      CiphertextBlob: Buffer.from(
        envelope.kms.encryptedDataKey ?? envelope.kms.ciphertext,
        "base64",
      ),
      SourceEncryptionContext: encryptionContext,
      DestinationEncryptionContext: encryptionContext,
    }),
  );
  if (
    !response.CiphertextBlob ||
    response.SourceKeyId !== source ||
    response.KeyId !== target
  ) {
    throw new Error("unexpected_reencrypt_response");
  }
  const ciphertext = Buffer.from(response.CiphertextBlob).toString("base64");
  return {
    ...envelope,
    kms: {
      ...envelope.kms,
      keyId: target,
      ...(envelope.kms.encryptedDataKey
        ? { encryptedDataKey: ciphertext }
        : { ciphertext }),
    },
  };
}
