import { afterEach, describe, expect, it } from "vitest";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";

import { clearMockedEnv, mockEnv } from "../../lib/env";
import {
  encryptSecretValue,
  encryptStoredSecretValueWithMode,
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../signals/services/crypto.utils";
import {
  filterStoredSecretMigrationRows,
  type EncryptedRow,
} from "../backfill-secret-kms-encryption";

type MockKmsCommand = GenerateDataKeyCommand | DecryptCommand;
type MockKmsResponse = GenerateDataKeyCommandOutput | DecryptCommandOutput;

const DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function createFakeKmsClient(): SecretKmsClient {
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(command: MockKmsCommand): Promise<MockKmsResponse> {
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

    return Promise.resolve({
      $metadata: {},
      Plaintext: DATA_KEY,
    });
  }

  return { send };
}

function ids(rows: readonly EncryptedRow[]): readonly string[] {
  return rows.map((row) => {
    return row.id;
  });
}

describe("stored secret KMS backfill", () => {
  afterEach(() => {
    clearMockedEnv();
    resetSecretKmsClientForTests();
  });

  it("selects only legacy rows when writing dual envelopes", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    setSecretKmsClientForTests(createFakeKmsClient());
    const legacy = encryptSecretValue("legacy");
    const dual = await encryptStoredSecretValueWithMode("dual", "dual");
    const kms = await encryptStoredSecretValueWithMode("kms", "kms");

    expect(
      ids(
        filterStoredSecretMigrationRows(
          [
            { id: "legacy", encrypted: legacy },
            { id: "dual", encrypted: dual },
            { id: "kms", encrypted: kms },
            { id: "empty", encrypted: null },
          ],
          "dual",
        ),
      ),
    ).toStrictEqual(["legacy"]);
  });

  it("selects legacy and dual rows when writing KMS-only envelopes", async () => {
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    setSecretKmsClientForTests(createFakeKmsClient());
    const legacy = encryptSecretValue("legacy");
    const dual = await encryptStoredSecretValueWithMode("dual", "dual");
    const kms = await encryptStoredSecretValueWithMode("kms", "kms");

    expect(
      ids(
        filterStoredSecretMigrationRows(
          [
            { id: "legacy", encrypted: legacy },
            { id: "dual", encrypted: dual },
            { id: "kms", encrypted: kms },
            { id: "empty", encrypted: null },
          ],
          "kms",
        ),
      ),
    ).toStrictEqual(["legacy", "dual"]);
  });
});
