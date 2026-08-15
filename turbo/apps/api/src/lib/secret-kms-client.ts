import { AsyncLocalStorage } from "node:async_hooks";

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";

import { singleton } from "./singleton";

export interface SecretKmsGenerateDataKeyRequest {
  readonly keyId: string;
  readonly encryptionContext: Readonly<Record<string, string>>;
}

export interface SecretKmsDataKey {
  readonly keyId: string;
  readonly plaintext: Uint8Array;
  readonly encryptedDataKey: Uint8Array;
}

export interface SecretKmsDecryptRequest {
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
  readonly encryptionContext: Readonly<Record<string, string>>;
}

/**
 * Narrow KMS surface. Callers never see `@aws-sdk/client-kms` types: this
 * module is the only api file that resolves them, which keeps the SDK's
 * declaration surface out of the core type-check program.
 */
export interface SecretKmsClient {
  generateDataKey(
    request: SecretKmsGenerateDataKeyRequest,
  ): Promise<SecretKmsDataKey>;
  decrypt(request: SecretKmsDecryptRequest): Promise<Uint8Array>;
}

interface ScopedSecretKmsClient {
  client: SecretKmsClient;
}

const secretKmsClient = singleton((): SecretKmsClient => {
  const client = new KMSClient({});

  return {
    async generateDataKey(
      request: SecretKmsGenerateDataKeyRequest,
    ): Promise<SecretKmsDataKey> {
      const response = await client.send(
        new GenerateDataKeyCommand({
          KeyId: request.keyId,
          KeySpec: "AES_256",
          EncryptionContext: { ...request.encryptionContext },
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

      return {
        keyId: response.KeyId ?? request.keyId,
        plaintext: response.Plaintext,
        encryptedDataKey: response.CiphertextBlob,
      };
    },

    async decrypt(request: SecretKmsDecryptRequest): Promise<Uint8Array> {
      const response = await client.send(
        new DecryptCommand({
          KeyId: request.keyId,
          CiphertextBlob: request.ciphertext,
          EncryptionContext: { ...request.encryptionContext },
        }),
      );
      if (!response.Plaintext) {
        throw new Error("AWS KMS decrypt response did not include plaintext");
      }

      return response.Plaintext;
    },
  };
});

const scopedSecretKmsClient = singleton(() => {
  return new AsyncLocalStorage<ScopedSecretKmsClient>();
});

function currentScopedSecretKmsClient(): ScopedSecretKmsClient | undefined {
  return scopedSecretKmsClient.peek()?.getStore();
}

export function getSecretKmsClient(): SecretKmsClient {
  return currentScopedSecretKmsClient()?.client ?? secretKmsClient();
}

export function setSecretKmsClientForTests(client: SecretKmsClient): void {
  const scoped = currentScopedSecretKmsClient();
  if (!scoped) {
    throw new Error("Secret KMS test client requires an active test scope");
  }
  scoped.client = client;
}

export async function withSecretKmsClientForTest<T>(
  client: SecretKmsClient,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedSecretKmsClient().run({ client }, work);
}
