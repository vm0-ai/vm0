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

interface FakeKmsDecryptContext {
  readonly command: DecryptCommand;
  readonly inFlightDecrypts: number;
}

interface FakeKmsClientOptions {
  readonly onDecrypt?: (context: FakeKmsDecryptContext) => void | Promise<void>;
}

export function fakeKmsClient(options: FakeKmsClientOptions = {}): {
  readonly calls: readonly MockKmsCommand[];
  readonly client: SecretKmsClient;
  readonly getMaxInFlightDecrypts: () => number;
} {
  const calls: MockKmsCommand[] = [];
  let inFlightDecrypts = 0;
  let maxInFlightDecrypts = 0;

  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  async function send(command: MockKmsCommand): Promise<MockKmsResponse> {
    calls.push(command);

    if (command instanceof GenerateDataKeyCommand) {
      return {
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: dataKey,
      };
    }

    inFlightDecrypts += 1;
    maxInFlightDecrypts = Math.max(maxInFlightDecrypts, inFlightDecrypts);
    await Promise.resolve(
      options.onDecrypt?.({ command, inFlightDecrypts }),
    ).finally(() => {
      inFlightDecrypts -= 1;
    });
    return { $metadata: {}, Plaintext: dataKey };
  }

  return {
    calls,
    client: { send },
    getMaxInFlightDecrypts: () => {
      return maxInFlightDecrypts;
    },
  };
}
