import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  EncryptCommand,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";

import { clearMockedEnv, mockEnv } from "../../../lib/env";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
  encryptPersistentSecretsMap,
  decryptStoredSecretValue,
  encryptSecretValue,
  encryptStoredSecretValue,
  encryptStoredSecretsMap,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  STORED_SECRET_ENVELOPE_PREFIX,
  type SecretKmsClient,
} from "../crypto.utils";

type MockKmsCommand = GenerateDataKeyCommand | DecryptCommand;
type MockKmsResponse = GenerateDataKeyCommandOutput | DecryptCommandOutput;

const DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function createFakeKmsClient(): {
  readonly calls: readonly MockKmsCommand[];
  readonly client: SecretKmsClient;
} {
  const calls: MockKmsCommand[] = [];

  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(command: MockKmsCommand): Promise<MockKmsResponse> {
    calls.push(command);

    if (command instanceof GenerateDataKeyCommand) {
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: DATA_KEY,
      });
    }

    if (command instanceof DecryptCommand) {
      if (!command.input.CiphertextBlob) {
        throw new Error("DecryptCommand must include CiphertextBlob");
      }
      const encoded = Buffer.from(command.input.CiphertextBlob).toString(
        "utf8",
      );
      if (encoded.startsWith("encrypted-data-key:")) {
        return Promise.resolve({
          $metadata: {},
          Plaintext: DATA_KEY,
        });
      }

      return Promise.resolve({
        $metadata: {},
        Plaintext: Buffer.from(encoded.slice("kms:".length), "utf8"),
      });
    }

    throw new Error("Unexpected KMS command");
  }

  return { calls, client: { send } };
}

type FakeKmsClient = ReturnType<typeof createFakeKmsClient>;

type TestStoredSecretEnvelope = {
  readonly v?: unknown;
  readonly kind?: unknown;
  readonly kms?: unknown;
  readonly legacy?: unknown;
};

function decodeTestStoredSecretEnvelope(
  encrypted: string,
): TestStoredSecretEnvelope {
  expect(encrypted.startsWith(STORED_SECRET_ENVELOPE_PREFIX)).toBeTruthy();
  const payload = encrypted.slice(STORED_SECRET_ENVELOPE_PREFIX.length);
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as TestStoredSecretEnvelope;
}

function expectKmsOnlyEnvelope(encrypted: string): void {
  const envelope = decodeTestStoredSecretEnvelope(encrypted);
  expect(envelope).toMatchObject({
    v: 1,
    kind: "stored-secret",
    kms: expect.objectContaining({
      keyId: "alias/vm0-secrets",
      encryptedDataKey: expect.any(String),
      iv: expect.any(String),
      authTag: expect.any(String),
      ciphertext: expect.any(String),
    }),
  });
  expect(envelope).not.toHaveProperty("legacy");
}

function directKmsEnvelope(plaintext: string): string {
  return `${STORED_SECRET_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "stored-secret",
      kms: {
        keyId: "alias/vm0-secrets",
        ciphertext: Buffer.from(`kms:${plaintext}`, "utf8").toString("base64"),
      },
    }),
    "utf8",
  ).toString("base64url")}`;
}

function legacyBearingKmsEnvelope(plaintext: string): string {
  return `${STORED_SECRET_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "stored-secret",
      legacy: encryptSecretValue(plaintext),
      kms: {
        keyId: "alias/vm0-secrets",
        ciphertext: Buffer.from(`kms:${plaintext}`, "utf8").toString("base64"),
      },
    }),
    "utf8",
  ).toString("base64url")}`;
}

describe("stored secret encryption", () => {
  let fakeKmsClient: FakeKmsClient;

  beforeEach(() => {
    fakeKmsClient = createFakeKmsClient();
    setSecretKmsClientForTests(fakeKmsClient.client);
  });

  afterEach(() => {
    clearMockedEnv();
    resetSecretKmsClientForTests();
  });

  it("requires KMS configuration when writing stored secrets", async () => {
    clearMockedEnv();

    await expect(encryptStoredSecretValue("secret-value")).rejects.toThrow(
      "SECRETS_KMS_KEY_ID is required for KMS secret encryption",
    );
    expect(fakeKmsClient.calls).toHaveLength(0);
  });

  it("writes and reads KMS-only material by default when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptStoredSecretValue("secret-value");

    expectKmsOnlyEnvelope(encrypted);

    await expect(decryptStoredSecretValue(encrypted)).resolves.toBe(
      "secret-value",
    );
    expect(fakeKmsClient.calls).toHaveLength(2);
    expect(fakeKmsClient.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(fakeKmsClient.calls[1]).toBeInstanceOf(DecryptCommand);
  });

  it("rejects legacy-only stored ciphertext by default", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = encryptSecretValue("secret-value");

    await expect(decryptStoredSecretValue(encrypted)).rejects.toThrow(
      "Stored secret ciphertext does not include KMS data",
    );
  });

  it("encrypts large stored secrets with data key envelope encryption", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const secret = "x".repeat(5000);
    const encrypted = await encryptStoredSecretValue(secret);

    expect(fakeKmsClient.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(fakeKmsClient.calls).not.toContainEqual(expect.any(EncryptCommand));
    await expect(decryptStoredSecretValue(encrypted)).resolves.toBe(secret);
  });

  it("can read direct KMS ciphertext envelopes for compatibility", async () => {
    await expect(
      decryptStoredSecretValue(directKmsEnvelope("secret-value")),
    ).resolves.toBe("secret-value");
  });

  it("reads KMS material from legacy-bearing stored secret envelopes", async () => {
    await expect(
      decryptStoredSecretValue(legacyBearingKmsEnvelope("secret-value")),
    ).resolves.toBe("secret-value");
  });

  it("writes stored secrets maps as KMS-only when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptStoredSecretsMap({ API_KEY: "secret" });

    expect(encrypted).not.toBeNull();
    if (!encrypted) {
      throw new Error("Expected encrypted secrets map");
    }
    expectKmsOnlyEnvelope(encrypted);
  });

  it("requires KMS configuration when writing persistent secrets", async () => {
    clearMockedEnv();

    await expect(encryptPersistentSecretValue("bot-token", {})).rejects.toThrow(
      "SECRETS_KMS_KEY_ID is required for KMS secret encryption",
    );
    expect(fakeKmsClient.calls).toHaveLength(0);
  });

  it("writes persistent secrets as KMS-only when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptPersistentSecretValue("bot-token", {});

    expectKmsOnlyEnvelope(encrypted);
    await expect(decryptPersistentSecretValue(encrypted, {})).resolves.toBe(
      "bot-token",
    );
  });

  it("writes persistent secret maps as KMS-only when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptPersistentSecretsMap(
      { API_KEY: "secret" },
      {},
    );

    expect(encrypted).not.toBeNull();
    if (!encrypted) {
      throw new Error("Expected encrypted persistent secrets map");
    }
    expectKmsOnlyEnvelope(encrypted);
  });
});
