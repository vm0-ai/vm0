import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
  KMSClient,
} from "@aws-sdk/client-kms";

import { singleton, testOverride } from "./singleton";

export interface SecretKmsClient {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

const secretKmsClient = singleton((): SecretKmsClient => {
  const client = new KMSClient({});
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      return client.send(command);
    }
    return client.send(command);
  }

  return { send };
});

const {
  get: getSecretKmsClientOverride,
  set: setSecretKmsClientOverride,
  clear: clearSecretKmsClientOverride,
} = testOverride<SecretKmsClient | null>(() => {
  return null;
});

export function getSecretKmsClient(): SecretKmsClient {
  return getSecretKmsClientOverride() ?? secretKmsClient();
}

export function resetSecretKmsClientForTests(): void {
  clearSecretKmsClientOverride();
  secretKmsClient.reset();
}

export function setSecretKmsClientForTests(client: SecretKmsClient): void {
  setSecretKmsClientOverride(client);
}
