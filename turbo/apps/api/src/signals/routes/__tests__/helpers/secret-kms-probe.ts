import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";

import {
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../../../lib/secret-kms-client";

const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

interface SecretKmsProbe {
  readonly generateDataKeyCalls: number;
  readonly decryptCalls: number;
}

export function generateDataKeyOutput(
  command: GenerateDataKeyCommand,
): GenerateDataKeyCommandOutput {
  return {
    $metadata: {},
    KeyId: command.input.KeyId,
    CiphertextBlob: Buffer.from(
      `encrypted-data-key:${command.input.KeyId}`,
      "utf8",
    ),
    Plaintext: TEST_DATA_KEY,
  };
}

function decryptDataKeyOutput(): DecryptCommandOutput {
  return { $metadata: {}, Plaintext: TEST_DATA_KEY };
}

export function useSecretKmsProbe(
  overrideGenerateDataKey?: (
    command: GenerateDataKeyCommand,
    callNumber: number,
  ) => Promise<GenerateDataKeyCommandOutput> | undefined,
  overrideDecrypt?: (
    command: DecryptCommand,
    callNumber: number,
  ) => Promise<DecryptCommandOutput> | undefined,
): SecretKmsProbe {
  let generateDataKeyCalls = 0;
  let decryptCalls = 0;

  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      generateDataKeyCalls += 1;
      const overridden = overrideGenerateDataKey?.(
        command,
        generateDataKeyCalls,
      );
      return overridden ?? Promise.resolve(generateDataKeyOutput(command));
    }

    decryptCalls += 1;
    const overridden = overrideDecrypt?.(command, decryptCalls);
    return overridden ?? Promise.resolve(decryptDataKeyOutput());
  }

  const client: SecretKmsClient = { send };
  setSecretKmsClientForTests(client);
  return {
    get generateDataKeyCalls() {
      return generateDataKeyCalls;
    },
    get decryptCalls() {
      return decryptCalls;
    },
  };
}
