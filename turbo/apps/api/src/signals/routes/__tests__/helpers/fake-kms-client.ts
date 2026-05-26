import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";

import type { SecretKmsClient } from "../../../services/crypto.utils";

type MockKmsCommand = GenerateDataKeyCommand | DecryptCommand;
type MockKmsResponse = GenerateDataKeyCommandOutput | DecryptCommandOutput;

const dataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

export function fakeKmsClient(): {
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
        Plaintext: dataKey,
      });
    }

    return Promise.resolve({ $metadata: {}, Plaintext: dataKey });
  }

  return { calls, client: { send } };
}
