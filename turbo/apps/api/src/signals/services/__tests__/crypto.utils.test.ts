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
  decryptPersistentSecretValueWithMode,
  encryptPersistentSecretValue,
  encryptPersistentSecretValueWithMode,
  encryptPersistentSecretsMap,
  decryptStoredSecretValue,
  decryptStoredSecretValueWithMode,
  encryptSecretValue,
  encryptStoredSecretValue,
  encryptStoredSecretValueWithMode,
  encryptStoredSecretsMap,
  inspectStoredSecretCiphertext,
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

  it("keeps legacy AES when KMS is not configured", async () => {
    const encrypted = await encryptStoredSecretValue("secret-value");

    expect(inspectStoredSecretCiphertext(encrypted)).toStrictEqual({
      format: "legacy",
      hasLegacy: true,
      hasKms: false,
    });
    await expect(decryptStoredSecretValue(encrypted)).resolves.toBe(
      "secret-value",
    );
    expect(fakeKmsClient.calls).toHaveLength(0);
  });

  it("dual-writes legacy AES and reads AWS KMS material by default when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptStoredSecretValue("secret-value");

    expect(inspectStoredSecretCiphertext(encrypted)).toStrictEqual({
      format: "dual",
      hasLegacy: true,
      hasKms: true,
    });

    await expect(decryptStoredSecretValue(encrypted)).resolves.toBe(
      "secret-value",
    );
    expect(fakeKmsClient.calls).toHaveLength(2);
    expect(fakeKmsClient.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(fakeKmsClient.calls[1]).toBeInstanceOf(DecryptCommand);
  });

  it("can write and strictly read KMS-only ciphertext", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptStoredSecretValueWithMode(
      "secret-value",
      "kms",
    );

    expect(inspectStoredSecretCiphertext(encrypted)).toStrictEqual({
      format: "kms",
      hasLegacy: false,
      hasKms: true,
    });
    await expect(
      decryptStoredSecretValueWithMode(encrypted, "legacy-only"),
    ).rejects.toThrow("Stored secret ciphertext does not include legacy data");
    await expect(
      decryptStoredSecretValueWithMode(encrypted, "kms-only"),
    ).resolves.toBe("secret-value");
  });

  it("encrypts large stored secrets with data key envelope encryption", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const secret = "x".repeat(5000);
    const encrypted = await encryptStoredSecretValueWithMode(secret, "kms");

    expect(fakeKmsClient.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(fakeKmsClient.calls).not.toContainEqual(expect.any(EncryptCommand));
    await expect(
      decryptStoredSecretValueWithMode(encrypted, "kms-only"),
    ).resolves.toBe(secret);
  });

  it("can read direct KMS ciphertext envelopes for compatibility", async () => {
    await expect(
      decryptStoredSecretValueWithMode(
        directKmsEnvelope("secret-value"),
        "kms-only",
      ),
    ).resolves.toBe("secret-value");
  });

  it("can reject legacy-only ciphertext when KMS-only reads are enabled", async () => {
    const encrypted = encryptSecretValue("secret-value");

    await expect(
      decryptStoredSecretValueWithMode(encrypted, "kms-only"),
    ).rejects.toThrow("Stored secret ciphertext does not include KMS data");
  });

  it("dual-writes stored secrets maps when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptStoredSecretsMap({ API_KEY: "secret" });

    expect(encrypted).not.toBeNull();
    if (!encrypted) {
      throw new Error("Expected encrypted secrets map");
    }
    expect(inspectStoredSecretCiphertext(encrypted)).toMatchObject({
      format: "dual",
    });
  });

  it("keeps persistent secrets legacy-only when KMS is not configured", async () => {
    const encrypted = await encryptPersistentSecretValue("bot-token", {});

    expect(inspectStoredSecretCiphertext(encrypted)).toStrictEqual({
      format: "legacy",
      hasLegacy: true,
      hasKms: false,
    });
    await expect(decryptPersistentSecretValue(encrypted, {})).resolves.toBe(
      "bot-token",
    );
    expect(fakeKmsClient.calls).toHaveLength(0);
  });

  it("dual-writes persistent secrets and reads KMS material when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptPersistentSecretValue("bot-token", {});

    expect(inspectStoredSecretCiphertext(encrypted)).toStrictEqual({
      format: "dual",
      hasLegacy: true,
      hasKms: true,
    });
    await expect(decryptPersistentSecretValue(encrypted, {})).resolves.toBe(
      "bot-token",
    );
  });

  it("can backfill persistent secrets to KMS-only ciphertext", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptPersistentSecretValueWithMode(
      "callback-secret",
      "kms",
    );

    expect(inspectStoredSecretCiphertext(encrypted)).toStrictEqual({
      format: "kms",
      hasLegacy: false,
      hasKms: true,
    });
    await expect(
      decryptPersistentSecretValueWithMode(encrypted, "legacy-only"),
    ).rejects.toThrow("Stored secret ciphertext does not include legacy data");
    await expect(
      decryptPersistentSecretValueWithMode(encrypted, "kms-only"),
    ).resolves.toBe("callback-secret");
  });

  it("dual-writes persistent secret maps when KMS env is set", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    const encrypted = await encryptPersistentSecretsMap(
      { API_KEY: "secret" },
      {},
    );

    expect(encrypted).not.toBeNull();
    if (!encrypted) {
      throw new Error("Expected encrypted persistent secrets map");
    }
    expect(inspectStoredSecretCiphertext(encrypted)).toMatchObject({
      format: "dual",
    });
  });
});
