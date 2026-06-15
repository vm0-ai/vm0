import { resetApiTestMocks } from "./mocks";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { clearMockedEnv, mockEnv } from "../lib/env";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../signals/services/crypto.utils";
import { clearAllDetached } from "../signals/utils";

type MockKmsCommand = GenerateDataKeyCommand | DecryptCommand;
type MockKmsResponse = GenerateDataKeyCommandOutput | DecryptCommandOutput;

const testDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function createApiTestKmsClient(): SecretKmsClient {
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
        Plaintext: testDataKey,
      });
    }

    return Promise.resolve({ $metadata: {}, Plaintext: testDataKey });
  }

  return { send };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets-test");
  setSecretKmsClientForTests(createApiTestKmsClient());
});

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
  resetSecretKmsClientForTests();
  clearMockedEnv();
  resetApiTestMocks();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
