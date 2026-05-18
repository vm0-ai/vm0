import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  EncryptCommand,
  type EncryptCommandOutput,
} from "@aws-sdk/client-kms";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { clearMockedEnv, mockEnv } from "../../../lib/env";
import {
  decryptStoredSecretValue,
  decryptStoredSecretValueWithMode,
  encryptSecretValue,
  encryptStoredSecretValue,
  encryptStoredSecretValueWithMode,
  encryptStoredSecretsMap,
  inspectStoredSecretCiphertext,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../crypto.utils";

type MockKmsCommand = EncryptCommand | DecryptCommand;
type MockKmsResponse = EncryptCommandOutput | DecryptCommandOutput;

function createFakeKmsClient(): {
  readonly calls: readonly MockKmsCommand[];
  readonly client: SecretKmsClient;
} {
  const calls: MockKmsCommand[] = [];

  function send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(command: MockKmsCommand): Promise<MockKmsResponse> {
    calls.push(command);

    if (command instanceof EncryptCommand) {
      if (!command.input.Plaintext) {
        throw new Error("EncryptCommand must include Plaintext");
      }
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `kms:${Buffer.from(command.input.Plaintext).toString("utf8")}`,
          "utf8",
        ),
      });
    }

    if (command instanceof DecryptCommand) {
      if (!command.input.CiphertextBlob) {
        throw new Error("DecryptCommand must include CiphertextBlob");
      }
      const encoded = Buffer.from(command.input.CiphertextBlob).toString(
        "utf8",
      );
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

  it("dual-writes legacy AES and AWS KMS material when KMS is configured", async () => {
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

    await expect(
      decryptStoredSecretValue(encrypted, {
        overrides: { [FeatureSwitchKey.StoredSecretKmsRead]: true },
      }),
    ).resolves.toBe("secret-value");
    expect(fakeKmsClient.calls).toHaveLength(2);
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

  it("can reject legacy-only ciphertext when KMS-only reads are enabled", async () => {
    const encrypted = encryptSecretValue("secret-value");

    await expect(
      decryptStoredSecretValueWithMode(encrypted, "kms-only"),
    ).rejects.toThrow("Stored secret ciphertext does not include KMS data");
  });

  it("dual-writes stored secrets maps when KMS is configured", async () => {
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
});
